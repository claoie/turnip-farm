// Quarantine endpoints, DB-backed (BACKEND_DESIGN.md §3, §6; issue #19).
// Run inside a rolled-back transaction per db/testing.ts; only run when
// TEST_DATABASE_URL names a database.

import { SQL, type TransactionSQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../db/testing";
import { sha256Hex } from "./auth/tokens";
import {
  handlePostQuarantine,
  handlePurgeQuarantine,
  handleReleaseQuarantine,
  type QuarantineDeps,
} from "./quarantine";
import type { R2Client } from "./r2/client";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : null;
afterAll(async () => {
  await sharedSql?.end();
});

// Test-only stand-in, not a secret (built dynamically like the SOURCE_KEY fixture).
const PIPELINE_KEY = ["pipeline", "key", "for", "tests"].join("-");
const authHeaders = { authorization: `Bearer ${PIPELINE_KEY}` };

function fakeR2(opts: { failDelete?: boolean } = {}): R2Client & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    presignPut: () => {
      throw new Error("r2 unavailable in this test");
    },
    presignGet: () => {
      throw new Error("r2 unavailable in this test");
    },
    getStream: () => {
      throw new Error("r2 unavailable in this test");
    },
    deleteObject: async (key: string) => {
      if (opts.failDelete) throw new Error("r2 down");
      deleted.push(key);
    },
  };
}

function deps(tx: TransactionSQL, r2?: R2Client): QuarantineDeps {
  return { sql: tx as unknown as SQL, pipelineKey: PIPELINE_KEY, r2: r2 ?? fakeR2() };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://farm.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function bodyJson(res: Response): Promise<any> {
  return res.json();
}

const vid = (ch: string) => ch.repeat(64);
const TS = "2026-10-15T12:00:00.000Z";

async function seedSource(tx: TransactionSQL, id: string) {
  await tx`INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, keypoint_format, r2_key, sha256, created_at, updated_at)
    VALUES (${id}, ${sha256Hex(`key-${id.slice(0, 8)}`)}, 600, 10, 'tkp1', ${`poses/${id}.tkp1.gz`}, ${sha256Hex(`blob-${id.slice(0, 8)}`)}, ${TS}::timestamptz, ${TS}::timestamptz)`;
}

