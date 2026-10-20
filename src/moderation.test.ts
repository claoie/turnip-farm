// Maintainer moderation: attribution lookup and blocking (issue #11). The
// DB-backed cases run inside a rolled-back transaction per db/testing.ts,
// only when TEST_DATABASE_URL names a database.

import { SQL, type TransactionSQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../db/testing";
import { authenticateClient } from "./auth/sessions";
import { noDatabase } from "./auth/testing";
import { sha256Hex } from "./auth/tokens";
import { handleRegisterSource } from "./contrib/sources";
import type { R2Client } from "./r2/client";
import { TokenBucket } from "./ratelimit";
import { attributedAccount, blockAccountCli, setBlocked, sourceAccountCli } from "./moderation";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : (null as unknown as SQL);
afterAll(async () => {
  await sharedSql?.end();
});

const USER_ID = "001234.0123456789abcdef0123456789abcdef.0123";
const OTHER_USER = "009999.0123456789abcdef0123456789abcdef.0999";
// Fixture bearer value for these tests only — never a real credential.
const SESSION_TOKEN = ["session", "token", "for", "moderation", "test"].join("-");
const SOURCE_KEY = "xxx".repeat(14) + "x"; // 43-char fixture, not a secret
const SOURCE_ID = "a".repeat(64);
const OTHER_SOURCE = "b".repeat(64);

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

async function seedUser(tx: TransactionSQL, userId: string, blocked = false) {
  await tx`INSERT INTO users (id, is_blocked) VALUES (${userId}, ${blocked})`;
}

async function seedAttributedSource(tx: TransactionSQL, sourceId: string, userId: string, ageDays = 0) {
  await tx`INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, r2_key)
    VALUES (${sourceId}, ${sha256Hex(SOURCE_KEY)}, 100, 10.0, ${`poses/${sourceId}.tkp1.gz`})`;
  await tx`INSERT INTO source_attribution (source_id, user_id, attributed_at)
    VALUES (${sourceId}, ${userId}, now() - make_interval(days => ${ageDays}::int))`;
}

describe("moderation CLIs: usage errors, before any DB touch", () => {
  test.each([[[]], [["not-a-source-id"]], [[SOURCE_ID, OTHER_SOURCE]], [[SOURCE_ID.toUpperCase()]]])(
    "source-account %j exits 2",
    async (args) => {
      const c = capture();
      expect(await sourceAccountCli(args, noDatabase, c.io)).toBe(2);
      expect(c.err[0]).toStartWith("usage:");
      expect(c.out).toEqual([]);
    },
  );

  test.each([[[]], [["--clear"]], [["--force", USER_ID]], [[""]], [[USER_ID, OTHER_USER]]])(
    "block %j exits 2",
    async (args) => {
      const c = capture();
      expect(await blockAccountCli(args, noDatabase, c.io)).toBe(2);
      expect(c.err[0]).toStartWith("usage:");
    },
  );
});

describeDb("attributedAccount", () => {
  test("resolves a source to the account that last wrote it, inside the window", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx, USER_ID);
      await seedAttributedSource(tx, SOURCE_ID, USER_ID, 29);
      expect(await attributedAccount(tx, SOURCE_ID)).toEqual({ userId: USER_ID, isBlocked: false });
    }));

  test("returns null past the 30-day window, even before the purge has run", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx, USER_ID);
      await seedAttributedSource(tx, SOURCE_ID, USER_ID, 31);
      expect(await attributedAccount(tx, SOURCE_ID)).toBeNull();
    }));

  test("returns null for an unknown source", async () =>
    inRollback(sharedSql, async (tx) => {
      expect(await attributedAccount(tx, SOURCE_ID)).toBeNull();
    }));
});

