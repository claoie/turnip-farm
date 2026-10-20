// POST /api/reports (BACKEND_DESIGN.md §7.3). The DB-backed cases run inside
// a rolled-back transaction per db/testing.ts, only when TEST_DATABASE_URL
// names a database.

import { SQL, type TransactionSQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../db/testing";
import { noDatabase } from "./auth/testing";
import { sha256Hex } from "./auth/tokens";
import { purgeExpiredAttribution } from "./contrib/purge";
import { TokenBucket } from "./ratelimit";
import { handlePostReport, type ReportsDeps } from "./reports";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : (null as unknown as SQL);
afterAll(async () => {
  await sharedSql?.end();
});

const USER_ID = "001234.0123456789abcdef0123456789abcdef.0123";
// Fixture bearer value for these tests only — never a real credential.
const SESSION_TOKEN = ["session", "token", "for", "reports", "test"].join("-");
const VIDEO_ID = "a".repeat(64);
const CLIP_ID = "123e4567-e89b-42d3-a456-426614174000";

function deps(sql: SQL, user = new TokenBucket(1000, 60000)): ReportsDeps {
  return {
    sql,
    limits: { user, ip: new TokenBucket(1000, 60000), publicIp: new TokenBucket(1000, 60000) },
  };
}

const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${SESSION_TOKEN}` }) =>
  new Request("http://farm.test/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const VALID = { target_type: "clip", target_id: CLIP_ID, reason: "wrong trick name" };

async function seedUser(tx: TransactionSQL, opts: { blocked?: boolean } = {}) {
  await tx`INSERT INTO users (id, is_blocked) VALUES (${USER_ID}, ${opts.blocked ?? false})`;
  await tx`INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${USER_ID}, ${sha256Hex(SESSION_TOKEN)}, now() + interval '1 hour')`;
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
}

describe("POST /api/reports without a database", () => {
  test("401 without a session token, before any DB touch", async () => {
    await expectError(await handlePostReport(post(VALID, {}), deps(noDatabase)), 401, "UNAUTHENTICATED");
  });
});

describeDb("POST /api/reports", () => {
  test("files an open report against the caller and returns 201 {id}", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      const res = await handlePostReport(post({ ...VALID, reason: "  wrong trick name  " }), deps(tx));
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      expect(Object.keys(body)).toEqual(["id"]);
      const [report] = await tx`SELECT * FROM reports WHERE id = ${body.id}`;
      expect(report).toMatchObject({
        reporter_user_id: USER_ID,
        target_type: "clip",
        target_id: CLIP_ID,
        reason: "wrong trick name",
        status: "open",
      });
    }));

  test("accepts every target type, without checking that the target exists", async () =>
    inRollback(sharedSql, async (tx) => {
      // No source, clip, or label rows are seeded: an existence check would
      // make target ids an existence oracle (§7.2).
      await seedUser(tx);
      for (const [type, id] of [
        ["source", VIDEO_ID],
        ["clip", CLIP_ID],
        ["label", "223e4567-e89b-42d3-a456-426614174000"],
      ]) {
        const res = await handlePostReport(post({ target_type: type, target_id: id, reason: "r" }), deps(tx));
        expect(res.status).toBe(201);
      }
      const rows = await tx`SELECT target_type FROM reports ORDER BY target_type`;
      expect(rows.map((r: { target_type: string }) => r.target_type)).toEqual(["clip", "label", "source"]);
    }));

  test("stores an upper-case UUID in Postgres's lower-case form", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      const res = await handlePostReport(post({ ...VALID, target_id: CLIP_ID.toUpperCase() }), deps(tx));
      expect(res.status).toBe(201);
      const [report] = await tx`SELECT target_id FROM reports`;
      expect(report.target_id).toBe(CLIP_ID);
    }));

  test("401 with an unknown session token", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      const res = await handlePostReport(post(VALID, { authorization: "Bearer nope" }), deps(tx));
      await expectError(res, 401, "UNAUTHENTICATED");
    }));

  test("403 ACCOUNT_BLOCKED for a blocked account, with nothing filed", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx, { blocked: true });
      await expectError(await handlePostReport(post(VALID), deps(tx)), 403, "ACCOUNT_BLOCKED");
      expect(await tx`SELECT id FROM reports`).toHaveLength(0);
    }));

  test.each([
    ["a non-object body", "[1]"],
    ["a body that is not JSON", "{"],
    ["an unknown target_type", { ...VALID, target_type: "video" }],
    ["a missing target_type", { target_id: CLIP_ID, reason: "r" }],
    ["a source target_id that is not a video id", { ...VALID, target_type: "source", target_id: CLIP_ID }],
    ["a clip target_id that is not a UUID", { ...VALID, target_id: VIDEO_ID }],
    ["a label target_id that is not a UUID", { ...VALID, target_type: "label", target_id: "1" }],
    ["a missing target_id", { target_type: "clip", reason: "r" }],
    ["a blank reason", { ...VALID, reason: "   " }],
    ["a non-string reason", { ...VALID, reason: 3 }],
    ["a reason over 1000 characters", { ...VALID, reason: "x".repeat(1001) }],
  ])("422 VALIDATION_ERROR for %s", async (_name, body) =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      await expectError(await handlePostReport(post(body), deps(tx)), 422, "VALIDATION_ERROR");
      expect(await tx`SELECT id FROM reports`).toHaveLength(0);
    }));

  test("429 RATE_LIMITED with Retry-After once the per-user bucket is empty", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      const d = deps(tx, new TokenBucket(1, 1));
      expect((await handlePostReport(post(VALID), d)).status).toBe(201);
      const res = await handlePostReport(post(VALID), d);
      expect(res.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);
      await expectError(res, 429, "RATE_LIMITED");
      expect(await tx`SELECT id FROM reports`).toHaveLength(1);
    }));

  test("a filed report is in the open queue until the 30-day purge removes it", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      const { id } = (await (await handlePostReport(post(VALID), deps(tx))).json()) as { id: string };
      const openQueue = () => tx`SELECT id FROM reports WHERE status = 'open' ORDER BY created_at`;
      expect(await openQueue()).toEqual([{ id }]);

      await tx`UPDATE reports SET created_at = now() - interval '29 days' WHERE id = ${id}`;
      await purgeExpiredAttribution(tx);
      expect(await openQueue()).toEqual([{ id }]);

      await tx`UPDATE reports SET created_at = now() - interval '31 days' WHERE id = ${id}`;
      await purgeExpiredAttribution(tx);
      expect(await openQueue()).toEqual([]);
    }));
});
