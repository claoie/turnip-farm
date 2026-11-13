// The segmenter and the segment lifecycle, DB-backed (BACKEND_DESIGN.md
// §1.2.24). Runs inside a rolled-back transaction per db/testing.ts; only
// runs when TEST_DATABASE_URL names a database.

import { SQL, type TransactionSQL } from "bun";
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../../db/testing";
import { deleteAccountData, handleDeleteAccount } from "../auth/account";
import { sha256Hex } from "../auth/tokens";
import { handleDeleteSource } from "../contrib/sources";
import { handlePurgeQuarantine } from "../quarantine";
import type { R2Client } from "../r2/client";
import { TokenBucket } from "../ratelimit";
import { decodeTks1 } from "./segments";
import { segmentDirtySources, segmentKeyFor } from "./segmenter";
import type { BlobStore } from "./store";
import { encodeTkp1, gunzipStaged, gzipCanonical } from "./tkp1";
import { createPostgresSourceStore } from "./worker";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : (null as unknown as SQL);
afterAll(async () => {
  await sharedSql?.end();
});

const SOURCE_ID = "a".repeat(64);
const SOURCE_KEY = "xxx".repeat(14) + "x"; // 43-char fixture, not a secret
const USER_ID = "u1";
const PIPELINE_KEY = ["pipeline", "key", "for", "tests"].join("-");
const clipId = (i: number) => `123e4567-e89b-42d3-a456-42661417${String(i).padStart(4, "0")}`;

// One in-memory bucket behind both interfaces the code uses: the ingest
// BlobStore and the request-path R2Client.
function memoryBucket(opts: { onPut?: (key: string) => Promise<void> } = {}) {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const store: BlobStore = {
    get: async (key) => {
      const bytes = objects.get(key);
      return bytes ? { bytes, checksumSha256: null } : null;
    },
    put: async (key, bytes) => {
      objects.set(key, bytes);
      await opts.onPut?.(key);
    },
    delete: async (key) => {
      objects.delete(key);
    },
    listPages: async function* () {
      yield [...objects.keys()];
    },
  };
  const r2: R2Client = {
    presignPut: () => {
      throw new Error("not used");
    },
    presignGet: () => {
      throw new Error("not used");
    },
    getBytes: async (key) => objects.get(key) ?? null,
    deleteObject: async (key) => {
      objects.delete(key);
    },
  };
  return { objects, store, r2 };
}

// A 600-frame canonical blob of a standing body (every keypoint present).
function canonicalBlob(): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(204);
  const view = new DataView(frame.buffer);
  const xs = [0.5, 0.49, 0.51, 0.48, 0.52, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.45, 0.55, 0.45, 0.55, 0.45, 0.55];
  const ys = [0.2, 0.18, 0.18, 0.19, 0.19, 0.3, 0.3, 0.4, 0.4, 0.5, 0.5, 0.55, 0.55, 0.7, 0.7, 0.85, 0.85];
  for (let k = 0; k < 17; k++) {
    view.setFloat32(k * 12, xs[k]!, true);
    view.setFloat32(k * 12 + 4, ys[k]!, true);
    view.setFloat32(k * 12 + 8, 0.9, true);
  }
  const frames = Array.from({ length: 600 }, () => frame.slice());
  return gzipCanonical(encodeTkp1({ frameCount: 600, sourceSampleRateHz: 10, frames }));
}

async function seed(tx: TransactionSQL, bucket: ReturnType<typeof memoryBucket>, sha?: string) {
  const blob = canonicalBlob();
  bucket.objects.set(`poses/${SOURCE_ID}.tkp1.gz`, blob);
  await tx`INSERT INTO users (id) VALUES (${USER_ID})`;
  await tx`INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, r2_key, sha256, segments_dirty_at)
    VALUES (${SOURCE_ID}, ${sha256Hex(SOURCE_KEY)}, 600, 10, ${`poses/${SOURCE_ID}.tkp1.gz`},
            ${sha ?? new Bun.CryptoHasher("sha256").update(blob).digest("hex")}, now())`;
  await tx`INSERT INTO source_attribution (source_id, user_id) VALUES (${SOURCE_ID}, ${USER_ID})`;
  // Three labeled clips (the third too close to the second to keep) and one unlabeled.
  const clips: [number, number, number, string[]][] = [
    [1, 100, 120, ["cork"]],
    [2, 200, 230, ["gainer", "flash"]],
    [3, 236, 250, ["btwist"]],
    [4, 400, 420, []],
  ];
  for (const [i, start, end, names] of clips) {
    await tx`INSERT INTO clips (id, source_id, start_frame, end_frame) VALUES (${clipId(i)}::uuid, ${SOURCE_ID}, ${start}, ${end})`;
    for (const name of names) {
      await tx`INSERT INTO labels (clip_id, trick_name, taxonomy_version, origin) VALUES (${clipId(i)}::uuid, ${name}, 1, 'typed')`;
    }
  }
}

