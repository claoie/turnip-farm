// DELETE /api/account, DB-backed (BACKEND_DESIGN.md §7.3).
// Runs inside a rolled-back transaction per db/testing.ts; only runs when
// TEST_DATABASE_URL names a database.

import { SQL, type TransactionSQL } from "bun";
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../../db/testing";
import type { R2Client } from "../r2/client";
import { AppleUnavailableError } from "./apple";
import { IDLE_ACCOUNT_MONTHS, deleteIdleAccounts, handleDeleteAccount, type AccountDeps } from "./account";
import { authenticateClient } from "./sessions";
import { testCandidateKey } from "./testing";
import { encryptRefreshToken, importRefreshTokenKey, sha256Hex } from "./tokens";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : (null as unknown as SQL);
afterAll(async () => {
  await sharedSql?.end();
});

const USER_ID = "001234.0123456789abcdef0123456789abcdef.0123";
const OTHER_USER = "009999.0123456789abcdef0123456789abcdef.0999";
// Fixture bearer/refresh values for these tests only — never real credentials.
const SESSION_TOKEN = ["session", "token", "for", "deletion", "test"].join("-");
const REFRESH_TOKEN = ["apple", "refresh", "token", "fixture"].join("-");
const SOURCE_ID = "a".repeat(64);
const OLD_SOURCE_ID = "b".repeat(64);
const OTHER_SOURCE_ID = "c".repeat(64);
const CLIP_ID = "123e4567-e89b-42d3-a456-426614174000";

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

const authed = (token: string) => ({ authorization: `Bearer ${token}` });
const del = (headers: Record<string, string> = {}) =>
  new Request("http://farm.test/api/account", { method: "DELETE", headers });

async function seedUser(tx: TransactionSQL, userId: string, opts: { blocked?: boolean; refreshToken?: boolean } = {}) {
  const refreshKey = await importRefreshTokenKey(crypto.getRandomValues(new Uint8Array(32)));
  const sealed = opts.refreshToken === false ? null : await encryptRefreshToken(refreshKey, userId, REFRESH_TOKEN);
  await tx`INSERT INTO users (id, is_blocked, apple_refresh_token) VALUES (${userId}, ${opts.blocked ?? false}, ${sealed})`;
  const token = `${SESSION_TOKEN}-${userId.slice(-4)}`;
  await tx`INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${sha256Hex(token)}, now() + interval '1 hour')`;
  return { token, refreshKey };
}

async function seedSource(tx: TransactionSQL, sourceId: string, userId: string, old = false) {
  await tx`INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, r2_key)
    VALUES (${sourceId}, ${sha256Hex("source-key")}, 100, 30.0, ${`poses/${sourceId}.tkp1.gz`})`;
  if (old) {
    await tx`INSERT INTO source_attribution (source_id, user_id, attributed_at)
      VALUES (${sourceId}, ${userId}, now() - interval '40 days')`;
  } else {
    await tx`INSERT INTO source_attribution (source_id, user_id) VALUES (${sourceId}, ${userId})`;
  }
}

type DepsOpts = {
  revoke?: (token: string) => Promise<void>;
  failR2Delete?: boolean;
};

function deps(tx: SQL, refreshKey: CryptoKey, r2: R2Client, opts: DepsOpts = {}): AccountDeps & { revoked: string[] } {
  const revoked: string[] = [];
  return {
    revoked,
    sql: tx,
    r2,
    refreshTokenKey: refreshKey,
    candidateKey: testCandidateKey,
    revokeRefreshToken:
      opts.revoke ??
      (async (token: string) => {
        revoked.push(token);
      }),
  };
}

