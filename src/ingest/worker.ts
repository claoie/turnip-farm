// The ingest worker (BACKEND_DESIGN.md §1.2.10): turns a staged upload into
// the canonical stored blob.
//
// Pipeline per staged source:
//   1. Fetch the staged `.tkp1.gz`; re-verify its transport checksum when
//      the object carries one (R2 enforced a checksum at PUT time).
//   2. Gunzip, decode fail-closed, resample to canonical 10 Hz
//      (POSE_FORMAT.md §6; gaps break interpolation).
//   3. Gzip deterministically (mtime = 0), PUT the canonical bytes to
//      `r2_key` — the S3 PUT is atomic, so a failed PUT leaves no partial
//      blob — then set `sources.sha256` to the digest of the stored bytes.
//   4. Delete the staged object (best-effort; a failed delete is retried by
//      the next poll — re-ingest is byte-identical, hence idempotent).
//
// Failure promise: a failed ingest leaves `sources.sha256`
// NULL (untouched on re-ingest) and stores no partial blob at `r2_key`.
// The client keeps polling `blob_present`; clip submission answers
// `422 BLOB_MISSING` until ingest completes. A digest of the as-sent
// bytes is never stored.

import type { SQL } from "bun";
import { BlobTooLargeError } from "../r2/client";
import { type BlobStore } from "./store";
import {
  decodeTkp1,
  encodeTkp1,
  gunzipStaged,
  gzipCanonical,
  resampleToCanonical10Hz,
  Tkp1Error,
} from "./tkp1";

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
    // updated_at is set explicitly — no triggers (§1.2.11).
    async setSha256(id, sha256) {
      // A new blob means new segments (§1.2.24).
      const result = await sql`
        UPDATE sources SET sha256 = ${sha256}, updated_at = now(), segments_dirty_at = now()
        WHERE id = ${id}`;
      if (result.count !== 1) throw new IngestError("source-vanished", id);
    },
  };
}

export interface IngestDeps {
  store: BlobStore;
  sources: SourceStore;
}

export type IngestResult = { status: "ingested"; sha256: string } | { status: "nothing-staged" };

export async function ingestStagedSource(deps: IngestDeps, sourceId: string): Promise<IngestResult> {
  if (!/^[0-9a-f]{64}$/.test(sourceId)) throw new IngestError("bad-source-id", sourceId);
  const row = await deps.sources.get(sourceId);
  if (!row) throw new IngestError("unknown-source", sourceId);

  let staged;
  try {
    staged = await deps.store.get(stagingKeyFor(sourceId));
  } catch (err) {
    // An oversized staged upload is a failed ingest, not a crash: keep it
    // in the worker's failure contract so pollStagingOnce records it and
    // moves on to the next source instead of stalling the poll.
    if (err instanceof BlobTooLargeError) {
      throw new IngestError("staged-too-large", `${stagingKeyFor(sourceId)} exceeds ${err.maxBytes} bytes`);
    }
    throw err;
  }
  if (staged === null) return { status: "nothing-staged" };

  if (staged.checksumSha256 !== null) {
    const actual = Buffer.from(await crypto.subtle.digest("SHA-256", staged.bytes)).toString("base64");
    if (actual !== staged.checksumSha256) {
      throw new IngestError("staged-checksum-mismatch", `object carries ${staged.checksumSha256}`);
    }
  }

  let canonical: Uint8Array<ArrayBuffer>;
  try {
    canonical = gzipCanonical(encodeTkp1(resampleToCanonical10Hz(decodeTkp1(await gunzipStaged(staged.bytes)))));
  } catch (err) {
    if (err instanceof Tkp1Error) throw new IngestError("invalid-staged-blob", err.reason);
    throw err;
  }

  // The digest is over the stored bytes: exactly the payload of the PUT below.
  const digest = new Bun.CryptoHasher("sha256").update(canonical).digest("hex");

  await deps.store.put(row.r2_key, canonical, "application/gzip");
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
  const tick = async (): Promise<void> => {
    try {
      const s = await pollStagingOnce(deps);
      if (s.checked > 0) {
        console.log(`ingest poll: ${s.ingested} ingested, ${s.failed} failed of ${s.checked} staged`);
      }
      for (const f of s.failures) console.warn(`ingest failed for ${f.sourceId}: ${f.error}`);
    } catch (err) {
      console.error("ingest poll failed:", err);
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