const segments = (tx: TransactionSQL) =>
  tx`SELECT t.id, t.r2_key, t.frame_count, t.window_start, t.window_end, t.split_bucket,
            (SELECT array_agg(trick_name ORDER BY trick_name) FROM training_segment_labels l WHERE l.segment_id = t.id) AS names
     FROM training_segments t ORDER BY t.window_start, t.frame_count`;

const links = (tx: TransactionSQL) => tx`SELECT segment_id, source_id FROM segment_sources`;

describeDb("segmentDirtySources", () => {
  test("cuts one segment per kept labeled clip, stores TKS1 blobs, links them, and settles", async () =>
    inRollback(sharedSql, async (tx) => {
      const bucket = memoryBucket();
      await seed(tx, bucket);
      expect(await segmentDirtySources({ sql: tx, store: bucket.store })).toEqual({ cut: 1, superseded: 0, failed: 0 });

      const rows = await segments(tx);
      // Clip 3 starts too close to clip 2's segment; clip 4 has no labels.
      expect(rows.map((r: any) => [r.frame_count, r.window_start, r.window_end, r.names])).toEqual([
        [30, 5, 25, ["cork"]],
        [40, 5, 35, ["flash", "gainer"]],
      ]);
      expect(new Set(rows.map((r: any) => r.split_bucket)).size).toBe(1);
      for (const r of rows as any[]) {
        expect(r.r2_key).toBe(segmentKeyFor(r.id));
        const frames = decodeTks1(await gunzipStaged(bucket.objects.get(r.r2_key)!));
        expect(frames).toHaveLength(r.frame_count);
        expect(frames[0]).toHaveLength(13);
      }
      expect((await links(tx)).map((l: any) => l.source_id)).toEqual([SOURCE_ID, SOURCE_ID]);
      const [{ settled }] = await tx`SELECT segments_cut_at = segments_dirty_at AS settled FROM sources`;
      expect(settled).toBe(true);
      // Nothing left to do.
      expect(await segmentDirtySources({ sql: tx, store: bucket.store })).toEqual({ cut: 0, superseded: 0, failed: 0 });
    }));

  test("a later write re-cuts: old rows and blobs go, new ids replace them", async () =>
    inRollback(sharedSql, async (tx) => {
      const bucket = memoryBucket();
      await seed(tx, bucket);
      await segmentDirtySources({ sql: tx, store: bucket.store });
      const before = (await segments(tx)).map((r: any) => r.r2_key);

      await tx`DELETE FROM labels WHERE clip_id = ${clipId(1)}::uuid`;
      await tx`UPDATE sources SET segments_dirty_at = now() + interval '1 second'`;
      expect((await segmentDirtySources({ sql: tx, store: bucket.store })).cut).toBe(1);

      const after = await segments(tx);
      expect(after.map((r: any) => r.names)).toEqual([["flash", "gainer"]]);
      expect(before).not.toContain(after[0].r2_key);
      for (const key of before) expect(bucket.objects.has(key)).toBe(false);
      expect([...bucket.objects.keys()].filter((k) => k.startsWith("segments/"))).toEqual([after[0].r2_key]);
    }));

  test("a write during the cut supersedes it: no rows, no stray blobs, still dirty", async () =>
    inRollback(sharedSql, async (tx) => {
      let bumped = false;
      const bucket = memoryBucket({
        onPut: async () => {
          if (bumped) return;
          bumped = true;
          await tx`UPDATE sources SET segments_dirty_at = now() + interval '1 second'`;
        },
      });
      await seed(tx, bucket);
      expect(await segmentDirtySources({ sql: tx, store: bucket.store })).toEqual({ cut: 0, superseded: 1, failed: 0 });
      expect(await segments(tx)).toHaveLength(0);
      expect([...bucket.objects.keys()].filter((k) => k.startsWith("segments/"))).toEqual([]);
      // The next run cuts from the newer state.
      expect((await segmentDirtySources({ sql: tx, store: bucket.store })).cut).toBe(1);
    }));

  test("a canonical blob that doesn't match sources.sha256 fails the source and stores nothing", async () =>
    inRollback(sharedSql, async (tx) => {
      const bucket = memoryBucket();
      await seed(tx, bucket, sha256Hex("something else"));
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(await segmentDirtySources({ sql: tx, store: bucket.store })).toEqual({ cut: 0, superseded: 0, failed: 1 });
      } finally {
        warn.mockRestore();
      }
      expect(await segments(tx)).toHaveLength(0);
      expect([...bucket.objects.keys()].filter((k) => k.startsWith("segments/"))).toEqual([]);
    }));
});

