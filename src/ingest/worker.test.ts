// Acceptance tests for the ingest worker: the staged
// upload becomes the canonical blob, or the ingest fails cleanly.
import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { BlobTooLargeError } from "../r2/client";
import { TEST_DATABASE_URL, inRollback } from "../../db/testing";
import { type BlobStore, type BlobUpload, type StoredObject } from "./store";
import { decodeTkp1, encodeTkp1 } from "./tkp1";
import {
  canonicalKeyFor,
  createPostgresSourceStore,
  IngestError,
  ingestStagedSource,
  pollStagingOnce,
  stagingKeyFor,
  startIngestPoller,
  type IngestDeps,
  type SourceRow,
  type SourceStore,
} from "./worker";

// Streams objects in small chunks, and checks an upload's declared size
// and digest the way R2 does before storing it.
class InMemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; checksumSha256: string | null }>();
  gets = 0;
  async get(key: string): Promise<StoredObject | null> {
    this.gets++;
    const o = this.objects.get(key);
    if (!o) return null;
    const bytes = o.bytes.slice();
    let offset = 0;
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + 100));
        offset += 100;
      },
    });
    return { body, checksumSha256: o.checksumSha256 };
  }
  async put(key: string, upload: BlobUpload): Promise<void> {
    const bytes = new Uint8Array(await new Response(upload.body).arrayBuffer());
    if (bytes.length !== upload.size) throw new Error(`size ${bytes.length} != declared ${upload.size}`);
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest();
    if (!digest.equals(Buffer.from(upload.sha256))) throw new Error("checksum mismatch");
    this.objects.set(key, { bytes, checksumSha256: digest.toString("base64") });
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async *listPages(prefix: string): AsyncIterable<string[]> {
    // Two keys per page: small enough that the streaming probe below can
    // tell page-at-a-time processing apart from whole-listing accumulation.
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    for (let i = 0; i < keys.length; i += 2) yield keys.slice(i, i + 2);
  }
}

class FakeSourceStore implements SourceStore {
  readonly rows = new Map<string, { r2_key: string; sha256: string | null }>();
  add(id: string): void {
    this.rows.set(id, { r2_key: canonicalKeyFor(id), sha256: null });
  }
  async get(id: string): Promise<SourceRow | null> {
    const r = this.rows.get(id);
    return r ? { id, r2_key: r.r2_key } : null;
  }
  async setSha256(id: string, sha256: string): Promise<void> {
    const r = this.rows.get(id);
    if (!r) throw new Error("no such source");
    r.sha256 = sha256;
  }
}

function makeBlob(n: number, rateHz: number, gapAt: number | null = null): Uint8Array<ArrayBuffer> {
  const frames: Uint8Array<ArrayBuffer>[] = [];
  for (let i = 0; i < n; i++) {
    const f = new Uint8Array(204);
    const v = new DataView(f.buffer);
    for (let k = 0; k < 17; k++) {
      const gap = gapAt === i;
      v.setFloat32(k * 12, gap ? 0 : i * 0.1 + k * 0.01, true);
      v.setFloat32(k * 12 + 4, gap ? 0 : 0.5, true);
      v.setFloat32(k * 12 + 8, gap ? 0 : 0.9, true);
    }
    frames.push(f);
  }
  return encodeTkp1({ frameCount: n, sourceSampleRateHz: rateHz, frames });
}

function stage(store: InMemoryBlobStore, sourceId: string, blob: Uint8Array<ArrayBuffer>, checksum: boolean): void {
  const gzipped = Bun.gzipSync(blob);
  store.objects.set(stagingKeyFor(sourceId), {
    bytes: gzipped,
    checksumSha256: checksum
      ? Buffer.from(new Bun.CryptoHasher("sha256").update(gzipped).digest()).toString("base64")
      : null,
  });
}

function deps(): { store: InMemoryBlobStore; sources: FakeSourceStore; d: IngestDeps } {
  const store = new InMemoryBlobStore();
  const sources = new FakeSourceStore();
  return { store, sources, d: { store, sources } };
}

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function storedBytes(store: InMemoryBlobStore, key: string): Uint8Array<ArrayBuffer> | null {
  return store.objects.get(key)?.bytes ?? null;
}