describeDb("DELETE /api/account", () => {
  test("401 without a session token", async () =>
    inRollback(sharedSql, async (tx) => {
      const { refreshKey } = await seedUser(tx, USER_ID);
      const res = await handleDeleteAccount(del(), deps(tx, refreshKey, fakeR2()));
      expect(res.status).toBe(401);
    }));

  test("401 with an unknown session token", async () =>
    inRollback(sharedSql, async (tx) => {
      const { refreshKey } = await seedUser(tx, USER_ID);
      const res = await handleDeleteAccount(del(authed("nope")), deps(tx, refreshKey, fakeR2()));
      expect(res.status).toBe(401);
    }));

  test("a blocked user can still delete their account (§1.2.16)", async () =>
    inRollback(sharedSql, async (tx) => {
      const { token, refreshKey } = await seedUser(tx, USER_ID, { blocked: true });
      const r2 = fakeR2();
      const res = await handleDeleteAccount(del(authed(token)), deps(tx, refreshKey, r2));
      expect(res.status).toBe(204);
      const [user] = await tx`SELECT id FROM users WHERE id = ${USER_ID}`;
      expect(user).toBeUndefined();
    }));

  test("deletes the account end to end: revoke, every attributed source's blobs, cascades", async () =>
    inRollback(sharedSql, async (tx) => {
      const { token, refreshKey } = await seedUser(tx, USER_ID);
      await seedUser(tx, OTHER_USER);
      await seedSource(tx, SOURCE_ID, USER_ID);
      await seedSource(tx, OLD_SOURCE_ID, USER_ID, true);
      await seedSource(tx, OTHER_SOURCE_ID, OTHER_USER);
      await tx`INSERT INTO clips (id, source_id, start_frame, end_frame)
        VALUES (${CLIP_ID}::uuid, ${SOURCE_ID}, 0, 10)`;
      await tx`INSERT INTO labels (clip_id, trick_name, taxonomy_version)
        VALUES (${CLIP_ID}::uuid, 'backflip', 1)`;
      await tx`INSERT INTO reports (reporter_user_id, target_type, target_id, reason)
        VALUES (${USER_ID}, 'source', ${OTHER_SOURCE_ID}, 'test report')`;
      await tx`INSERT INTO consents (user_id, disclosure_version) VALUES (${USER_ID}, 3)`;

      const r2 = fakeR2();
      const d = deps(tx, refreshKey, r2);
      const res = await handleDeleteAccount(del(authed(token)), d);
      expect(res.status).toBe(204);

      // Apple saw the decrypted refresh token.
      expect(d.revoked).toEqual([REFRESH_TOKEN]);

      // Both attributed sources' canonical blobs and staged uploads are
      // gone, the 40-day-old one included (attribution is kept until
      // deletion, §1.2.17); the other user's source was never touched.
      expect(r2.deleted.toSorted()).toEqual([
        `poses/${SOURCE_ID}.tkp1.gz`,
        `poses/${OLD_SOURCE_ID}.tkp1.gz`,
        `staging/${SOURCE_ID}.tkp1.gz`,
        `staging/${OLD_SOURCE_ID}.tkp1.gz`,
      ]);

      // Source rows, clips, labels, and attribution cascade; the user row
      // takes sessions and reports with it.
      const [source] = await tx`SELECT id FROM sources WHERE id = ${SOURCE_ID}`;
      expect(source).toBeUndefined();
      const [clip] = await tx`SELECT id FROM clips WHERE id = ${CLIP_ID}::uuid`;
      expect(clip).toBeUndefined();
      const [old] = await tx`SELECT id FROM sources WHERE id = ${OLD_SOURCE_ID}`;
      expect(old).toBeUndefined();
      const [other] = await tx`SELECT id FROM sources WHERE id = ${OTHER_SOURCE_ID}`;
      expect(other?.id).toBe(OTHER_SOURCE_ID);
      const [user] = await tx`SELECT id FROM users WHERE id = ${USER_ID}`;
      expect(user).toBeUndefined();
      const [otherUser] = await tx`SELECT id FROM users WHERE id = ${OTHER_USER}`;
      expect(otherUser?.id).toBe(OTHER_USER);
      const sessions = await tx`SELECT id FROM sessions WHERE user_id = ${USER_ID}`;
      expect(sessions).toEqual([]);
      const reports = await tx`SELECT id FROM reports WHERE reporter_user_id = ${USER_ID}`;
      expect(reports).toEqual([]);
      const consents = await tx`SELECT disclosure_version FROM consents WHERE user_id = ${USER_ID}`;
      expect(consents).toEqual([]);
    }));

  test("Apple unreachable → 503 APPLE_UNAVAILABLE with nothing deleted", async () =>
    inRollback(sharedSql, async (tx) => {
      const { token, refreshKey } = await seedUser(tx, USER_ID);
      await seedSource(tx, SOURCE_ID, USER_ID);
      const r2 = fakeR2();
      const res = await handleDeleteAccount(
        del(authed(token)),
        deps(tx, refreshKey, r2, {
          revoke: () => Promise.reject(new AppleUnavailableError("down")),
        }),
      );
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("APPLE_UNAVAILABLE");
      const [user] = await tx`SELECT id FROM users WHERE id = ${USER_ID}`;
      expect(user?.id).toBe(USER_ID);
      const [source] = await tx`SELECT id FROM sources WHERE id = ${SOURCE_ID}`;
      expect(source?.id).toBe(SOURCE_ID);
      expect(r2.deleted).toEqual([]);
    }));

  test("Apple answering 4xx → logged, deletion proceeds", async () =>
    inRollback(sharedSql, async (tx) => {
      const logged = spyOn(console, "error").mockImplementation(() => {});
      try {
        const { token, refreshKey } = await seedUser(tx, USER_ID);
        const res = await handleDeleteAccount(
          del(authed(token)),
          deps(tx, refreshKey, fakeR2(), {
            revoke: () => Promise.reject(new Error("Apple's revoke endpoint answered 400")),
          }),
        );
        expect(res.status).toBe(204);
        expect(logged).toHaveBeenCalled();
        const [user] = await tx`SELECT id FROM users WHERE id = ${USER_ID}`;
        expect(user).toBeUndefined();
      } finally {
        logged.mockRestore();
      }
    }));

  test("R2 failure → 500, rows survive for the retry", async () =>
    inRollback(sharedSql, async (tx) => {
      const { token, refreshKey } = await seedUser(tx, USER_ID);
      await seedSource(tx, SOURCE_ID, USER_ID);
      const res = await handleDeleteAccount(del(authed(token)), deps(tx, refreshKey, fakeR2({ failDelete: true })));
      expect(res.status).toBe(500);
      const [user] = await tx`SELECT id FROM users WHERE id = ${USER_ID}`;
      expect(user?.id).toBe(USER_ID);
      const [source] = await tx`SELECT id FROM sources WHERE id = ${SOURCE_ID}`;
      expect(source?.id).toBe(SOURCE_ID);
    }));

  test("no stored refresh token → no revoke call", async () =>
    inRollback(sharedSql, async (tx) => {
      const { token, refreshKey } = await seedUser(tx, USER_ID, { refreshToken: false });
      const d = deps(tx, refreshKey, fakeR2());
      const res = await handleDeleteAccount(del(authed(token)), d);
      expect(res.status).toBe(204);
      expect(d.revoked).toEqual([]);
    }));

  test("a retry after success gets 401 — the session is gone", async () =>
    inRollback(sharedSql, async (tx) => {
      const { token, refreshKey } = await seedUser(tx, USER_ID, { refreshToken: false });
      const d = deps(tx, refreshKey, fakeR2());
      expect((await handleDeleteAccount(del(authed(token)), d)).status).toBe(204);
      const retry = await handleDeleteAccount(del(authed(token)), d);
      expect(retry.status).toBe(401);
    }));
});