async function countWhere(tx: TransactionSQL, table: string, cond: string, id: string): Promise<number> {
  const rows = (await tx.unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${cond} = $1`,
    [id],
  )) as { n: number }[];
  return rows[0]!.n;
}

describeDb("POST /api/quarantine", () => {
  test("401 without the pipeline key", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const res = await handlePostQuarantine(
        post("/api/quarantine", { source_ids: [vid("a")], reason: "r" }),
        deps(tx),
      );
      expect(res.status).toBe(401);
    });
  });

  test("422 on bad bodies", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const d = deps(tx);
      for (const body of [
        { source_ids: [], reason: "r" },
        { source_ids: ["nope"], reason: "r" },
        { source_ids: [vid("a")], reason: "" },
        { source_ids: [vid("a")], reason: "r", metrics: [1] },
        { source_ids: [vid("a")] },
        { source_ids: Array.from({ length: 10001 }, () => vid("a")), reason: "r" },
        // segment_ids is no longer accepted: source_ids is required.
        { segment_ids: ["123e4567-e89b-42d3-a456-426614174000"], reason: "r" },
        { reason: "r" },
        "not-an-object",
      ]) {
        const res = await handlePostQuarantine(post("/api/quarantine", body, authHeaders), d);
        expect(res.status).toBe(422);
        expect((await bodyJson(res)).error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  test("quarantines each id; resubmit is a no-op; unknown ids are reported", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const a = vid("a");
      const b = vid("b");
      const unknown = vid("c");
      await seedSource(tx, a);
      await seedSource(tx, b);
      const d = deps(tx);

      const body = { source_ids: [a, b, b, unknown], reason: "fixture regression", metrics: { delta: -0.05 } };
      const res = await handlePostQuarantine(post("/api/quarantine", body, authHeaders), d);
      expect(res.status).toBe(200);
      expect(await bodyJson(res)).toEqual({
        quarantined: [a, b],
        already_open: [],
        unknown: [unknown],
      });

      const rows = await tx`
        SELECT source_id, reason, metrics, jsonb_typeof(metrics) AS metrics_type, resolution
        FROM data_quarantine ORDER BY source_id`;
      expect(rows).toHaveLength(2);
      expect(rows[0].reason).toBe("fixture regression");
      // Stored as a JSON object, not a JSON-encoded string.
      expect(rows[0].metrics_type).toBe("object");
      expect(rows[0].metrics).toEqual({ delta: -0.05 });
      expect(rows[0].resolution).toBeNull();

      // Resubmission: the open rows make it a no-op, not an error.
      const res2 = await handlePostQuarantine(post("/api/quarantine", body, authHeaders), d);
      expect(await bodyJson(res2)).toEqual({
        quarantined: [],
        already_open: [a, b],
        unknown: [unknown],
      });
      expect((await tx`SELECT count(*)::int AS n FROM data_quarantine`) as unknown as { n: number }[]).toEqual([{ n: 2 }]);
    });
  });
});

describeDb("POST /api/quarantine/:id/release", () => {
  test("401 without the pipeline key; 404 with no open quarantine", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const a = vid("a");
      await seedSource(tx, a);
      expect(
        (await handleReleaseQuarantine(post(`/api/quarantine/${a}/release`, {}, {}), deps(tx), a)).status,
      ).toBe(401);
      const res = await handleReleaseQuarantine(
        post(`/api/quarantine/${a}/release`, {}, authHeaders),
        deps(tx),
        a,
      );
      expect(res.status).toBe(404);
    });
  });

  test("release resolves the row; a second release 404s", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const a = vid("a");
      await seedSource(tx, a);
      const d = deps(tx);
      await handlePostQuarantine(
        post("/api/quarantine", { source_ids: [a], reason: "r" }, authHeaders),
        d,
      );
      const res = await handleReleaseQuarantine(post(`/api/quarantine/${a}/release`, {}, authHeaders), d, a);
      expect(res.status).toBe(200);
      expect(await bodyJson(res)).toEqual({ source_id: a, resolution: "released" });
      const res2 = await handleReleaseQuarantine(post(`/api/quarantine/${a}/release`, {}, authHeaders), d, a);
      expect(res2.status).toBe(404);
      // And the source can be quarantined again after release.
      const res3 = await handlePostQuarantine(
        post("/api/quarantine", { source_ids: [a], reason: "r2" }, authHeaders),
        d,
      );
      expect((await bodyJson(res3)).quarantined).toEqual([a]);
    });
  });
});

describeDb("POST /api/quarantine/:id/purge", () => {
  test("401 without the pipeline key; 404 with no open quarantine", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const a = vid("a");
      await seedSource(tx, a);
      expect(
        (await handlePurgeQuarantine(post(`/api/quarantine/${a}/purge`, {}, {}), deps(tx), a)).status,
      ).toBe(401);
      const res = await handlePurgeQuarantine(
        post(`/api/quarantine/${a}/purge`, {}, authHeaders),
        deps(tx),
        a,
      );
      expect(res.status).toBe(404);
    });
  });

  test("purge hard-deletes the source, its clips/labels, and the R2 blob", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const a = vid("a");
      await seedSource(tx, a);
      const clip = "123e4567-e89b-42d3-a456-426614170001";
      await tx`INSERT INTO clips (id, source_id, start_frame, end_frame) VALUES (${clip}::uuid, ${a}, 0, 10)`;
      await tx`INSERT INTO labels (clip_id, trick_name, taxonomy_version) VALUES (${clip}::uuid, 'cork', 1)`;
      const r2 = fakeR2();
      const d = deps(tx, r2);
      await handlePostQuarantine(
        post("/api/quarantine", { source_ids: [a], reason: "poisoned" }, authHeaders),
        d,
      );

      const res = await handlePurgeQuarantine(post(`/api/quarantine/${a}/purge`, {}, authHeaders), d, a);
      expect(res.status).toBe(204);
      expect(await countWhere(tx, "sources", "id", a)).toBe(0);
      expect(await countWhere(tx, "clips", "source_id", a)).toBe(0);
      expect(await countWhere(tx, "data_quarantine", "source_id", a)).toBe(0);
      expect(r2.deleted).toContain(`poses/${a}.tkp1.gz`);
      expect(r2.deleted).toContain(`staging/${a}.tkp1.gz`);
    });
  });

  test("purge fails closed when R2 is down: the source survives", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const a = vid("a");
      await seedSource(tx, a);
      const d = deps(tx, fakeR2({ failDelete: true }));
      await handlePostQuarantine(
        post("/api/quarantine", { source_ids: [a], reason: "poisoned" }, authHeaders),
        d,
      );
      const res = await handlePurgeQuarantine(post(`/api/quarantine/${a}/purge`, {}, authHeaders), d, a);
      expect(res.status).toBe(500);
      expect(await countWhere(tx, "sources", "id", a)).toBe(1);
      // The quarantine row is still open, so the call can be retried.
      expect(
        ((await tx`SELECT count(*)::int AS n FROM data_quarantine WHERE source_id = ${a} AND resolved_at IS NULL`) as unknown as { n: number }[])[0]!.n,
      ).toBe(1);
    });
  });
});