describeDb("source-account CLI", () => {
  test("prints the account and its block state, never the source id (§8)", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx, USER_ID, true);
      await seedAttributedSource(tx, SOURCE_ID, USER_ID);
      const c = capture();
      expect(await sourceAccountCli([SOURCE_ID], tx, c.io)).toBe(0);
      expect(c.out).toEqual([`account: ${USER_ID}`, "blocked: yes"]);
      expect(c.err).toEqual([]);
      expect([...c.out, ...c.err].join("\n")).not.toContain(SOURCE_ID);
    }));

  test("exits 1 without naming an account when the attribution has expired", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx, USER_ID);
      await seedAttributedSource(tx, SOURCE_ID, USER_ID, 31);
      const c = capture();
      expect(await sourceAccountCli([SOURCE_ID], tx, c.io)).toBe(1);
      expect(c.out).toEqual([]);
      expect(c.err.join("\n")).not.toContain(USER_ID);
    }));
});

describeDb("blocking", () => {
  const fakeR2: R2Client = {
    presignPut: (key) => ({ url: `https://r2.test/put/${key}`, expiresAt: new Date() }),
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
  const limits = {
    user: new TokenBucket(1000, 60000),
    ip: new TokenBucket(1000, 60000),
    publicIp: new TokenBucket(1000, 60000),
  };
  const register = (tx: SQL) =>
    handleRegisterSource(
      new Request("http://farm.test/api/sources", {
        method: "POST",
        headers: { authorization: `Bearer ${SESSION_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          video_id: SOURCE_ID,
          source_key: SOURCE_KEY,
          frame_count: 100,
          sample_rate: 10,
          keypoint_format: "tkp1",
        }),
      }),
      { sql: tx, r2: fakeR2, limits },
    );

  test("block stops contributions at once; the session survives; clear restores them", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx, USER_ID);
      await tx`INSERT INTO sessions (user_id, token_hash, expires_at)
        VALUES (${USER_ID}, ${sha256Hex(SESSION_TOKEN)}, now() + interval '1 hour')`;

      const blocked = capture();
      expect(await blockAccountCli([USER_ID], tx, blocked.io)).toBe(0);
      expect(blocked.out).toEqual([`Account ${USER_ID} is now blocked.`]);
      const res = await register(tx);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("ACCOUNT_BLOCKED");
      // Kept, so the account can still sign out and delete itself (§1.2.16).
      expect(await tx`SELECT id FROM sessions WHERE user_id = ${USER_ID}`).toHaveLength(1);
      const req = new Request("http://farm.test", { headers: { authorization: `Bearer ${SESSION_TOKEN}` } });
      expect(await authenticateClient(req, { sql: tx }, { allowBlocked: true })).toEqual({ userId: USER_ID });

      const cleared = capture();
      expect(await blockAccountCli(["--clear", USER_ID], tx, cleared.io)).toBe(0);
      expect(cleared.out).toEqual([`Account ${USER_ID} is now unblocked.`]);
      expect((await register(tx)).status).toBe(201);
    }));

  test("only the named account is blocked", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx, USER_ID);
      await seedUser(tx, OTHER_USER);
      expect(await setBlocked(tx, USER_ID, true)).toBe("changed");
      const rows = await tx`SELECT id, is_blocked FROM users ORDER BY id`;
      expect(rows.map((r: { id: string; is_blocked: boolean }) => [r.id, r.is_blocked])).toEqual([
        [USER_ID, true],
        [OTHER_USER, false],
      ]);
    }));

  test("blocking twice, or clearing an unblocked account, reports no change", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedUser(tx, USER_ID);
      expect(await setBlocked(tx, USER_ID, false)).toBe("unchanged");
      expect(await setBlocked(tx, USER_ID, true)).toBe("changed");
      const again = capture();
      expect(await blockAccountCli([USER_ID], tx, again.io)).toBe(0);
      expect(again.out).toEqual([`Account ${USER_ID} was already blocked.`]);
    }));

  test("an unknown account exits 1", async () =>
    inRollback(sharedSql, async (tx) => {
      const c = capture();
      expect(await blockAccountCli([USER_ID], tx, c.io)).toBe(1);
      expect(await setBlocked(tx, USER_ID, false)).toBe("unknown");
    }));
});
