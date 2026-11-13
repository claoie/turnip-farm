// Vocabulary-only labels and label candidates, DB-backed (BACKEND_DESIGN.md
// §1.2.25, §7.3). Runs inside a rolled-back transaction per db/testing.ts;
// only runs when TEST_DATABASE_URL names a database.

import { SQL, type TransactionSQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../db/testing";
import { deleteAccountData } from "./auth/account";
import { testCandidateKey } from "./auth/testing";
import { sha256Hex } from "./auth/tokens";
import { handlePostClipLabels, handlePostClips } from "./contrib/clips";
import { purgeExpiredAttribution } from "./contrib/purge";
import {
  LABEL_CANDIDATE_TTL_DAYS,
  candidateAccountHash,
  deriveCandidateKey,
  handlePostLabelCandidates,
  labelCandidatesCli,
  promoteLabelCli,
} from "./labels";
import type { R2Client } from "./r2/client";
import { TokenBucket } from "./ratelimit";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : (null as unknown as SQL);
afterAll(async () => {
  await sharedSql?.end();
});

const VIDEO_ID = "a".repeat(64);
const SOURCE_KEY = "xxx".repeat(14) + "x"; // 43-char fixture, not a secret
const CLIP_ID = "123e4567-e89b-42d3-a456-426614174000";
const BLOB = new TextEncoder().encode("canonical-bytes");

const r2: R2Client = {
  presignPut: () => {
    throw new Error("not used");
  },
  presignGet: () => {
    throw new Error("not used");
  },
  getBytes: async () => BLOB,
  deleteObject: async () => {},
};

function deps(tx: SQL) {
  return {
    sql: tx,
    r2,
    candidateKey: testCandidateKey,
    currentDisclosureVersion: 3,
    limits: { user: new TokenBucket(1000, 60), ip: new TokenBucket(1000, 60), publicIp: new TokenBucket(1000, 60) },
  };
}

async function seedUser(tx: TransactionSQL, userId: string): Promise<string> {
  await tx`INSERT INTO users (id) VALUES (${userId})`;
  await tx`INSERT INTO consents (user_id, disclosure_version) VALUES (${userId}, 3)`;
  const token = `session-for-${userId}`; // fixture, not a credential
  await tx`INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${sha256Hex(token)}, now() + interval '1 hour')`;
  return token;
}

async function seedSource(tx: TransactionSQL) {
  await tx`INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, r2_key, sha256)
    VALUES (${VIDEO_ID}, ${sha256Hex(SOURCE_KEY)}, 600, 10, ${`poses/${VIDEO_ID}.tkp1.gz`},
            ${new Bun.CryptoHasher("sha256").update(BLOB).digest("hex")})`;
}

const post = (path: string, body: unknown, token: string) =>
  new Request(`http://farm.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const clipsBody = (names: string[]) => ({
  clips: [
    {
      clip_id: CLIP_ID,
      source_id: VIDEO_ID,
      source_key: SOURCE_KEY,
      start_frame: 10,
      end_frame: 30,
      auto_detected: false,
      labels: names.map((name) => ({ name, origin: "typed" })),
    },
  ],
});

async function errorOf(res: Response) {
  const body = (await res.json()) as { error: { code: string; details: unknown } };
  return { status: res.status, code: body.error.code, details: body.error.details };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describeDb("vocabulary-only labels", () => {
  test("POST /api/clips: 422 UNKNOWN_LABEL for a name outside label_taxonomy, nothing written", async () =>
    inRollback(sharedSql, async (tx) => {
      const token = await seedUser(tx, "u1");
      await seedSource(tx);
      const res = await handlePostClips(post("/api/clips", clipsBody(["cork", "double leg", "Gainer"]), token), deps(tx));
      expect(await errorOf(res)).toEqual({
        status: 422,
        code: "UNKNOWN_LABEL",
        details: { index: 0, field: "labels", names: ["double leg"] },
      });
      expect(await tx`SELECT 1 FROM clips`).toHaveLength(0);
      expect(await tx`SELECT 1 FROM labels`).toHaveLength(0);

      // Vocabulary names in any case are accepted, at any taxonomy version.
      await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES ('btwist', 'btwist', 2)`;
      const ok = await handlePostClips(post("/api/clips", clipsBody(["CORK", "corkscrew", "BTwist"]), token), deps(tx));
      expect(ok.status).toBe(200);
      const stored = await tx`SELECT lower(trick_name) AS n FROM labels ORDER BY 1`;
      expect(stored.map((r: { n: string }) => r.n)).toEqual(["btwist", "cork", "corkscrew"]);
    }));

  test("POST /api/clips/:id/labels: 422 UNKNOWN_LABEL, the clip's labels untouched", async () =>
    inRollback(sharedSql, async (tx) => {
      const token = await seedUser(tx, "u1");
      await seedSource(tx);
      expect((await handlePostClips(post("/api/clips", clipsBody(["cork"]), token), deps(tx))).status).toBe(200);
      const res = await handlePostClipLabels(
        post(`/api/clips/${CLIP_ID}/labels`, { source_key: SOURCE_KEY, labels: [{ name: "Raiz", origin: "typed" }] }, token),
        deps(tx),
        CLIP_ID,
      );
      expect(await errorOf(res)).toEqual({
        status: 422,
        code: "UNKNOWN_LABEL",
        details: { field: "labels", names: ["Raiz"] },
      });
      expect((await tx`SELECT trick_name FROM labels`).map((r: { trick_name: string }) => r.trick_name)).toEqual(["cork"]);
    }));
});