describeDb("deleteIdleAccounts (§1.2.17)", () => {
  const idleFor = (tx: SQL, userId: string, months: number, days = 0) =>
    tx`UPDATE users
      SET last_active_at = now() - make_interval(months => ${months}::int, days => ${days}::int)
      WHERE id = ${userId}`;

  test("deletes an account idle past 24 months through the DELETE /api/account steps, keeps one inside", async () =>
    inRollback(sharedSql, async (tx) => {
      expect(IDLE_ACCOUNT_MONTHS).toBe(24);
      const { refreshKey } = await seedUser(tx, USER_ID);
      await seedUser(tx, OTHER_USER, { refreshToken: false });
      await seedSource(tx, SOURCE_ID, USER_ID, true);
      await seedSource(tx, OTHER_SOURCE_ID, OTHER_USER);
      await idleFor(tx, USER_ID, 24, 1);
      await idleFor(tx, OTHER_USER, 23, 27);

      const r2 = fakeR2();
      const d = deps(tx, refreshKey, r2);
      expect(await deleteIdleAccounts(d)).toEqual({ deleted: 1, failed: 0 });

      expect(d.revoked).toEqual([REFRESH_TOKEN]);
      expect(r2.deleted).toEqual([`poses/${SOURCE_ID}.tkp1.gz`, `staging/${SOURCE_ID}.tkp1.gz`]);
      expect(await tx`SELECT id FROM users WHERE id = ${USER_ID}`).toHaveLength(0);
      expect(await tx`SELECT id FROM sources WHERE id = ${SOURCE_ID}`).toHaveLength(0);
      const [kept] = await tx`SELECT id FROM users WHERE id = ${OTHER_USER}`;
      expect(kept?.id).toBe(OTHER_USER);
      const [keptSource] = await tx`SELECT id FROM sources WHERE id = ${OTHER_SOURCE_ID}`;
      expect(keptSource?.id).toBe(OTHER_SOURCE_ID);
    }));

  test("Apple unreachable → counted as failed, nothing deleted, retried next run", async () =>
    inRollback(sharedSql, async (tx) => {
      const { refreshKey } = await seedUser(tx, USER_ID);
      await seedSource(tx, SOURCE_ID, USER_ID);
      await idleFor(tx, USER_ID, 25);
      const r2 = fakeR2();
      const d = deps(tx, refreshKey, r2, { revoke: () => Promise.reject(new AppleUnavailableError("down")) });
      expect(await deleteIdleAccounts(d)).toEqual({ deleted: 0, failed: 1 });
      expect(r2.deleted).toEqual([]);
      const [user] = await tx`SELECT id FROM users WHERE id = ${USER_ID}`;
      expect(user?.id).toBe(USER_ID);
    }));

  test("an authenticated request moves last_active_at forward, at most hourly", async () =>
    inRollback(sharedSql, async (tx) => {
      const { token, refreshKey } = await seedUser(tx, USER_ID, { refreshToken: false });
      await idleFor(tx, USER_ID, 25);
      const req = del(authed(token));
      expect(await authenticateClient(req, { sql: tx })).toEqual({ userId: USER_ID });
      const [{ fresh }] = await tx`
        SELECT last_active_at > now() - interval '1 minute' AS fresh FROM users WHERE id = ${USER_ID}`;
      expect(fresh).toBe(true);
      expect(await deleteIdleAccounts(deps(tx, refreshKey, fakeR2()))).toEqual({ deleted: 0, failed: 0 });

      // Within the hour, no further write.
      await tx`UPDATE users SET last_active_at = now() - interval '30 minutes' WHERE id = ${USER_ID}`;
      await authenticateClient(req, { sql: tx });
      const [{ unchanged }] = await tx`
        SELECT last_active_at = now() - interval '30 minutes' AS unchanged FROM users WHERE id = ${USER_ID}`;
      expect(unchanged).toBe(true);
    }));
});
