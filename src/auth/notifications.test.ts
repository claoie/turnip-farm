// POST /api/auth/apple/notifications, DB-backed (BACKEND_DESIGN.md §7.3).
// Runs inside a rolled-back transaction per db/testing.ts; only runs when
// TEST_DATABASE_URL names a database.

import { SQL, type TransactionSQL } from "bun";
import { generateKeyPair } from "jose";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../../db/testing";
import type { R2Client } from "../r2/client";
import { createAppleJwtVerifier, InvalidTokenError } from "./apple";
import { handleAppleNotifications, type NotificationsDeps } from "./notifications";
import { AUDIENCE, SUB, startMockApple, testCandidateKey, type MockApple } from "./testing";
import { encryptRefreshToken, importRefreshTokenKey, sha256Hex } from "./tokens";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : (null as unknown as SQL);
afterAll(async () => {
  await sharedSql?.end();
});

const apple: MockApple = await startMockApple();
afterAll(() => apple.stop());
afterEach(() => apple.reset());

const verifyNotificationPayload = createAppleJwtVerifier({
  audience: AUDIENCE,
  jwksUrl: apple.jwksUrl,
  requireExp: false,
});

// Fixture bearer value for these tests only — never a real credential.
const SESSION_TOKEN = ["session", "token", "for", "notifications", "test"].join("-");
const SOURCE_ID = "d".repeat(64);

function fakeR2(opts: { failDelete?: boolean } = {}): R2Client & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    presignPut: () => {
      throw new Error("not used");
    },
    presignGet: () => {
      throw new Error("not used");
    },
    getBytes: () => {
      throw new Error("not used");
    },
    deleteObject: async (key: string) => {
      if (opts.failDelete) throw new Error("r2 down");
      deleted.push(key);
    },
  };
}

function deps(tx: SQL, r2: R2Client): NotificationsDeps {
  return { sql: tx, r2, verifyNotificationPayload, candidateKey: testCandidateKey };
}