describeDb("segment lifecycle", () => {
  test("account deletion removes the source, its blob and every segment_sources row; the segments stay, de-linked", async () =>
    inRollback(sharedSql, async (tx) => {
      const bucket = memoryBucket();
      await seed(tx, bucket);
      await segmentDirtySources({ sql: tx, store: bucket.store });
      const kept = (await segments(tx)).map((r: any) => r.r2_key);
      expect(kept).toHaveLength(2);

      await deleteAccountData(tx, bucket.r2, USER_ID);

      expect(await links(tx)).toHaveLength(0);
      expect(await tx`SELECT id FROM sources`).toHaveLength(0);
      expect(bucket.objects.has(`poses/${SOURCE_ID}.tkp1.gz`)).toBe(false);
      expect((await segments(tx)).map((r: any) => r.r2_key)).toEqual(kept);
      for (const key of kept) expect(bucket.objects.has(key)).toBe(true);
    }));

  test("DELETE /api/account?contributions=delete leaves no row or blob for the account", async () =>
    inRollback(sharedSql, async (tx) => {
      const bucket = memoryBucket();
      await seed(tx, bucket);
      await segmentDirtySources({ sql: tx, store: bucket.store });
      // Someone else's de-linked segment, which must survive.
      await tx`INSERT INTO training_segments (id, r2_key, sha256, frame_count, window_start, window_end, split_bucket)
        VALUES (${clipId(99)}::uuid, ${segmentKeyFor(clipId(99))}, ${"0".repeat(64)}, 20, 5, 15, 0)`;
      bucket.objects.set(segmentKeyFor(clipId(99)), new Uint8Array(1));
      await tx`INSERT INTO sessions (user_id, token_hash, expires_at)
        VALUES (${USER_ID}, ${sha256Hex("session-for-u1")}, now() + interval '1 hour')`;
      const accountDeps = {
        sql: tx,
        r2: bucket.r2,
        refreshTokenKey: {} as CryptoKey,
        revokeRefreshToken: async () => {},
      };
      const del = (query: string) =>
        new Request(`http://farm.test/api/account${query}`, {
          method: "DELETE",
          headers: { authorization: "Bearer session-for-u1" },
        });

      const bad = await handleDeleteAccount(del("?contributions=everything"), accountDeps);
      expect(bad.status).toBe(422);
      expect(((await bad.json()) as { error: { details: unknown } }).error.details).toEqual({ field: "contributions" });
      expect(await tx`SELECT id FROM users`).toHaveLength(1);

      expect((await handleDeleteAccount(del("?contributions=delete"), accountDeps)).status).toBe(204);
      for (const table of ["users", "sessions", "consents", "source_attribution", "sources", "clips", "labels", "segment_sources"]) {
        expect(await tx`SELECT 1 FROM ${tx(table)}`).toHaveLength(0);
      }
      expect((await segments(tx)).map((r: any) => r.id)).toEqual([clipId(99)]);
      expect(await tx`SELECT 1 FROM training_segment_labels`).toHaveLength(0);
      expect([...bucket.objects.keys()]).toEqual([segmentKeyFor(clipId(99))]);
    }));

  test("DELETE /api/account?contributions=keep is the default: only de-linked segments survive", async () =>
    inRollback(sharedSql, async (tx) => {
      const bucket = memoryBucket();
      await seed(tx, bucket);
      await segmentDirtySources({ sql: tx, store: bucket.store });
      await tx`INSERT INTO sessions (user_id, token_hash, expires_at)
        VALUES (${USER_ID}, ${sha256Hex("session-for-u1")}, now() + interval '1 hour')`;
      const res = await handleDeleteAccount(
        new Request("http://farm.test/api/account?contributions=keep", {
          method: "DELETE",
          headers: { authorization: "Bearer session-for-u1" },
        }),
        { sql: tx, r2: bucket.r2, refreshTokenKey: {} as CryptoKey, revokeRefreshToken: async () => {} },
      );
      expect(res.status).toBe(204);
      for (const table of ["users", "sources", "source_attribution", "segment_sources"]) {
        expect(await tx`SELECT 1 FROM ${tx(table)}`).toHaveLength(0);
      }
      const kept = await segments(tx);
      expect(kept).toHaveLength(2);
      expect([...bucket.objects.keys()].sort()).toEqual(kept.map((r: any) => r.r2_key).sort());
    }));

  test("DELETE /api/sources/:id removes the source's segments and their blobs", async () =>
    inRollback(sharedSql, async (tx) => {
      const bucket = memoryBucket();
      await seed(tx, bucket);
      await segmentDirtySources({ sql: tx, store: bucket.store });
      await tx`INSERT INTO sessions (user_id, token_hash, expires_at)
        VALUES (${USER_ID}, ${sha256Hex("session-for-u1")}, now() + interval '1 hour')`;
      const res = await handleDeleteSource(
        new Request(`http://farm.test/api/sources/${SOURCE_ID}`, {
          method: "DELETE",
          headers: { authorization: "Bearer session-for-u1", "source-key": SOURCE_KEY },
        }),
        {
          sql: tx,
          r2: bucket.r2,
          currentDisclosureVersion: 3,
          limits: { user: new TokenBucket(10, 10), ip: new TokenBucket(10, 10), publicIp: new TokenBucket(10, 10) },
        },
        SOURCE_ID,
      );
      expect(res.status).toBe(204);
      expect(await segments(tx)).toHaveLength(0);
      expect([...bucket.objects.keys()]).toEqual([]);
    }));

  test("a quarantine purge removes the source's segments and their blobs", async () =>
    inRollback(sharedSql, async (tx) => {
      const bucket = memoryBucket();
      await seed(tx, bucket);
      await segmentDirtySources({ sql: tx, store: bucket.store });
      await tx`INSERT INTO data_quarantine (source_id, reason) VALUES (${SOURCE_ID}, 'fixture regression')`;
      const res = await handlePurgeQuarantine(
        new Request(`http://farm.test/api/quarantine/${SOURCE_ID}/purge`, {
          method: "POST",
          headers: { authorization: `Bearer ${PIPELINE_KEY}` },
        }),
        { sql: tx, r2: bucket.r2, pipelineKey: PIPELINE_KEY },
        SOURCE_ID,
      );
      expect(res.status).toBe(204);
      expect(await segments(tx)).toHaveLength(0);
      expect([...bucket.objects.keys()]).toEqual([]);
    }));

  test("ingest marks the source dirty when it stores a new blob", async () =>
    inRollback(sharedSql, async (tx) => {
      await tx`INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, r2_key)
        VALUES (${SOURCE_ID}, ${sha256Hex(SOURCE_KEY)}, 600, 10, ${`poses/${SOURCE_ID}.tkp1.gz`})`;
      await createPostgresSourceStore(tx).setSha256(SOURCE_ID, sha256Hex("blob"));
      const [{ dirty }] = await tx`SELECT segments_dirty_at IS NOT NULL AS dirty FROM sources`;
      expect(dirty).toBe(true);
    }));

  test("a segment copies its clip's provenance, quoting suggested names safely", async () =>
    inRollback(sharedSql, async (tx) => {
      const bucket = memoryBucket();
      await seed(tx, bucket);
      await tx`INSERT INTO models (version, taxonomy_version, r2_key, sha256)
        VALUES ('trick-v1', 1, 'models/v1.zip', ${"0".repeat(64)})`;
      await tx`UPDATE clips SET proposal_model_version = 'trick-v1',
        suggested_names = ARRAY['cork', 'say "hi"', 'back\\slash', 'a,b'], suggestions_withheld = true
        WHERE id = ${clipId(1)}::uuid`;
      await segmentDirtySources({ sql: tx, store: bucket.store });
      const [row] = await tx`
        SELECT proposal_model_version, suggested_names, suggestions_withheld FROM training_segments
        WHERE window_end - window_start = 20`;
      expect(row).toEqual({
        proposal_model_version: "trick-v1",
        suggested_names: ["cork", 'say "hi"', "back\\slash", "a,b"],
        suggestions_withheld: true,
      });
    }));
});