describeDb("POST /api/labels/candidates", () => {
  test("202 stores new names under an HMAC of the account, once per account and name", async () =>
    inRollback(sharedSql, async (tx) => {
      const t1 = await seedUser(tx, "u1");
      const t2 = await seedUser(tx, "u2");
      const d = deps(tx);
      const r1 = await handlePostLabelCandidates(post("/api/labels/candidates", { names: ["Raiz", " raiz ", "cork"] }, t1), d);
      expect(r1.status).toBe(202);
      expect(await r1.text()).toBe("");
      await handlePostLabelCandidates(post("/api/labels/candidates", { names: ["RAIZ", "butterfly kick"] }, t1), d);
      await handlePostLabelCandidates(post("/api/labels/candidates", { names: ["raiz"] }, t2), d);

      const rows = await tx`SELECT name, account_hash FROM label_candidates ORDER BY lower(name), account_hash`;
      const h1 = await candidateAccountHash(testCandidateKey, "u1");
      const h2 = await candidateAccountHash(testCandidateKey, "u2");
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
      expect(h1).not.toBe(h2);
      // "cork" is already in the vocabulary; Raiz counts once for u1.
      expect(rows.map((r: { name: string; account_hash: string }) => [r.name, r.account_hash])).toEqual(
        [
          ["butterfly kick", h1],
          ["Raiz", h1],
          ["raiz", h2],
        ].sort((a, b) => (a[0]!.toLowerCase() + a[1]! < b[0]!.toLowerCase() + b[1]! ? -1 : 1)),
      );
      expect(JSON.stringify(rows)).not.toContain("u1");
    }));

  test("422 VALIDATION_ERROR on a bad body; 401 without a session", async () =>
    inRollback(sharedSql, async (tx) => {
      const token = await seedUser(tx, "u1");
      for (const body of [
        {},
        { names: [] },
        { names: "raiz" },
        { names: Array.from({ length: 21 }, (_, i) => `n${i}`) },
        { names: [" "] },
        { names: [7] },
        { names: ["x".repeat(65)] },
      ]) {
        const res = await handlePostLabelCandidates(post("/api/labels/candidates", body, token), deps(tx));
        expect((await errorOf(res)).code).toBe("VALIDATION_ERROR");
      }
      expect(await tx`SELECT 1 FROM label_candidates`).toHaveLength(0);
      const anon = await handlePostLabelCandidates(post("/api/labels/candidates", { names: ["raiz"] }, "nope"), deps(tx));
      expect(anon.status).toBe(401);
    }));

  test("candidates expire after the TTL, and go with their account", async () =>
    inRollback(sharedSql, async (tx) => {
      expect(LABEL_CANDIDATE_TTL_DAYS).toBe(30);
      const t1 = await seedUser(tx, "u1");
      const t2 = await seedUser(tx, "u2");
      const d = deps(tx);
      await handlePostLabelCandidates(post("/api/labels/candidates", { names: ["raiz", "aerial"] }, t1), d);
      await handlePostLabelCandidates(post("/api/labels/candidates", { names: ["raiz"] }, t2), d);
      await tx`UPDATE label_candidates SET submitted_at = now() - interval '31 days' WHERE name = 'aerial'`;
      await tx`UPDATE label_candidates SET submitted_at = now() - interval '29 days' WHERE name = 'raiz'`;
      await purgeExpiredAttribution(tx);
      expect(await tx`SELECT name FROM label_candidates`).toHaveLength(2);

      await deleteAccountData({ sql: tx, r2, candidateKey: testCandidateKey }, "u1");
      const left = await tx`SELECT account_hash FROM label_candidates`;
      expect(left.map((r: { account_hash: string }) => r.account_hash)).toEqual([
        await candidateAccountHash(testCandidateKey, "u2"),
      ]);
    }));

  test("the HMAC key is derived per secret", async () => {
    const other = await deriveCandidateKey(new Uint8Array(32).fill(1));
    expect(await candidateAccountHash(other, "u1")).not.toBe(await candidateAccountHash(testCandidateKey, "u1"));
  });
});