describe("ingestStagedSource", () => {
  test("30 Hz upload → 10 Hz canonical blob, digest matches, staged deleted", async () => {
    const { store, sources, d } = deps();
    sources.add(ID_A);
    stage(store, ID_A, makeBlob(31, 30), true);

    const result = await ingestStagedSource(d, ID_A);
    expect(result.status).toBe("ingested");

    const stored = storedBytes(store, canonicalKeyFor(ID_A));
    expect(stored).not.toBeNull();
    const decoded = decodeTkp1(Bun.gunzipSync(stored!));
    expect(decoded.frameCount).toBe(11); // floor(30/30*10)+1
    const view = new DataView(Bun.gunzipSync(stored!).buffer);
    expect(view.getFloat32(12, true)).toBe(10);

    // sources.sha256 is the digest of the stored bytes.
    expect(result).toEqual({ status: "ingested", sha256: sha256Hex(stored!) });
    expect(sources.rows.get(ID_A)!.sha256).toBe(sha256Hex(stored!));

    // The staged object is gone.
    expect(storedBytes(store, stagingKeyFor(ID_A))).toBeNull();
  });

  test("10 Hz upload → canonical passthrough, digest matches", async () => {
    const { store, sources, d } = deps();
    sources.add(ID_A);
    const blob = makeBlob(5, 10);
    stage(store, ID_A, blob, true);

    const result = await ingestStagedSource(d, ID_A);
    expect(result.status).toBe("ingested");
    const stored = storedBytes(store, canonicalKeyFor(ID_A));
    expect(stored).not.toBeNull();
    // Passthrough: the stored blob holds the upload, byte-identical.
    expect(Bun.gunzipSync(stored!)).toEqual(blob);
    expect(sources.rows.get(ID_A)!.sha256).toBe(sha256Hex(stored!));
  });

  test("failed ingest → sha256 stays NULL, no partial blob at r2_key", async () => {
    const { store, sources, d } = deps();
    sources.add(ID_A);
    store.objects.set(stagingKeyFor(ID_A), {
      bytes: new TextEncoder().encode("not a gzip blob"),
      checksumSha256: null,
    });

    await expect(ingestStagedSource(d, ID_A)).rejects.toThrow(IngestError);
    expect(sources.rows.get(ID_A)!.sha256).toBeNull();
    expect(storedBytes(store, canonicalKeyFor(ID_A))).toBeNull();
    // The poisoned staged object is left for inspection / retry.
    expect(storedBytes(store, stagingKeyFor(ID_A))).not.toBeNull();
  });

  test("failed R2 PUT → sha256 stays NULL, no partial blob at r2_key", async () => {
    // Guards the ordering contract: the canonical PUT must commit before
    // sources.sha256 does. If a future edit commits the digest first, this
    // test fails on the sha256 assertion below.
    class FailingPutStore extends InMemoryBlobStore {
      override async put(_key: string, _upload: BlobUpload): Promise<void> {
        throw new Error("r2 unavailable");
      }
    }
    const store = new FailingPutStore();
    const sources = new FakeSourceStore();
    const d: IngestDeps = { store, sources };
    sources.add(ID_A);
    stage(store, ID_A, makeBlob(5, 10), true);

    await expect(ingestStagedSource(d, ID_A)).rejects.toThrow(/r2 unavailable/);
    expect(sources.rows.get(ID_A)!.sha256).toBeNull();
    expect(storedBytes(store, canonicalKeyFor(ID_A))).toBeNull();
    // The staged object is left for retry on the next poll.
    expect(storedBytes(store, stagingKeyFor(ID_A))).not.toBeNull();
  });

  test("staged checksum mismatch → ingest fails, sha256 stays NULL", async () => {
    const { store, sources, d } = deps();
    sources.add(ID_A);
    stage(store, ID_A, makeBlob(5, 10), false);
    store.objects.get(stagingKeyFor(ID_A))!.checksumSha256 = Buffer.from("wrong").toString("base64");

    await expect(ingestStagedSource(d, ID_A)).rejects.toThrow(/staged-checksum-mismatch/);
    expect(sources.rows.get(ID_A)!.sha256).toBeNull();
  });

  test("nothing staged → nothing-staged, no writes", async () => {
    const { store, sources, d } = deps();
    sources.add(ID_A);
    expect(await ingestStagedSource(d, ID_A)).toEqual({ status: "nothing-staged" });
    expect(storedBytes(store, canonicalKeyFor(ID_A))).toBeNull();
  });

  test("unknown source → IngestError", async () => {
    const { d } = deps();
    await expect(ingestStagedSource(d, ID_A)).rejects.toThrow(/unknown-source/);
  });

  test("oversized staged download → staged-too-large IngestError, nothing stored", async () => {
    const { sources } = deps();
    sources.add(ID_A);
    const throwingStore: BlobStore = {
      async get() {
        throw new BlobTooLargeError(stagingKeyFor(ID_A), 64 * 1024 * 1024);
      },
      async put() {},
      async delete() {},
      async *listPages() {},
    };
    await expect(ingestStagedSource({ store: throwingStore, sources }, ID_A)).rejects.toThrow(
      /staged-too-large/,
    );
    expect(sources.rows.get(ID_A)!.sha256).toBeNull();
  });

  test("a staged download that passes the cap mid-stream → staged-too-large, nothing stored", async () => {
    const { store, sources } = deps();
    sources.add(ID_A);
    const streamingTooLarge: BlobStore = {
      ...store,
      async get(key) {
        return {
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(10));
              controller.error(new BlobTooLargeError(key, 10));
            },
          }),
          checksumSha256: null,
        };
      },
      put: (key, upload) => store.put(key, upload),
      delete: (key) => store.delete(key),
      listPages: (prefix) => store.listPages(prefix),
    };
    await expect(ingestStagedSource({ store: streamingTooLarge, sources }, ID_A)).rejects.toThrow(/staged-too-large/);
    expect(sources.rows.get(ID_A)!.sha256).toBeNull();
    expect(storedBytes(store, canonicalKeyFor(ID_A))).toBeNull();
  });

  test("a canonical blob over the cap → canonical-too-large, nothing stored, staged kept", async () => {
    const { store, sources, d } = deps();
    sources.add(ID_A);
    // 1 Hz upsamples tenfold: 3 frames become 21 canonical frames.
    stage(store, ID_A, makeBlob(3, 1), true);
    await expect(ingestStagedSource({ ...d, maxCanonicalBytes: 100 }, ID_A)).rejects.toThrow(/canonical-too-large/);
    expect(sources.rows.get(ID_A)!.sha256).toBeNull();
    expect(storedBytes(store, canonicalKeyFor(ID_A))).toBeNull();
    expect(storedBytes(store, stagingKeyFor(ID_A))).not.toBeNull();
    // The same upload under the real cap ingests.
    expect((await ingestStagedSource(d, ID_A)).status).toBe("ingested");
  });

  test("an upload replaced between the two reads fails the PUT instead of storing other bytes", async () => {
    const { store, sources, d } = deps();
    sources.add(ID_A);
    stage(store, ID_A, makeBlob(11, 10), false);
    const read = store.get.bind(store);
    store.get = async (key) => {
      const object = await read(key);
      // After the measuring read, a re-contribution lands a different upload.
      if (store.gets === 1) stage(store, ID_A, makeBlob(12, 10), false);
      return object;
    };
    await expect(ingestStagedSource(d, ID_A)).rejects.toThrow(/size|checksum/);
    expect(sources.rows.get(ID_A)!.sha256).toBeNull();
    expect(storedBytes(store, canonicalKeyFor(ID_A))).toBeNull();
  });

  test("gaps break interpolation through the worker", async () => {
    const { store, sources, d } = deps();
    sources.add(ID_A);
    // 5 frames @24 Hz with frame 3 a gap → canonical frame 1 must be a gap.
    stage(store, ID_A, makeBlob(5, 24, 3), true);
    await ingestStagedSource(d, ID_A);
    const decoded = decodeTkp1(Bun.gunzipSync(storedBytes(store, canonicalKeyFor(ID_A))!));
    expect(decoded.frameCount).toBe(2);
    const v1 = new DataView(decoded.frames[1]!.buffer, decoded.frames[1]!.byteOffset);
    const allZeroConf = Array.from({ length: 17 }, (_, k) => v1.getFloat32(k * 12 + 8, true)).every((c) => c === 0);
    expect(allZeroConf).toBe(true);
  });

  test("re-ingest is idempotent: same bytes, same digest", async () => {
    const { store, sources, d } = deps();
    sources.add(ID_A);
    stage(store, ID_A, makeBlob(31, 30), true);
    const first = await ingestStagedSource(d, ID_A);
    // Simulate a crashed-then-retried ingest: staged object still present.
    stage(store, ID_A, makeBlob(31, 30), true);
    const before = storedBytes(store, canonicalKeyFor(ID_A));
    const second = await ingestStagedSource(d, ID_A);
    const after = storedBytes(store, canonicalKeyFor(ID_A));
    expect(second).toEqual(first);
    expect(after).toEqual(before);
  });
});

