// POST /api/consent and the consent gate on contribution writes, DB-backed
// (BACKEND_DESIGN.md §7.3). Runs inside a rolled-back transaction per
// db/testing.ts; only runs when TEST_DATABASE_URL names a database.

import { SQL, type TransactionSQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../db/testing";
import { sha256Hex } from "./auth/tokens";
import { handlePostConsent } from "./consent";
import { handlePostClipLabels, handlePostClips } from "./contrib/clips";
import { handleRegisterSource } from "./contrib/sources";
import type { R2Client } from "./r2/client";
import { TokenBucket } from "./ratelimit";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : (null as unknown as SQL);
afterAll(async () => {
  await sharedSql?.end();
});

const USER_ID = "u1";
const TOKEN = "session-for-u1"; // fixture, not a credential
const VIDEO_ID = "a".repeat(64);
const SOURCE_KEY = "xxx".repeat(14) + "x"; // 43-char fixture, not a secret
const CLIP_ID = "123e4567-e89b-42d3-a456-426614174000";

const noR2: R2Client = {
  presignPut: (key) => ({ url: `https://r2.test/put/${key}`, expiresAt: new Date("2026-11-13T00:15:00Z") }),
  presignGet: () => {
    throw new Error("not used");
  },
  getBytes: () => {
    throw new Error("not used");
  },
  deleteObject: () => {
    throw new Error("not used");
  },
};

function deps(tx: SQL, userCapacity = 1000) {
  return {
    sql: tx,
    r2: noR2,
    currentDisclosureVersion: 3,
    limits: {
      user: new TokenBucket(userCapacity, 1),
      ip: new TokenBucket(1000, 60),
      publicIp: new TokenBucket(1000, 60),
    },
  };
}

async function seedUser(tx: TransactionSQL) {
  await tx`INSERT INTO users (id) VALUES (${USER_ID})`;
  await tx`INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${USER_ID}, ${sha256Hex(TOKEN)}, now() + interval '1 hour')`;
}

function post(path: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  return new Request(`http://farm.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function errorOf(res: Response): Promise<{ status: number; code: string; details: unknown }> {
  const body = (await res.json()) as { error: { code: string; details: unknown } };
  return { status: res.status, code: body.error.code, details: body.error.details };
}

const consents = (tx: SQL) =>
  tx`SELECT disclosure_version, agreed_at FROM consents WHERE user_id = ${USER_ID} ORDER BY disclosure_version`;

const registration = {
  video_id: VIDEO_ID,
  source_key: SOURCE_KEY,
  frame_count: 600,
  sample_rate: 10,
  keypoint_format: "tkp1",
};

describeDb("POST /api/consent", () => {
  test("204 records the agreement; agreeing again keeps the first agreed_at", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      const d = deps(tx);
      const res = await handlePostConsent(post("/api/consent", { disclosure_version: 3, age_confirmed: true }), d);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      const [first] = await consents(tx);
      expect(first.disclosure_version).toBe(3);

      await tx`UPDATE consents SET agreed_at = '2026-11-01T00:00:00Z' WHERE user_id = ${USER_ID}`;
      const again = await handlePostConsent(post("/api/consent", { disclosure_version: 3, age_confirmed: true }), d);
      expect(again.status).toBe(204);
      const rows = await consents(tx);
      expect(rows).toHaveLength(1);
      expect((rows[0].agreed_at as Date).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    }));

  test("422 VALIDATION_ERROR unless age_confirmed is exactly true; nothing recorded", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      const d = deps(tx);
      for (const body of [
        { disclosure_version: 3 },
        { disclosure_version: 3, age_confirmed: false },
        { disclosure_version: 3, age_confirmed: "true" },
        { disclosure_version: 3, age_confirmed: 1 },
      ]) {
        expect(await errorOf(await handlePostConsent(post("/api/consent", body), d))).toEqual({
          status: 422,
          code: "VALIDATION_ERROR",
          details: { field: "age_confirmed" },
        });
      }
      expect(await consents(tx)).toHaveLength(0);
    }));

  test("422 VALIDATION_ERROR for a missing or non-positive-integer disclosure_version", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      const d = deps(tx);
      for (const version of [undefined, 0, -1, 2.5, "3", 2_147_483_648]) {
        const res = await handlePostConsent(post("/api/consent", { disclosure_version: version, age_confirmed: true }), d);
        expect(await errorOf(res)).toEqual({
          status: 422,
          code: "VALIDATION_ERROR",
          details: { field: "disclosure_version" },
        });
      }
      expect(await consents(tx)).toHaveLength(0);
    }));

  test("401 without a session; 429 when the per-user bucket is empty", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      const body = { disclosure_version: 3, age_confirmed: true };
      expect((await handlePostConsent(post("/api/consent", body, {}), deps(tx))).status).toBe(401);
      const d = deps(tx, 1);
      expect((await handlePostConsent(post("/api/consent", body), d)).status).toBe(204);
      expect((await errorOf(await handlePostConsent(post("/api/consent", body), d))).code).toBe("RATE_LIMITED");
    }));

  test("403 REGION_UNAVAILABLE from a blocked country, before authentication", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      const body = { disclosure_version: 3, age_confirmed: true };
      const res = await handlePostConsent(post("/api/consent", body, { "cf-ipcountry": "FR" }), deps(tx));
      expect((await errorOf(res)).code).toBe("REGION_UNAVAILABLE");
      expect(res.status).toBe(403);
      expect(await consents(tx)).toHaveLength(0);
    }));
});

describeDb("the consent gate on contribution writes", () => {
  test("POST /api/sources: 403 CONSENT_REQUIRED under an older version, 201 after agreeing to the current one", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      const d = deps(tx);
      expect(await errorOf(await handleRegisterSource(post("/api/sources", registration), d))).toEqual({
        status: 403,
        code: "CONSENT_REQUIRED",
        details: { disclosure_version: 3 },
      });
      await tx`INSERT INTO consents (user_id, disclosure_version) VALUES (${USER_ID}, 2)`;
      expect((await errorOf(await handleRegisterSource(post("/api/sources", registration), d))).code).toBe(
        "CONSENT_REQUIRED",
      );
      expect(await tx`SELECT id FROM sources`).toHaveLength(0);

      await handlePostConsent(post("/api/consent", { disclosure_version: 3, age_confirmed: true }), d);
      expect((await handleRegisterSource(post("/api/sources", registration), d)).status).toBe(201);
    }));

  test("a later version satisfies the current one", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      await tx`INSERT INTO consents (user_id, disclosure_version) VALUES (${USER_ID}, 4)`;
      expect((await handleRegisterSource(post("/api/sources", registration), deps(tx))).status).toBe(201);
    }));

  test("POST /api/clips and POST /api/clips/:id/labels: 403 CONSENT_REQUIRED before anything is read", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      const d = deps(tx);
      const clips = await handlePostClips(post("/api/clips", { clips: [] }), d);
      expect(await errorOf(clips)).toEqual({ status: 403, code: "CONSENT_REQUIRED", details: { disclosure_version: 3 } });
      const labels = await handlePostClipLabels(
        post(`/api/clips/${CLIP_ID}/labels`, { source_key: SOURCE_KEY, labels: [] }),
        d,
        CLIP_ID,
      );
      expect((await errorOf(labels)).code).toBe("CONSENT_REQUIRED");

      await tx`INSERT INTO consents (user_id, disclosure_version) VALUES (${USER_ID}, 3)`;
      expect((await handlePostClips(post("/api/clips", { clips: [] }), d)).status).not.toBe(403);
    }));
});