describeDb("candidate maintainer scripts", () => {
  test("labels:candidates lists names by distinct accounts; labels:promote adds one at a new version", async () =>
    inRollback(sharedSql, async (tx) => {
      const tokens = [await seedUser(tx, "u1"), await seedUser(tx, "u2")];
      for (const t of tokens) {
        await handlePostLabelCandidates(post("/api/labels/candidates", { names: ["Raiz"] }, t), deps(tx));
      }
      await handlePostLabelCandidates(post("/api/labels/candidates", { names: ["aerial"] }, tokens[0]!), deps(tx));

      const list = capture();
      expect(await labelCandidatesCli([], tx, list.io)).toBe(0);
      expect(list.out).toEqual(["    2  Raiz", "    1  aerial"]);
      const min = capture();
      expect(await labelCandidatesCli(["--min", "2"], tx, min.io)).toBe(0);
      expect(min.out).toEqual(["    2  Raiz"]);
      expect(await labelCandidatesCli(["--bogus"], tx, capture().io)).toBe(2);

      const [{ before }] = await tx`SELECT max(taxonomy_version) AS before FROM label_taxonomy`;
      const promoted = capture();
      expect(await promoteLabelCli(["Raiz"], tx, promoted.io)).toBe(0);
      const [row] = await tx`SELECT canonical, taxonomy_version FROM label_taxonomy WHERE raw = 'raiz'`;
      expect(row).toEqual({ canonical: "raiz", taxonomy_version: before + 1 });
      expect(await tx`SELECT 1 FROM label_candidates WHERE lower(name) = 'raiz'`).toHaveLength(0);
      expect(promoted.out).toEqual([`Promoted "raiz" → "raiz" at taxonomy version ${before + 1}; 2 candidate rows dropped.`]);

      // An alias for an existing canonical, and a refusal for a known name.
      expect(await promoteLabelCli(["Aerial", "aerial cartwheel"], tx, capture().io)).toBe(0);
      const [alias] = await tx`SELECT canonical, taxonomy_version FROM label_taxonomy WHERE raw = 'aerial'`;
      expect(alias).toEqual({ canonical: "aerial cartwheel", taxonomy_version: before + 2 });
      expect(await promoteLabelCli(["cork"], tx, capture().io)).toBe(1);
      expect(await promoteLabelCli([], tx, capture().io)).toBe(2);

      // The promoted name is now accepted on clips.
      await seedSource(tx);
      expect((await handlePostClips(post("/api/clips", clipsBody(["raiz"]), tokens[0]!), deps(tx))).status).toBe(200);
    }));
});
