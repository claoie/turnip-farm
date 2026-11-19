// Training export, DB-backed (BACKEND_DESIGN.md §6, §7.3).
// Run inside a rolled-back transaction per db/testing.ts; only run when
// TEST_DATABASE_URL names a database.

import { SQL, type TransactionSQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../db/testing";
import { sha256Hex } from "./auth/tokens";
import { HOLD_BACK_MIN_CONTRIBUTORS, handleGetLabelsExport, type ExportDeps } from "./export";
import { canonicalKeyFor, ingestStagedSource } from "./ingest/worker";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : null;
afterAll(async () => {
  await sharedSql?.end();
});

// Test-only stand-in, not a secret (built dynamically like the SOURCE_KEY fixture).
const PIPELINE_KEY = ["pipeline", "key", "for", "tests"].join("-");
const authHeaders = { authorization: `Bearer ${PIPELINE_KEY}` };

function deps(tx: TransactionSQL, pageLimit?: number, fetchRows?: number): ExportDeps {
  return { sql: tx as unknown as SQL, pipelineKey: PIPELINE_KEY, pageLimit, fetchRows };
}

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://farm.test${path}`, { method: "GET", headers });
}

async function bodyJson(res: Response): Promise<any> {
  return res.json();
}

const vid = (ch: string) => ch.repeat(64);
const clipId = (i: number) => `123e4567-e89b-42d3-a456-42661417${String(i).padStart(4, "0")}`;
const TS = "2026-10-15T12:00:00.000Z";

async function seedSource(
  tx: TransactionSQL,
  id: string,
  opts: { sha256?: string | null; updatedAt?: string } = {},
) {
  const sha256 = opts.sha256 === undefined ? sha256Hex(`blob-${id.slice(0, 8)}`) : opts.sha256;
  await tx`INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, keypoint_format, r2_key, sha256, created_at, updated_at)
    VALUES (${id}, ${sha256Hex(`key-${id.slice(0, 8)}`)}, 600, 10, 'tkp1', ${`poses/${id}.tkp1.gz`}, ${sha256}, ${opts.updatedAt ?? TS}::timestamptz, ${opts.updatedAt ?? TS}::timestamptz)`;
}

async function seedClip(
  tx: TransactionSQL,
  id: string,
  sourceId: string,
  opts: { updatedAt?: string; proposalModelVersion?: string | null; suggestedNames?: string[] } = {},
) {
  // Bun doesn't serialize JS arrays to Postgres arrays — pass an array
  // literal; the test names are simple lowercase words, no quoting edge
  // cases.
  const names = opts.suggestedNames ?? [];
  const namesParam = `{${names.join(",")}}`;
  await tx`INSERT INTO clips (id, source_id, start_frame, end_frame, proposal_model_version, suggested_names, created_at, updated_at)
    VALUES (${id}::uuid, ${sourceId}, 0, 100, ${opts.proposalModelVersion ?? null}, ${namesParam}, ${opts.updatedAt ?? TS}::timestamptz, ${opts.updatedAt ?? TS}::timestamptz)`;
}

async function seedLabel(
  tx: TransactionSQL,
  clipId_: string,
  trickName: string,
  opts: { origin?: string; updatedAt?: string } = {},
): Promise<void> {
  await tx`INSERT INTO labels (clip_id, trick_name, taxonomy_version, origin, created_at, updated_at)
    VALUES (${clipId_}::uuid, ${trickName}, 1, ${opts.origin ?? "typed"}, ${opts.updatedAt ?? TS}::timestamptz, ${opts.updatedAt ?? TS}::timestamptz)`;
}

async function attribute(tx: TransactionSQL, sourceId: string, userId: string): Promise<void> {
  await tx`INSERT INTO users (id) VALUES (${userId}) ON CONFLICT DO NOTHING`;
  await tx`INSERT INTO source_attribution (source_id, user_id) VALUES (${sourceId}, ${userId})`;
}

async function pull(tx: TransactionSQL): Promise<any> {
  const res = await handleGetLabelsExport(get("/api/labels/export", authHeaders), deps(tx));
  expect(res.status).toBe(200);
  return bodyJson(res);
}

