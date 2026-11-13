// Training export, DB-backed (BACKEND_DESIGN.md §6, §7.3): serves training
// segments (§1.2.24), never whole-session pose. Run inside a rolled-back
// transaction per db/testing.ts; only run when TEST_DATABASE_URL names a
// database.

import { SQL, type TransactionSQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../db/testing";
import { sha256Hex } from "./auth/tokens";
import { encodeCursor, handleGetLabelsExport, type ExportDeps } from "./export";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : null;
afterAll(async () => {
  await sharedSql?.end();
});

// Test-only stand-in, not a secret (built dynamically like the SOURCE_KEY fixture).
const PIPELINE_KEY = ["pipeline", "key", "for", "tests"].join("-");
const authHeaders = { authorization: `Bearer ${PIPELINE_KEY}` };

function deps(tx: TransactionSQL, pageLimit?: number): ExportDeps {
  return { sql: tx as unknown as SQL, pipelineKey: PIPELINE_KEY, pageLimit };
}

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://farm.test${path}`, { method: "GET", headers });
}

async function bodyJson(res: Response): Promise<any> {
  return res.json();
}

const vid = (ch: string) => ch.repeat(64);
const segId = (i: number) => `123e4567-e89b-42d3-a456-42661417${String(i).padStart(4, "0")}`;

async function seedSource(tx: TransactionSQL, id: string) {
  await tx`INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, keypoint_format, r2_key, sha256)
    VALUES (${id}, ${sha256Hex(`key-${id.slice(0, 8)}`)}, 600, 10, 'tkp1', ${`poses/${id}.tkp1.gz`},
            ${sha256Hex(`blob-${id.slice(0, 8)}`)})`;
}

async function seedSegment(
  tx: TransactionSQL,
  id: string,
  opts: {
    sourceId?: string;
    labels?: { name: string; origin?: string }[];
    proposalModelVersion?: string | null;
    suggestedNames?: string[];
    withheld?: boolean;
  } = {},
) {
  // Bun doesn't bind a JS array as a Postgres array; the test names are
  // plain lowercase words, so the literal needs no quoting.
  const names = `{${(opts.suggestedNames ?? []).join(",")}}`;
  await tx`INSERT INTO training_segments
      (id, r2_key, sha256, frame_count, window_start, window_end, split_bucket,
       proposal_model_version, suggested_names, suggestions_withheld)
    VALUES (${id}::uuid, ${`segments/${id}.tks1.gz`}, ${sha256Hex(`seg-${id}`)}, 25, 5, 20, 3,
            ${opts.proposalModelVersion ?? null}, ${names}::text[], ${opts.withheld ?? false})`;
  for (const l of opts.labels ?? [{ name: "cork" }]) {
    await tx`INSERT INTO training_segment_labels (segment_id, trick_name, origin, taxonomy_version)
      VALUES (${id}::uuid, ${l.name}, ${l.origin ?? "typed"}, 1)`;
  }
  if (opts.sourceId) {
    await tx`INSERT INTO segment_sources (segment_id, source_id) VALUES (${id}::uuid, ${opts.sourceId})`;
  }
}

async function pull(tx: TransactionSQL, since?: string, limit?: number) {
  const q = since === undefined ? "" : `?since=${since}`;
  const res = await handleGetLabelsExport(get(`/api/labels/export${q}`, authHeaders), deps(tx, limit));
  expect(res.status).toBe(200);
  return bodyJson(res);
}

async function pullAll(tx: TransactionSQL, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let since: string | undefined;
  for (let page = 0; page < 100; page++) {
    const body = await pull(tx, since, limit);
    if (body.segments.length === 0) {
      expect(body.next_cursor).toBeNull();
      return ids;
    }
    ids.push(...body.segments.map((s: { segment_id: string }) => s.segment_id));
    since = body.next_cursor;
  }
  throw new Error("export never ended");
}