describe("pollStagingOnce", () => {
  test("ingests what it can, collects per-source failures", async () => {
    const { store, sources, d } = deps();
    sources.add(ID_A);
    sources.add(ID_B);
    stage(store, ID_A, makeBlob(11, 10), true);
    store.objects.set(stagingKeyFor(ID_B), { bytes: new TextEncoder().encode("poison"), checksumSha256: null });
    // A non-upload key under the prefix is left alone.
    store.objects.set("staging/notes.txt", { bytes: new TextEncoder().encode("x"), checksumSha256: null });

    const summary = await pollStagingOnce(d);
    expect(summary.checked).toBe(2);
    expect(summary.ingested).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.failures[0]!.sourceId).toBe(ID_B);
    expect(sources.rows.get(ID_A)!.sha256).not.toBeNull();
    expect(sources.rows.get(ID_B)!.sha256).toBeNull();
    expect(storedBytes(store, "staging/notes.txt")).not.toBeNull();
  });

  test("processes one listing page at a time — page 1 is ingested before page 2 is listed", async () => {
    const { store, sources, d } = deps();
    sources.add(ID_A);
    sources.add(ID_B);
    stage(store, ID_A, makeBlob(11, 10), true);
    stage(store, ID_B, makeBlob(11, 10), true);
    // The generator asserts, before yielding page 2, that page 1's
    // source is already ingested. A worker that accumulated the whole
    // listing first would reach this point with sha256 still null.
    class StreamingProbeStore extends InMemoryBlobStore {
      override async *listPages(_prefix: string): AsyncIterable<string[]> {
        yield [stagingKeyFor(ID_A)];
        expect(sources.rows.get(ID_A)!.sha256).not.toBeNull();
        yield [stagingKeyFor(ID_B)];
      }
    }
    const probe = new StreamingProbeStore();
    probe.objects.set(stagingKeyFor(ID_A), store.objects.get(stagingKeyFor(ID_A))!);
    probe.objects.set(stagingKeyFor(ID_B), store.objects.get(stagingKeyFor(ID_B))!);

    const summary = await pollStagingOnce({ store: probe, sources });
    expect(summary).toEqual({ checked: 2, ingested: 2, failed: 0, failures: [] });
  });
});