describeDb("GET /api/labels/export", () => {
  test("401 without the pipeline key", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const res = await handleGetLabelsExport(get("/api/labels/export"), deps(tx));
      expect(res.status).toBe(401);
      expect((await bodyJson(res)).error.code).toBe("UNAUTHENTICATED");
    });
  });

  test("401 with the wrong pipeline key", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const res = await handleGetLabelsExport(
        get("/api/labels/export", { authorization: "Bearer wrong-key" }),
        deps(tx),
      );
      expect(res.status).toBe(401);
    });
  });

  test("422 on a malformed since cursor", async () => {
    await inRollback(sharedSql!, async (tx) => {
      for (const since of [
        "not-a-cursor",
        Buffer.from("{}", "utf8").toString("base64url"),
        Buffer.from(JSON.stringify(["2026-10-15T12:00:00.000Z", "nope", "cork"]), "utf8").toString("base64url"),
        Buffer.from(JSON.stringify(["not-a-date", clipId(1), "cork"]), "utf8").toString("base64url"),
        // A training-segment cursor, [segment_id], from before segments were removed.
        Buffer.from(JSON.stringify([clipId(1)]), "utf8").toString("base64url"),
      ]) {
        const res = await handleGetLabelsExport(
          get(`/api/labels/export?since=${since}`, authHeaders),
          deps(tx),
        );
        expect(res.status).toBe(422);
        expect((await bodyJson(res)).error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  test("empty export: no rows, whole taxonomy, null next_cursor", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const res = await handleGetLabelsExport(get("/api/labels/export", authHeaders), deps(tx));
      expect(res.status).toBe(200);
      const body = await bodyJson(res);
      expect(body.rows).toEqual([]);
      // The seed taxonomy ships whole, even with no rows.
      expect(body.taxonomy.length).toBeGreaterThan(0);
      expect(body.taxonomy).toContainEqual({ raw: "corkscrew", canonical: "cork", taxonomy_version: 1 });
      expect(body.next_cursor).toBeNull();
      expect(body.trick_contributors).toEqual([]);
      expect(body.contributor_minimum).toBe(HOLD_BACK_MIN_CONTRIBUTORS);
    });
  });

  test("taxonomy ships the whole table, including versions no row references", async () => {
    await inRollback(sharedSql!, async (tx) => {
      await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES ('corked', 'cork', 2)`;
      const res = await handleGetLabelsExport(get("/api/labels/export", authHeaders), deps(tx));
      const body = await bodyJson(res);
      expect(body.taxonomy).toContainEqual({ raw: "corked", canonical: "cork", taxonomy_version: 2 });
    });
  });

  test("row shape: the whole-recording blob, the clip, one label with its canonical, provenance; no account", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const v = vid("a");
      await seedSource(tx, v);
      await attribute(tx, v, "u1");
      await seedClip(tx, clipId(1), v, { proposalModelVersion: "trick-v1.2", suggestedNames: ["cork"] });
      await seedLabel(tx, clipId(1), "cork", { origin: "model" });
      const res = await handleGetLabelsExport(get("/api/labels/export", authHeaders), deps(tx));
      expect(res.status).toBe(200);
      const body = await bodyJson(res);
      expect(body.rows).toEqual([
        {
          source_id: v,
          r2_key: `poses/${v}.tkp1.gz`,
          blob_sha256: sha256Hex(`blob-${v.slice(0, 8)}`),
          holdout: false,
          clip_id: clipId(1),
          start_frame: 0,
          end_frame: 100,
          proposal_model_version: "trick-v1.2",
          suggested_names: ["cork"],
          suggestions_withheld: false,
          trick_name: "cork",
          canonical: "cork",
          origin: "model",
          taxonomy_version: 1,
        },
      ]);
      expect(typeof body.next_cursor).toBe("string");
      expect(JSON.stringify(body)).not.toContain("u1");
    });
  });

  test("paginates timestamp ties with no gaps or dupes", async () => {
    await inRollback(sharedSql!, async (tx) => {
      // 4 sources x 2 clips x 2 labels = 16 rows, every updated_at the
      // same instant: ties on row_cursor AND on (row_cursor, clip_id).
      // pageLimit 3 forces 6 pages over the ties plus the terminal empty page.
      let n = 0;
      const expectKeys: string[] = [];
      for (const ch of ["a", "b", "c", "d"]) {
        const v = vid(ch);
        await seedSource(tx, v);
        for (let c = 0; c < 2; c++) {
          const cid = clipId(n++);
          await seedClip(tx, cid, v);
          for (const name of ["cork", "gainer"]) {
            await seedLabel(tx, cid, name);
            expectKeys.push(`${cid}|${name}`);
          }
        }
      }
      expectKeys.sort();

      const d = deps(tx, 3);
      const pages: any[][] = [];
      let since: string | null = null;
      for (let i = 0; i < 20; i++) {
        const res = await handleGetLabelsExport(
          get(`/api/labels/export${since ? `?since=${since}` : ""}`, authHeaders),
          d,
        );
        expect(res.status).toBe(200);
        const body = await bodyJson(res);
        pages.push(body.rows);
        // next_cursor is non-null on every non-empty page, null only on
        // the terminal empty page.
        if (body.rows.length > 0) expect(typeof body.next_cursor).toBe("string");
        else expect(body.next_cursor).toBeNull();
        if (body.next_cursor === null) break;
        since = body.next_cursor;
      }
      expect(pages[pages.length - 1]).toEqual([]);
      const all = pages.flat();
      expect(all).toHaveLength(16);
      const keys = all.map((r) => `${r.clip_id}|${r.trick_name}`);
      expect(new Set(keys).size).toBe(16);
      expect([...keys].sort()).toEqual(expectKeys);
    });
  });

  test("a page read in several cursor fetches is byte-identical to one fetch, and to Response.json", async () => {
    await inRollback(sharedSql!, async (tx) => {
      for (const ch of ["a", "b", "c"]) {
        await seedSource(tx, vid(ch));
        for (let c = 0; c < 2; c++) {
          const cid = clipId(ch.charCodeAt(0) * 10 + c);
          await seedClip(tx, cid, vid(ch), { proposalModelVersion: "trick-v1", suggestedNames: ["cork"] });
          await seedLabel(tx, cid, "cork");
          await seedLabel(tx, cid, "gainer");
        }
      }
      const read = async (d: ExportDeps) => {
        const res = await handleGetLabelsExport(get("/api/labels/export", authHeaders), d);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
        return res.text();
      };
      // 12 rows; a page of 10 read 3 rows at a time crosses fetch boundaries mid-page.
      const oneFetch = await read(deps(tx, 10));
      const manyFetches = await read(deps(tx, 10, 3));
      expect(manyFetches).toBe(oneFetch);
      const parsed = JSON.parse(oneFetch);
      expect(parsed.rows).toHaveLength(10);
      expect(oneFetch).toBe(JSON.stringify(parsed));
      // The cursor is closed: the same transaction can export again.
      expect(await read(deps(tx, 10, 3))).toBe(oneFetch);
    });
  });

  test("an export page waits while an ingest runs", async () => {
    await inRollback(sharedSql!, async (tx) => {
      let release!: () => void;
      const staged = new Promise<void>((resolve) => (release = resolve));
      const ingesting = ingestStagedSource(
        {
          store: {
            async get() {
              await staged;
              return null;
            },
            async put() {},
            async delete() {},
            async *listPages() {},
          },
          sources: {
            async get(id) {
              return { id, r2_key: canonicalKeyFor(id) };
            },
            async setSha256() {},
          },
        },
        vid("e"),
      );
      let answered = false;
      const exporting = handleGetLabelsExport(get("/api/labels/export", authHeaders), deps(tx)).finally(
        () => (answered = true),
      );
      await Bun.sleep(30);
      expect(answered).toBe(false);
      release();
      await ingesting;
      expect((await exporting).status).toBe(200);
    });
  });

  test("paginates sub-millisecond row_cursors with no gaps or dupes", async () => {
    // updated_at is TIMESTAMPTZ DEFAULT now(), so real rows carry
    // microseconds; a JS Date keeps only milliseconds. Seeds here differ
    // within one millisecond and tie exactly, and every page limit from
    // one row per page to the whole export in one page must return each
    // row once, in cursor order, with next_cursor advancing every page.
    // The source and clips sit at TS, so each row's cursor is its label's.
    const labelsAt: [number, string, string][] = [
      [0, "cork", "2026-10-15T12:00:00.123456Z"],
      [0, "gainer", "2026-10-15T12:00:00.123456Z"], // exact tie
      [1, "cork", "2026-10-15T12:00:00.123457Z"], // 1µs later, same ms
      [1, "gainer", "2026-10-15T12:00:00.123999Z"],
      [2, "cork", "2026-10-15T12:00:00.124001Z"],
      [2, "gainer", "2026-10-15T12:00:00.999999Z"],
    ];
    const expectKeys = labelsAt.map(([c, name]) => `${clipId(50 + c)}|${name}`);

    for (let limit = 1; limit <= labelsAt.length + 1; limit++) {
      await inRollback(sharedSql!, async (tx) => {
        const v = vid("9");
        await seedSource(tx, v);
        for (const c of [0, 1, 2]) await seedClip(tx, clipId(50 + c), v);
        for (const [c, name, at] of labelsAt) await seedLabel(tx, clipId(50 + c), name, { updatedAt: at });

        const d = deps(tx, limit);
        const keys: string[] = [];
        const cursors = new Set<string>();
        let since: string | null = null;
        for (let i = 0; i < 20; i++) {
          const res = await handleGetLabelsExport(
            get(`/api/labels/export${since ? `?since=${since}` : ""}`, authHeaders),
            d,
          );
          expect(res.status).toBe(200);
          const body = await bodyJson(res);
          keys.push(...body.rows.map((r: any) => `${r.clip_id}|${r.trick_name}`));
          if (body.rows.length === 0) {
            // The terminal page: re-querying with the final cursor is empty.
            expect(since).not.toBeNull();
            expect(body.next_cursor).toBeNull();
            break;
          }
          expect(typeof body.next_cursor).toBe("string");
          expect(cursors.has(body.next_cursor)).toBe(false);
          cursors.add(body.next_cursor);
          since = body.next_cursor;
        }
        expect(keys).toEqual(expectKeys);
        expect(cursors.size).toBe(Math.ceil(labelsAt.length / limit));
      });
    }
  });

  test("quarantined sources are excluded; released sources rejoin", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const v = vid("e");
      await seedSource(tx, v);
      await seedClip(tx, clipId(41), v);
      await seedLabel(tx, clipId(41), "cork");

      const d = deps(tx);
      const rowsOf = async () => (await bodyJson(await handleGetLabelsExport(get("/api/labels/export", authHeaders), d))).rows;
      expect(await rowsOf()).toHaveLength(1);

      await tx`INSERT INTO data_quarantine (source_id, reason) VALUES (${v}, 'fixture regression')`;
      expect(await rowsOf()).toHaveLength(0);

      await tx`UPDATE data_quarantine SET resolved_at = now(), resolution = 'released' WHERE source_id = ${v}`;
      expect(await rowsOf()).toHaveLength(1);
    });
  });

  test("sources without an ingested blob are excluded", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const v = vid("f");
      await seedSource(tx, v, { sha256: null });
      await seedClip(tx, clipId(42), v);
      await seedLabel(tx, clipId(42), "cork");
      const res = await handleGetLabelsExport(get("/api/labels/export", authHeaders), deps(tx));
      expect((await bodyJson(res)).rows).toHaveLength(0);
    });
  });

  test("trick_contributors counts distinct attributed accounts per canonical trick over sources", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const labeled = async (ch: string, n: number, names: string[], user: string | null) => {
        await seedSource(tx, vid(ch));
        if (user) await attribute(tx, vid(ch), user);
        await seedClip(tx, clipId(n), vid(ch));
        for (const name of names) await seedLabel(tx, clipId(n), name);
      };
      // cork and its alias corkscrew are one canonical: u1 (on two sources) and u2 → 2.
      await labeled("a", 1, ["cork", "gainer"], "u1");
      await labeled("b", 2, ["Corkscrew"], "u1");
      await labeled("c", 3, ["cork", "Legacy Name"], "u2");
      // u3's source is quarantined: it counts for nobody while it is.
      await labeled("d", 4, ["hook", "cork"], "u3");
      await tx`INSERT INTO data_quarantine (source_id, reason) VALUES (${vid("d")}, 'fixture regression')`;
      // A source with no attribution exports but counts for nobody.
      await labeled("e", 5, ["cork", "scoot"], null);
      // A source not ingested yet is not exported, so it counts for nobody either.
      await seedSource(tx, vid("f"), { sha256: null });
      await attribute(tx, vid("f"), "u4");
      await seedClip(tx, clipId(6), vid("f"));
      await seedLabel(tx, clipId(6), "cork");

      const body = await pull(tx);
      expect(body.rows.map((r: any) => r.source_id).sort()).toEqual(
        [vid("a"), vid("a"), vid("b"), vid("c"), vid("c"), vid("e"), vid("e")].sort(),
      );
      expect(body.trick_contributors).toEqual([
        { canonical: "cork", contributors: 2 },
        { canonical: "gainer", contributors: 1 },
        { canonical: "legacy name", contributors: 1 },
      ]);
      expect(JSON.stringify(body)).not.toMatch(/"u[1-4]"/);

      // Released from quarantine, u3 counts again.
      await tx`UPDATE data_quarantine SET resolved_at = now(), resolution = 'released' WHERE source_id = ${vid("d")}`;
      expect((await pull(tx)).trick_contributors).toContainEqual({ canonical: "cork", contributors: 3 });

      // A rename at a later version moves the count to the new canonical.
      await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES
        ('cork', 'corkscrew', 2), ('corkscrew', 'corkscrew', 2)`;
      expect((await pull(tx)).trick_contributors[0]).toEqual({ canonical: "corkscrew", contributors: 3 });
    });
  });

  test("trick_contributors counts every exported row, not only this page's", async () => {
    await inRollback(sharedSql!, async (tx) => {
      for (const [i, ch] of ["a", "b", "c"].entries()) {
        await seedSource(tx, vid(ch));
        await attribute(tx, vid(ch), `u${i}`);
        await seedClip(tx, clipId(i), vid(ch));
        await seedLabel(tx, clipId(i), "cork");
      }
      const res = await handleGetLabelsExport(get("/api/labels/export", authHeaders), deps(tx, 1));
      const body = await bodyJson(res);
      expect(body.rows).toHaveLength(1);
      expect(body.trick_contributors).toEqual([{ canonical: "cork", contributors: 3 }]);
    });
  });

  test("each row's canonical resolves by normalized name: raw first, else a canonical itself", async () => {
    await inRollback(sharedSql!, async (tx) => {
      // "raiz flip" is a canonical with no raw row of its own (labels:promote raiz "raiz flip").
      await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES ('raiz', 'raiz flip', 2)`;
      await seedSource(tx, vid("a"));
      await attribute(tx, vid("a"), "u1");
      await seedClip(tx, clipId(1), vid("a"));
      for (const name of ["Raiz  Flip", "CorkScrew", "legacy  Name"]) await seedLabel(tx, clipId(1), name);
      // ASCII whitespace (VT, FF) collapses; a no-break space doesn't, so no match.
      await seedSource(tx, vid("b"));
      await seedClip(tx, clipId(2), vid("b"));
      for (const name of ["raiz\u000b\fflip", "Raiz\u00a0Flip"]) await seedLabel(tx, clipId(2), name);

      const body = await pull(tx);
      const canonicalOf = Object.fromEntries(body.rows.map((r: any) => [r.trick_name, r.canonical]));
      expect(canonicalOf).toEqual({
        CorkScrew: "cork",
        "Raiz  Flip": "raiz flip",
        "legacy  Name": null,
        "raiz\u000b\fflip": "raiz flip",
        "Raiz\u00a0Flip": null,
      });
      expect(body.trick_contributors).toEqual([
        { canonical: "cork", contributors: 1 },
        { canonical: "legacy name", contributors: 1 },
        { canonical: "raiz flip", contributors: 1 },
      ]);
    });
  });

  test("holdout rides on every row of a flagged source, and its contributor isn't counted", async () => {
    await inRollback(sharedSql!, async (tx) => {
      // u1 contributes cork on an ordinary source; u2 only on a holdout source.
      await seedSource(tx, vid("a"));
      await attribute(tx, vid("a"), "u1");
      await seedClip(tx, clipId(1), vid("a"));
      await seedLabel(tx, clipId(1), "cork");
      await seedSource(tx, vid("b"));
      await attribute(tx, vid("b"), "u2");
      for (const n of [2, 3]) {
        await seedClip(tx, clipId(n), vid("b"));
        await seedLabel(tx, clipId(n), "cork");
      }
      await seedLabel(tx, clipId(3), "gainer");
      await tx`UPDATE sources SET holdout = true WHERE id = ${vid("b")}`;

      const body = await pull(tx);
      const holdoutBySource = body.rows.map((r: any) => [r.source_id, r.clip_id, r.holdout]);
      expect(holdoutBySource.sort()).toEqual(
        [
          [vid("a"), clipId(1), false],
          [vid("b"), clipId(2), true],
          [vid("b"), clipId(3), true],
          [vid("b"), clipId(3), true],
        ].sort(),
      );
      // gainer is held out entirely, so nobody counts for it.
      expect(body.trick_contributors).toEqual([{ canonical: "cork", contributors: 1 }]);

      await tx`UPDATE sources SET holdout = false WHERE id = ${vid("b")}`;
      expect((await pull(tx)).trick_contributors).toEqual([
        { canonical: "cork", contributors: 2 },
        { canonical: "gainer", contributors: 1 },
      ]);
    });
  });
});