const post = (body: unknown) =>
  new Request("http://farm.test/api/auth/apple/notifications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const events = (type: string, sub: string = SUB) => ({ type, sub, event_time: 1508184845 });

async function seedUser(tx: TransactionSQL, userId: string = SUB) {
  const refreshKey = await importRefreshTokenKey(crypto.getRandomValues(new Uint8Array(32)));
  const sealed = await encryptRefreshToken(refreshKey, userId, "apple-refresh-token-fixture");
  await tx`INSERT INTO users (id, apple_refresh_token) VALUES (${userId}, ${sealed})`;
  await tx`INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${sha256Hex(SESSION_TOKEN)}, now() + interval '1 hour')`;
}

async function seedSource(tx: TransactionSQL, sourceId: string, userId: string) {
  await tx`INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, r2_key)
    VALUES (${sourceId}, ${sha256Hex("source-key")}, 100, 30.0, ${`poses/${sourceId}.tkp1.gz`})`;
  await tx`INSERT INTO source_attribution (source_id, user_id) VALUES (${sourceId}, ${userId})`;
}

describeDb("POST /api/auth/apple/notifications", () => {
  test("422 when the payload is missing or not a string", async () =>
    inRollback(sharedSql, async (tx) => {
      for (const body of [{}, { payload: 42 }, { payload: "" }]) {
        const res = await handleAppleNotifications(post(body), deps(tx, fakeR2()));
        expect(res.status).toBe(422);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
      }
    }));

  test("401 on a forged payload", async () =>
    inRollback(sharedSql, async (tx) => {
      const other = await generateKeyPair("RS256");
      const forged = await apple.notificationPayload({ key: other.privateKey, claims: { events: events("consent-revoked") } });
      const res = await handleAppleNotifications(post({ payload: forged }), deps(tx, fakeR2()));
      expect(res.status).toBe(401);
    }));

  test("401 on the wrong audience", async () =>
    inRollback(sharedSql, async (tx) => {
      const wrong = await apple.notificationPayload({ claims: { aud: "com.example.other", events: events("consent-revoked") } });
      const res = await handleAppleNotifications(post({ payload: wrong }), deps(tx, fakeR2()));
      expect(res.status).toBe(401);
    }));

  test("an `exp` is still enforced when present", async () =>
    inRollback(sharedSql, async (tx) => {
      const stale = await apple.notificationPayload({
        claims: { exp: Math.floor(Date.now() / 1000) - 120, events: events("consent-revoked") },
      });
      const res = await handleAppleNotifications(post({ payload: stale }), deps(tx, fakeR2()));
      expect(res.status).toBe(401);
    }));

  test("a JWKS outage propagates (the server answers 500, not 401)", async () =>
    inRollback(sharedSql, async (tx) => {
      const dead = Bun.serve({ port: 0, fetch: () => new Response("down", { status: 500 }) });
      try {
        const verify = createAppleJwtVerifier({ audience: AUDIENCE, jwksUrl: dead.url, requireExp: false });
        const payload = await apple.notificationPayload({ claims: { events: events("consent-revoked") } });
        const err = await handleAppleNotifications(post({ payload }), {
          sql: tx,
          r2: fakeR2(),
          candidateKey: testCandidateKey,
          verifyNotificationPayload: verify,
        }).then(
          () => {
            throw new Error("expected a rejection");
          },
          (e) => e,
        );
        expect(err).not.toBeInstanceOf(InvalidTokenError);
      } finally {
        dead.stop(true);
      }
    }));

  test("consent-revoked ends sessions and clears the refresh token; contributions stay", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      await seedSource(tx, SOURCE_ID, SUB);
      const payload = await apple.notificationPayload({ claims: { events: events("consent-revoked") } });
      const res = await handleAppleNotifications(post({ payload }), deps(tx, fakeR2()));
      expect(res.status).toBe(200);

      const sessions = await tx`SELECT id FROM sessions WHERE user_id = ${SUB}`;
      expect(sessions).toEqual([]);
      const [user] = await tx`SELECT id, apple_refresh_token FROM users WHERE id = ${SUB}`;
      expect(user?.id).toBe(SUB);
      expect(user?.apple_refresh_token).toBeNull();
      const [source] = await tx`SELECT id FROM sources WHERE id = ${SOURCE_ID}`;
      expect(source?.id).toBe(SOURCE_ID);
    }));

  test("unknown sub is a no-op", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      const payload = await apple.notificationPayload({ claims: { events: events("consent-revoked", "unknown-sub") } });
      const res = await handleAppleNotifications(post({ payload }), deps(tx, fakeR2()));
      expect(res.status).toBe(200);
      const sessions = await tx`SELECT id FROM sessions WHERE user_id = ${SUB}`;
      expect(sessions).toHaveLength(1);
    }));

  test("account-deleted removes the attributed sources and the user", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      await seedSource(tx, SOURCE_ID, SUB);
      const r2 = fakeR2();
      const payload = await apple.notificationPayload({ claims: { events: events("account-deleted") } });
      const res = await handleAppleNotifications(post({ payload }), deps(tx, r2));
      expect(res.status).toBe(200);

      expect(r2.deleted).toEqual([`poses/${SOURCE_ID}.tkp1.gz`, `staging/${SOURCE_ID}.tkp1.gz`]);
      const [source] = await tx`SELECT id FROM sources WHERE id = ${SOURCE_ID}`;
      expect(source).toBeUndefined();
      const [user] = await tx`SELECT id FROM users WHERE id = ${SUB}`;
      expect(user).toBeUndefined();
    }));

  test("account-deleted with R2 down → 500, rows survive", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      await seedSource(tx, SOURCE_ID, SUB);
      const payload = await apple.notificationPayload({ claims: { events: events("account-deleted") } });
      const res = await handleAppleNotifications(post({ payload }), deps(tx, fakeR2({ failDelete: true })));
      expect(res.status).toBe(500);
      const [user] = await tx`SELECT id FROM users WHERE id = ${SUB}`;
      expect(user?.id).toBe(SUB);
      const [source] = await tx`SELECT id FROM sources WHERE id = ${SOURCE_ID}`;
      expect(source?.id).toBe(SOURCE_ID);
    }));

  test.each(["email-enabled", "email-disabled"])("%s is ignored", async (type) =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      const payload = await apple.notificationPayload({ claims: { events: events(type) } });
      const res = await handleAppleNotifications(post({ payload }), deps(tx, fakeR2()));
      expect(res.status).toBe(200);
      const sessions = await tx`SELECT id FROM sessions WHERE user_id = ${SUB}`;
      expect(sessions).toHaveLength(1);
      const [user] = await tx`SELECT apple_refresh_token FROM users WHERE id = ${SUB}`;
      expect(user?.apple_refresh_token).not.toBeNull();
    }),
  );

  test("an unknown event type is a no-op", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      const payload = await apple.notificationPayload({ claims: { events: events("transfer-update") } });
      const res = await handleAppleNotifications(post({ payload }), deps(tx, fakeR2()));
      expect(res.status).toBe(200);
      const sessions = await tx`SELECT id FROM sessions WHERE user_id = ${SUB}`;
      expect(sessions).toHaveLength(1);
    }));

  test("events arriving as a JSON-encoded string are parsed", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      const payload = await apple.notificationPayload({ claims: { events: JSON.stringify(events("consent-revoked")) } });
      const res = await handleAppleNotifications(post({ payload }), deps(tx, fakeR2()));
      expect(res.status).toBe(200);
      const sessions = await tx`SELECT id FROM sessions WHERE user_id = ${SUB}`;
      expect(sessions).toEqual([]);
    }));

  test("malformed events are a no-op", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx);
      for (const bad of ["not json", {}, { type: "consent-revoked" }, { sub: SUB }, null]) {
        const payload = await apple.notificationPayload({ claims: { events: bad } });
        const res = await handleAppleNotifications(post({ payload }), deps(tx, fakeR2()));
        expect(res.status).toBe(200);
      }
      const sessions = await tx`SELECT id FROM sessions WHERE user_id = ${SUB}`;
      expect(sessions).toHaveLength(1);
    }));
});