describeDb("GET /api/labels/export", () => {
  test("401 without the pipeline key, or with the wrong one", async () => {
    await inRollback(sharedSql!, async (tx) => {
      expect((await handleGetLabelsExport(get("/api/labels/export"), deps(tx))).status).toBe(401);
      const wrong = await handleGetLabelsExport(
        get("/api/labels/export", { authorization: "Bearer wrong-key" }),
        deps(tx),
      );
      expect(wrong.status).toBe(401);
    });
  });

  test("422 on a malformed since cursor, including the old whole-session cursor", async () => {
    await inRollback(sharedSql!, async (tx) => {
      for (const since of [
        "not-a-cursor",
        Buffer.from("{}", "utf8").toString("base64url"),
        Buffer.from(JSON.stringify(["nope"]), "utf8").toString("base64url"),
        Buffer.from(JSON.stringify(["2026-10-15T12:00:00.000Z", segId(1), "cork"]), "utf8").toString("base64url"),
      ]) {
        const res = await handleGetLabelsExport(get(`/api/labels/export?since=${since}`, authHeaders), deps(tx));
        expect(res.status).toBe(422);
        expect((await bodyJson(res)).error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  test("empty export: no segments, whole taxonomy, null next_cursor", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const body = await pull(tx);
      expect(body.segments).toEqual([]);
      expect(body.taxonomy).toContainEqual({ raw: "corkscrew", canonical: "cork", taxonomy_version: 1 });
      expect(body.next_cursor).toBeNull();
      expect(Object.keys(body).sort()).toEqual(["next_cursor", "segments", "taxonomy"]);
    });
  });

  test("taxonomy ships the whole table, including versions no segment references", async () => {
    await inRollback(sharedSql!, async (tx) => {
      await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES ('corked', 'cork', 2)`;
      expect((await pull(tx)).taxonomy).toContainEqual({ raw: "corked", canonical: "cork", taxonomy_version: 2 });
    });
  });

  test("segment shape: labels, window, split bucket and provenance; no source or whole-session pose", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const v = vid("a");
      await seedSource(tx, v);
      await tx`INSERT INTO models (version, taxonomy_version, r2_key, sha256) VALUES ('trick-v1', 1, 'models/v1.zip', ${sha256Hex("m")})`;
      await seedSegment(tx, segId(1), {
        sourceId: v,
        labels: [{ name: "gainer", origin: "typed" }, { name: "cork", origin: "model" }],
        proposalModelVersion: "trick-v1",
        suggestedNames: ["cork", "flash"],
        withheld: false,
      });
      const body = await pull(tx);
      expect(body.segments).toEqual([
        {
          segment_id: segId(1),
          r2_key: `segments/${segId(1)}.tks1.gz`,
          blob_sha256: sha256Hex(`seg-${segId(1)}`),
          frame_count: 25,
          window_start: 5,
          window_end: 20,
          split_bucket: 3,
          proposal_model_version: "trick-v1",
          suggested_names: ["cork", "flash"],
          suggestions_withheld: false,
          labels: [
            { trick_name: "cork", origin: "model", taxonomy_version: 1 },
            { trick_name: "gainer", origin: "typed", taxonomy_version: 1 },
          ],
        },
      ]);
      expect(JSON.stringify(body)).not.toContain(v);
      expect(JSON.stringify(body)).not.toContain("poses/");
      expect(body.next_cursor).toBe(encodeCursor(segId(1)));
    });
  });

  test("pages by segment id with no gaps or dupes across the LIMIT boundary", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const ids = [7, 2, 9, 4, 1, 8, 3].map(segId);
      for (const id of ids) await seedSegment(tx, id);
      expect(await pullAll(tx, 3)).toEqual([...ids].sort());
      expect(await pullAll(tx, 1)).toEqual([...ids].sort());
    });
  });

  test("segments of a quarantined source are excluded; released ones rejoin", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const v = vid("a");
      await seedSource(tx, v);
      await seedSegment(tx, segId(1), { sourceId: v });
      await seedSegment(tx, segId(2));
      await tx`INSERT INTO data_quarantine (source_id, reason) VALUES (${v}, 'fixture regression')`;
      expect(await pullAll(tx, 10)).toEqual([segId(2)]);
      await tx`UPDATE data_quarantine SET resolved_at = now(), resolution = 'released' WHERE source_id = ${v}`;
      expect(await pullAll(tx, 10)).toEqual([segId(1), segId(2)]);
    });
  });

  test("a de-linked segment stays in the export once its source is gone", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const v = vid("a");
      await seedSource(tx, v);
      await seedSegment(tx, segId(1), { sourceId: v });
      await tx`DELETE FROM sources WHERE id = ${v}`;
      expect(await tx`SELECT segment_id FROM segment_sources`).toHaveLength(0);
      expect(await pullAll(tx, 10)).toEqual([segId(1)]);
    });
  });

  test("a segment with no labels is not exported", async () => {
    await inRollback(sharedSql!, async (tx) => {
      await seedSegment(tx, segId(1), { labels: [] });
      await seedSegment(tx, segId(2));
      expect(await pullAll(tx, 10)).toEqual([segId(2)]);
    });
  });
});