describe("startIngestPoller", () => {
  test("a poll that outlasts the interval is not overlapped by the next", async () => {
    let polls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    class SlowListingStore extends InMemoryBlobStore {
      override async *listPages(_prefix: string): AsyncIterable<string[]> {
        polls++;
        await blocked;
      }
    }
    const stop = startIngestPoller({ store: new SlowListingStore(), sources: new FakeSourceStore() }, 5);
    try {
      await Bun.sleep(60);
      expect(polls).toBe(1);
      release();
      await Bun.sleep(60);
      expect(polls).toBeGreaterThan(1);
    } finally {
      stop();
    }
  });
});

const pgSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : null;

describe.if(pgSql !== null)("createPostgresSourceStore", () => {
  test("setSha256 commits the digest and the ingest time; unknown id throws", async () => {
    await inRollback(pgSql!, async (tx) => {
      const store = createPostgresSourceStore(tx as SQL);
      const id = "c".repeat(64);
      await tx`INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, r2_key)
               VALUES (${id}, ${"d".repeat(64)}, 11, 30, ${canonicalKeyFor(id)})`;
      expect(await store.get(id)).toMatchObject({ id, r2_key: canonicalKeyFor(id) });
      expect(await store.get("e".repeat(64))).toBeNull();

      const [before] = await tx`SELECT ingested_at FROM sources WHERE id = ${id}`;
      expect(before!.ingested_at).toBeNull();

      const digest = "f".repeat(64);
      await store.setSha256(id, digest);
      const rows = await tx`SELECT sha256, ingested_at = now() AS ingested_now FROM sources WHERE id = ${id}`;
      expect(rows[0]!.sha256).toBe(digest);
      expect(rows[0]!.ingested_now).toBe(true);

      await expect(store.setSha256("e".repeat(64), digest)).rejects.toThrow(/source-vanished/);
    });
  });
});
