// The ingest worker (BACKEND_DESIGN.md §1.2.10): turns a staged upload into
// the canonical stored blob.
//
// Pipeline per staged source, streamed so no blob is ever held whole:
//   1. Read the staged `.tkp1.gz`, gunzip, decode fail-closed, resample to
//      canonical 10 Hz (POSE_FORMAT.md §6; gaps break interpolation) and
//      gzip deterministically (mtime = 0), keeping only the canonical
//      blob's size and digest; re-verify the staged transport checksum when
//      the object carries one (R2 enforced a checksum at PUT time).
//   2. Read and transform the staged object again, streaming the canonical
//      bytes into a PUT to `r2_key` that declares that size and digest, so
//      R2 refuses any byte that differs. The S3 PUT is atomic, so a failed
//      PUT leaves no partial blob. Then set `sources.sha256` to the digest.
//   3. Delete the staged object (best-effort; a failed delete is retried by
//      the next poll — re-ingest is byte-identical, hence idempotent).
//
// Failure promise: a failed ingest leaves `sources.sha256`
// NULL (untouched on re-ingest) and stores no partial blob at `r2_key`.
// The client keeps polling `blob_present`; clip submission answers
// `422 BLOB_MISSING` until ingest completes. A digest of the as-sent
// bytes is never stored.

import type { SQL } from "bun";
import { heavyJobs } from "../heavy-jobs";
import { BlobTooLargeError, MAX_CANONICAL_BLOB_BYTES } from "../r2/client";
import { type BlobStore, type StoredObject } from "./store";
import { canonicalizeStaged, Tkp1Error } from "./tkp1";

// Key conventions: r2_key is pinned by the design doc (§1.2.9); the staging
// key is the worker's own convention — deterministic per source, mirroring
// r2_key, so re-contribution overwrites the staged object like it
// overwrites the canonical one.
export const STAGING_PREFIX = "staging/";
export const stagingKeyFor = (sourceId: string): string => `${STAGING_PREFIX}${sourceId}.tkp1.gz`;
export const canonicalKeyFor = (sourceId: string): string => `poses/${sourceId}.tkp1.gz`;

export class IngestError extends Error {
  constructor(
    readonly reason: string,
    detail?: string,
  ) {
    super(`ingest failed [${reason}]${detail ? `: ${detail}` : ""}`);
    this.name = "IngestError";
  }
}

export interface SourceRow {
  id: string;
  r2_key: string;
}

// The worker's entire database surface: look the source up, record the
// digest. Tests substitute a fake; production uses Postgres.
export interface SourceStore {
  get(id: string): Promise<SourceRow | null>;
  setSha256(id: string, sha256Hex: string): Promise<void>;
}

export function createPostgresSourceStore(sql: SQL): SourceStore {
  return {
    async get(id) {
      const rows = await sql`SELECT id, r2_key FROM sources WHERE id = ${id}`;
      return (rows[0] as SourceRow | undefined) ?? null;
    },
    // Set ONLY on successful ingest, and only here: the registration
    // upsert deliberately never overwrites sha256 (§1.2.10), and
    // updated_at is set explicitly — no triggers (§1.2.11). ingested_at
    // records this ingest, so a re-contribution moves it.
    async setSha256(id, sha256) {
      const result = await sql`
        UPDATE sources SET sha256 = ${sha256}, ingested_at = now(), updated_at = now() WHERE id = ${id}`;
      if (result.count !== 1) throw new IngestError("source-vanished", id);
    },
  };
}

export interface IngestDeps {
  store: BlobStore;
  sources: SourceStore;
  /** Largest canonical blob stored, MAX_CANONICAL_BLOB_BYTES; tests lower it to cross it cheaply. */
  maxCanonicalBytes?: number;
}

export type IngestResult = { status: "ingested"; sha256: string } | { status: "nothing-staged" };

export function ingestStagedSource(deps: IngestDeps, sourceId: string): Promise<IngestResult> {
  return heavyJobs.use(() => ingest(deps, sourceId));
}

async function ingest(deps: IngestDeps, sourceId: string): Promise<IngestResult> {
  if (!/^[0-9a-f]{64}$/.test(sourceId)) throw new IngestError("bad-source-id", sourceId);
  const row = await deps.sources.get(sourceId);
  if (!row) throw new IngestError("unknown-source", sourceId);

  const staged = await readStaged(deps.store, sourceId);
  if (staged === null) return { status: "nothing-staged" };
  const maxCanonicalBytes = deps.maxCanonicalBytes ?? MAX_CANONICAL_BLOB_BYTES;
  const stagedHasher = new Bun.CryptoHasher("sha256");
  const canonicalHasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  try {
    const hashed = staged.body.pipeThrough(
      new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
        transform(chunk, controller) {
          stagedHasher.update(chunk);
          controller.enqueue(chunk);
        },
      }),
    );
    for await (const chunk of canonicalizeStaged(hashed)) {
      size += chunk.byteLength;
      if (size > maxCanonicalBytes) {
        throw new IngestError("canonical-too-large", `exceeds ${maxCanonicalBytes} bytes`);
      }
      canonicalHasher.update(chunk);
    }
  } catch (err) {
    throw ingestFailure(err, sourceId);
  }
  if (staged.checksumSha256 !== null && stagedHasher.digest("base64") !== staged.checksumSha256) {
    throw new IngestError("staged-checksum-mismatch", `object carries ${staged.checksumSha256}`);
  }
  const sha256 = canonicalHasher.digest();
  const digest = sha256.toString("hex");

  const again = await readStaged(deps.store, sourceId);
  if (again === null) return { status: "nothing-staged" };
  try {
    await deps.store.put(
      row.r2_key,
      { body: canonicalizeStaged(again.body), size, sha256: new Uint8Array(sha256) },
      "application/gzip",
    );
  } catch (err) {
    throw ingestFailure(err, sourceId);
  }
  await deps.sources.setSha256(sourceId, digest);

  try {
    await deps.store.delete(stagingKeyFor(sourceId));
  } catch (err) {
    // The blob is stored and sha256 committed; the staged object will be
    // picked up and deleted by the next poll.
    console.warn(`ingest: staged delete failed for ${sourceId}, retrying next poll:`, err);
  }
  return { status: "ingested", sha256: digest };
}

async function readStaged(store: BlobStore, sourceId: string): Promise<StoredObject | null> {
  try {
    return await store.get(stagingKeyFor(sourceId));
  } catch (err) {
    throw ingestFailure(err, sourceId);
  }
}

// An oversized or invalid staged upload is a failed ingest, not a crash:
// keep it in the worker's failure contract so pollStagingOnce records it
// and moves on to the next source instead of stalling the poll.
function ingestFailure(err: unknown, sourceId: string): unknown {
  if (err instanceof BlobTooLargeError) {
    return new IngestError("staged-too-large", `${stagingKeyFor(sourceId)} exceeds ${err.maxBytes} bytes`);
  }
  if (err instanceof Tkp1Error) return new IngestError("invalid-staged-blob", err.reason);
  return err;
}

export interface PollSummary {
  checked: number;
  ingested: number;
  failed: number;
  failures: { sourceId: string; error: string }[];
}

// One poll pass over the staging prefix. Per-source failures are collected,
// never thrown: one poisoned upload must not stall the rest. The listing
// is consumed one page at a time (listPages): a page is ingested before
// the next is fetched, so memory per poll is bounded by one page, not
// by the whole prefix.
export async function pollStagingOnce(deps: IngestDeps): Promise<PollSummary> {
  const summary: PollSummary = { checked: 0, ingested: 0, failed: 0, failures: [] };
  for await (const keys of deps.store.listPages(STAGING_PREFIX)) {
    for (const key of keys) {
      const m = /^staging\/([0-9a-f]{64})\.tkp1\.gz$/.exec(key);
      if (!m) continue; // not a staged upload — leave it alone
      const sourceId = m[1]!;
      summary.checked++;
      try {
        const result = await ingestStagedSource(deps, sourceId);
        if (result.status === "ingested") summary.ingested++;
      } catch (err) {
        summary.failed++;
        summary.failures.push({ sourceId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return summary;
}

// The "or poll" trigger: runs pollStagingOnce immediately and
// then every intervalMs. Returns a stop function for tests and shutdown.
export function startIngestPoller(deps: IngestDeps, intervalMs: number): () => void {
  // A tick that outlasts the interval is not overlapped: one ingest at a time.
  let polling = false;
  const tick = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const s = await pollStagingOnce(deps);
      if (s.checked > 0) {
        console.log(`ingest poll: ${s.ingested} ingested, ${s.failed} failed of ${s.checked} staged`);
      }
      for (const f of s.failures) console.warn(`ingest failed for ${f.sourceId}: ${f.error}`);
    } catch (err) {
      console.error("ingest poll failed:", err);
    } finally {
      polling = false;
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
