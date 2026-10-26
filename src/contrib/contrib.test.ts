// Contribution endpoints, DB-backed (BACKEND_DESIGN.md §7.3).
// Run inside a rolled-back transaction per db/testing.ts; only run when
// TEST_DATABASE_URL names a database.

import { SQL, type TransactionSQL } from "bun";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../../db/testing";
import { sha256Hex } from "../auth/tokens";
import { TokenBucket } from "../ratelimit";
import type { R2Client } from "../r2/client";
import { BlobTooLargeError } from "../r2/client";
import { purgeExpiredAttribution } from "./purge";
import {
  handleDeleteSource,
  handleGetSource,
  handleGetSourcePose,
  handleRegisterSource,
  type SourcesDeps,
} from "./sources";
import { handlePostClipLabels, handlePostClips, type ClipsDeps } from "./clips";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : null;
afterAll(async () => {
  await sharedSql?.end();
});

const VIDEO_ID = "a".repeat(64);
const VIDEO_ID_2 = "b".repeat(64);
const SOURCE_KEY = "xxx".repeat(14) + "x"; // 43-char fixture, not a secret
const OTHER_KEY = "xxx".repeat(13) + "Xxxx"; // 43-char fixture, not a secret
const CLIP_ID = "123e4567-e89b-42d3-a456-426614174000";
const CLIP_ID_2 = "123e4567-e89b-42d3-a456-426614174001";

function fakeR2(opts: { bytes?: Uint8Array | null; failDelete?: boolean; tooLarge?: boolean } = {}): R2Client & {
  deleted: string[];
} {
  const deleted: string[] = [];
  return {
    deleted,
    presignPut: (key: string) => ({
      url: `https://r2.test/put/${key}?sig=put`,
      expiresAt: new Date("2026-10-14T08:15:00.000Z"),
    }),
    presignGet: (key: string) => ({
      url: `https://r2.test/get/${key}?sig=get`,
      expiresAt: new Date("2026-10-14T08:15:00.000Z"),
    }),
    getBytes: async () => {
      if (opts.tooLarge) throw new BlobTooLargeError("poses/test.tkp1.gz", 10);
      return opts.bytes ?? null;
    },
    deleteObject: async (key: string) => {
      if (opts.failDelete) throw new Error("r2 down");
      deleted.push(key);
    },
  };
}

type Deps = SourcesDeps & ClipsDeps;

function deps(tx: SQL, r2: R2Client, userCapacity = 1000, refillPerMinute = 60): Deps {
  return {
    sql: tx,
    r2,
    limits: {
      user: new TokenBucket(userCapacity, refillPerMinute),
      ip: new TokenBucket(1000, 60),
      publicIp: new TokenBucket(1000, 60),
    },
  };
}

async function seedUser(tx: TransactionSQL, userId: string, blocked = false) {
  await tx`INSERT INTO users (id, is_blocked) VALUES (${userId}, ${blocked})`;
  const token = `session-for-${userId}`;
  await tx`INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${sha256Hex(token)}, now() + interval '1 hour')`;
  return token;
}

const authed = (token: string, headers: Record<string, string> = {}) =>
  ({ authorization: `Bearer ${token}`, ...headers });

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://farm.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://farm.test${path}`, { method: "GET", headers });
}

async function bodyJson(res: Response): Promise<any> {
  return res.json();
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = await bodyJson(res);
  expect(body.error.code).toBe(code);
  expect(body.error.details).toEqual(expect.anything());
}

async function registerSource(
  tx: TransactionSQL,
  d: Deps,
  token: string,
  overrides: Record<string, unknown> = {},
) {
  return handleRegisterSource(
    post(
      "/api/sources",
      {
        video_id: VIDEO_ID,
        source_key: SOURCE_KEY,
        frame_count: 600,
        sample_rate: 10,
        keypoint_format: "tkp1",
        ...overrides,
      },
      authed(token),
    ),
    d,
  );
}

describeDb("POST /api/sources", () => {
  test("401 without a session, 403 for a blocked account", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const d = deps(tx, fakeR2());
      const token = await seedUser(tx, "u1");
      await expectError(await registerSource(tx, d, "bad-token"), 401, "UNAUTHENTICATED");
      const blockedToken = await seedUser(tx, "u2", true);
      await expectError(await registerSource(tx, d, blockedToken), 403, "ACCOUNT_BLOCKED");
      expect(token).toBe("session-for-u1");
    });
  });

  test("422 on invalid fields; 422 UNSUPPORTED_FORMAT for other formats", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const d = deps(tx, fakeR2());
      const token = await seedUser(tx, "u1");
      await expectError(await registerSource(tx, d, token, { video_id: "nope" }), 422, "VALIDATION_ERROR");
      await expectError(await registerSource(tx, d, token, { source_key: "short" }), 422, "VALIDATION_ERROR");
      await expectError(await registerSource(tx, d, token, { frame_count: 0 }), 422, "VALIDATION_ERROR");
      await expectError(await registerSource(tx, d, token, { sample_rate: 60 }), 422, "VALIDATION_ERROR");
      await expectError(
        await registerSource(tx, d, token, { keypoint_format: "coco" }),
        422,
        "UNSUPPORTED_FORMAT",
      );
    });
  });

  test("201 new → 200 re-register → 409 claimed under another key", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const r2 = fakeR2();
      const d = deps(tx, r2);
      const token = await seedUser(tx, "u1");

      const created = await registerSource(tx, d, token);
      expect(created.status).toBe(201);
      const createdBody = await bodyJson(created);
      expect(createdBody.source_id).toBe(VIDEO_ID);
      expect(createdBody.r2_key).toBe(`poses/${VIDEO_ID}.tkp1.gz`);
      // Cross-PR contract: the upload URL targets the ingest worker's staging key.
      expect(createdBody.upload_url).toBe(`https://r2.test/put/staging/${VIDEO_ID}.tkp1.gz?sig=put`);
      expect(createdBody.upload_expires_at).toBe("2026-10-14T08:15:00.000Z");
      expect(createdBody.blob_present).toBe(false);

      const again = await registerSource(tx, d, token);
      expect(again.status).toBe(200);

      const claimed = await registerSource(tx, d, token, { source_key: OTHER_KEY });
      await expectError(claimed, 409, "SOURCE_ALREADY_CLAIMED");

      // The source row is unchanged by the failed claim; the key hash is the first writer's.
      const [row] = await tx`SELECT frame_count, source_key_hash FROM sources WHERE id = ${VIDEO_ID}`;
      expect(row.frame_count).toBe(600);
      expect(row.source_key_hash).toBe(sha256Hex(SOURCE_KEY));

      // Attribution recorded the writer.
      const [attr] = await tx`SELECT user_id FROM source_attribution WHERE source_id = ${VIDEO_ID}`;
      expect(attr.user_id).toBe("u1");
    });
  });

  test("429 when the per-user bucket is empty", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const d = deps(tx, fakeR2(), 1, 1);
      const token = await seedUser(tx, "u1");
      expect((await registerSource(tx, d, token)).status).toBe(201);
      const limited = await registerSource(tx, d, token, { video_id: VIDEO_ID_2 });
      expect(limited.status).toBe(429);
      const body = await bodyJson(limited);
      expect(body.error.code).toBe("RATE_LIMITED");
      expect(limited.headers.get("retry-after")).toBe("60");
    });
  });
});

describeDb("POST /api/clips", () => {
  async function seedIngestedSource(tx: TransactionSQL, token: string, sha256: string | null) {
    const d = deps(tx, fakeR2());
    const res = await registerSource(tx, d, token);
    expect([201, 200]).toContain(res.status);
    await tx`UPDATE sources SET sha256 = ${sha256} WHERE id = ${VIDEO_ID}`;
    return d;
  }

  const clipBody = (overrides: Record<string, unknown> = {}) => ({
    clips: [
      {
        clip_id: CLIP_ID,
        source_id: VIDEO_ID,
        source_key: SOURCE_KEY,
        start_frame: 120,
        end_frame: 175,
        auto_detected: false,
        labels: [
          { name: " cork ", origin: "typed" },
          { name: "CORK", origin: "vocabulary" },
          { name: "gainer", origin: "vocabulary" },
          { name: "", origin: "typed" },
        ],
        ...overrides,
      },
    ],
  });

  test("200: clips upserted, labels replaced + deduped, attribution written", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const token = await seedUser(tx, "u1");
      const blob = new TextEncoder().encode("canonical-bytes");
      const hex = createHash("sha256").update(blob).digest("hex");
      const d = deps(tx, fakeR2({ bytes: blob }));
      await seedIngestedSource(tx, token, hex);

      const res = await handlePostClips(post("/api/clips", clipBody(), authed(token)), d);
      expect(res.status).toBe(200);
      const body = await bodyJson(res);
      expect(body.clips).toHaveLength(1);
      expect(body.clips[0].clip_id).toBe(CLIP_ID);
      expect(body.clips[0].labels).toEqual([
        { name: "CORK", origin: "vocabulary" },
        { name: "gainer", origin: "vocabulary" },
      ]);
      expect(body.clips[0].taxonomy_version).toBe(1);

      const labels = await tx`SELECT trick_name, origin FROM labels WHERE clip_id = ${CLIP_ID} ORDER BY trick_name`;
      expect(labels.map((l: Record<string, unknown>) => [l.trick_name, l.origin])).toEqual([
        ["CORK", "vocabulary"],
        ["gainer", "vocabulary"],
      ]);

      // Re-submit replaces the set.
      const res2 = await handlePostClips(
        post("/api/clips", clipBody({ clip_id: CLIP_ID, labels: [{ name: "hook", origin: "typed" }] }), authed(token)),
        d,
      );
      expect(res2.status).toBe(200);
      expect((await bodyJson(res2)).clips[0].labels).toEqual([{ name: "hook", origin: "typed" }]);
      const labels2 = await tx`SELECT trick_name, origin FROM labels WHERE clip_id = ${CLIP_ID}`;
      expect(labels2.map((l: Record<string, unknown>) => [l.trick_name, l.origin])).toEqual([["hook", "typed"]]);
    });
  });

  test("200: a model-proposed clip keeps its provenance, replaced on re-submit", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const token = await seedUser(tx, "u1");
      const blob = new TextEncoder().encode("canonical-bytes");
      const d = deps(tx, fakeR2({ bytes: blob }));
      await seedIngestedSource(tx, token, createHash("sha256").update(blob).digest("hex"));

      const proposed = clipBody({
        auto_detected: true,
        proposal_model_version: "trick-v1.3",
        suggested_names: ["cork", "gainer"],
        labels: [
          { name: "cork", origin: "model" },
          { name: "hook", origin: "typed" },
        ],
      });
      expect((await handlePostClips(post("/api/clips", proposed, authed(token)), d)).status).toBe(200);
      const [clip] = await tx`
        SELECT proposal_model_version, suggested_names, suggestions_withheld FROM clips WHERE id = ${CLIP_ID}`;
      expect(clip.proposal_model_version).toBe("trick-v1.3");
      expect(clip.suggested_names).toEqual(["cork", "gainer"]);
      expect(clip.suggestions_withheld).toBe(false);

      // The client's current record is the truth (§4): a manual re-trim drops the model.
      const manual = clipBody({ labels: [{ name: "hook", origin: "typed" }] });
      expect((await handlePostClips(post("/api/clips", manual, authed(token)), d)).status).toBe(200);
      const [after] = await tx`
        SELECT proposal_model_version, suggested_names FROM clips WHERE id = ${CLIP_ID}`;
      expect(after.proposal_model_version).toBeNull();
      expect(after.suggested_names).toEqual([]);
    });
  });

  test("422 rather than dropping labels it can't read, or provenance that contradicts itself", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const token = await seedUser(tx, "u1");
      const blob = new TextEncoder().encode("canonical-bytes");
      const d = deps(tx, fakeR2({ bytes: blob }));
      await seedIngestedSource(tx, token, createHash("sha256").update(blob).digest("hex"));

      const cases: Record<string, unknown>[] = [
        { labels: ["cork"] },
        { labels: [{ name: "cork" }] },
        { labels: [{ name: "cork", origin: "guessed" }] },
        { labels: [{ name: "cork", origin: "model" }] },
        { suggested_names: ["cork"] },
        { suggestions_withheld: true },
        {
          proposal_model_version: "trick-v1.3",
          suggestions_withheld: true,
          labels: [{ name: "cork", origin: "model" }],
        },
      ];
      for (const overrides of cases) {
        const res = await handlePostClips(post("/api/clips", clipBody(overrides), authed(token)), d);
        await expectError(res, 422, "VALIDATION_ERROR");
      }
      expect(await tx`SELECT id FROM clips`).toHaveLength(0);
      expect(await tx`SELECT id FROM labels`).toHaveLength(0);
    });
  });

  test("404 on wrong source key, missing source, or clip owned by another source", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const token = await seedUser(tx, "u1");
      const hex = createHash("sha256").update("b").digest("hex");
      const d = deps(tx, fakeR2({ bytes: new TextEncoder().encode("b") }));
      await seedIngestedSource(tx, token, hex);

      await expectError(
        await handlePostClips(post("/api/clips", clipBody({ source_key: OTHER_KEY }), authed(token)), d),
        404,
        "NOT_FOUND",
      );
      await expectError(
        await handlePostClips(post("/api/clips", clipBody({ source_id: VIDEO_ID_2 }), authed(token)), d),
        404,
        "NOT_FOUND",
      );
      // Move the clip to another source first, then try to re-home it.
      await tx`INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, keypoint_format, r2_key)
        VALUES (${VIDEO_ID_2}, ${sha256Hex(SOURCE_KEY)}, 600, 10, 'tkp1', ${`poses/${VIDEO_ID_2}.tkp1.gz`})`;
      await tx`INSERT INTO clips (id, source_id, start_frame, end_frame) VALUES (${CLIP_ID_2}, ${VIDEO_ID_2}, 1, 2)`;
      await expectError(
        await handlePostClips(
          post("/api/clips", clipBody({ clip_id: CLIP_ID_2 }), authed(token)),
          d,
        ),
        404,
        "NOT_FOUND",
      );
    });
  });

  test("422 on bad frame windows; batch is atomic", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const token = await seedUser(tx, "u1");
      const hex = createHash("sha256").update("b").digest("hex");
      const d = deps(tx, fakeR2({ bytes: new TextEncoder().encode("b") }));
      await seedIngestedSource(tx, token, hex);

      const bad = clipBody();
      (bad.clips as Record<string, unknown>[]).push({
        clip_id: CLIP_ID_2,
        source_id: VIDEO_ID,
        source_key: SOURCE_KEY,
        start_frame: 0,
        end_frame: 601,
        auto_detected: false,
        labels: [],
      });
      const res = await handlePostClips(post("/api/clips", bad, authed(token)), d);
      await expectError(res, 422, "VALIDATION_ERROR");
      const clips = await tx`SELECT id FROM clips`;
      expect(clips).toHaveLength(0);
      const labels = await tx`SELECT id FROM labels`;
      expect(labels).toHaveLength(0);
    });
  });

  test("422 BLOB_MISSING / BLOB_DIGEST_MISMATCH", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const token = await seedUser(tx, "u1");
      const dMissing = deps(tx, fakeR2());
      await seedIngestedSource(tx, token, null);
      await expectError(
        await handlePostClips(post("/api/clips", clipBody(), authed(token)), dMissing),
        422,
        "BLOB_MISSING",
      );

      const dMismatch = deps(tx, fakeR2({ bytes: new TextEncoder().encode("other-bytes") }));
      await tx`UPDATE sources SET sha256 = ${createHash("sha256").update("canonical").digest("hex")} WHERE id = ${VIDEO_ID}`;
      await expectError(
        await handlePostClips(post("/api/clips", clipBody(), authed(token)), dMismatch),
        422,
        "BLOB_DIGEST_MISMATCH",
      );
    });
  });

  test("422 BLOB_TOO_LARGE when the blob exceeds the cap", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const token = await seedUser(tx, "u1");
      const d = deps(tx, fakeR2({ tooLarge: true }));
      await seedIngestedSource(tx, token, createHash("sha256").update("b").digest("hex"));
      await expectError(
        await handlePostClips(post("/api/clips", clipBody(), authed(token)), d),
        422,
        "BLOB_TOO_LARGE",
      );
    });
  });
});

describeDb("POST /api/clips/:id/labels", () => {
  test("200 replaces one clip's label set; 404 on wrong key", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const token = await seedUser(tx, "u1");
      const hex = createHash("sha256").update("b").digest("hex");
      const d = deps(tx, fakeR2({ bytes: new TextEncoder().encode("b") }));
      const reg = await registerSource(tx, d, token);
      expect(reg.status).toBe(201);
      await tx`UPDATE sources SET sha256 = ${hex} WHERE id = ${VIDEO_ID}`;
      await tx`INSERT INTO clips (id, source_id, start_frame, end_frame) VALUES (${CLIP_ID}, ${VIDEO_ID}, 1, 2)`;

      const labels = [
        { name: "hook", origin: "vocabulary" },
        { name: "Hook", origin: "typed" },
        { name: "", origin: "typed" },
      ];
      const res = await handlePostClipLabels(
        post(`/api/clips/${CLIP_ID}/labels`, { source_key: SOURCE_KEY, labels }, authed(token)),
        d,
        CLIP_ID,
      );
      expect(res.status).toBe(200);
      expect(await bodyJson(res)).toEqual({
        clip_id: CLIP_ID,
        labels: [{ name: "Hook", origin: "typed" }],
        taxonomy_version: 1,
      });
      const [stored] = await tx`SELECT trick_name, origin FROM labels WHERE clip_id = ${CLIP_ID}`;
      expect([stored.trick_name, stored.origin]).toEqual(["Hook", "typed"]);

      // Labels answer to the clip's stored provenance: this one has no proposing model.
      const kept = { source_key: SOURCE_KEY, labels: [{ name: "cork", origin: "model" }] };
      await expectError(
        await handlePostClipLabels(post(`/api/clips/${CLIP_ID}/labels`, kept, authed(token)), d, CLIP_ID),
        422,
        "VALIDATION_ERROR",
      );
      const strings = { source_key: SOURCE_KEY, labels: ["cork"] };
      await expectError(
        await handlePostClipLabels(post(`/api/clips/${CLIP_ID}/labels`, strings, authed(token)), d, CLIP_ID),
        422,
        "VALIDATION_ERROR",
      );

      const bad = await handlePostClipLabels(
        post(
          `/api/clips/${CLIP_ID}/labels`,
          { source_key: OTHER_KEY, labels: [{ name: "x", origin: "typed" }] },
          authed(token),
        ),
        d,
        CLIP_ID,
      );
      await expectError(bad, 404, "NOT_FOUND");

      // Attribution refreshed by the label write.
      const [attr] = await tx`SELECT user_id FROM source_attribution WHERE source_id = ${VIDEO_ID}`;
      expect(attr.user_id).toBe("u1");
    });
  });
});

describeDb("GET /api/sources/:id", () => {
  test("200 with clips+labels; 404 on missing/wrong key", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const token = await seedUser(tx, "u1");
      const d = deps(tx, fakeR2());
      const reg = await registerSource(tx, d, token);
      expect(reg.status).toBe(201);
      await tx`INSERT INTO clips (id, source_id, start_frame, end_frame, auto_detected, proposal_model_version, suggested_names)
        VALUES (${CLIP_ID}, ${VIDEO_ID}, 120, 175, true, 'trick-v1.3', ARRAY['cork'])`;
      await tx`INSERT INTO labels (clip_id, trick_name, origin, taxonomy_version) VALUES (${CLIP_ID}, 'cork', 'model', 1)`;

      const key = { "source-key": SOURCE_KEY };
      const res = await handleGetSource(get(`/api/sources/${VIDEO_ID}`, authed(token, key)), d, VIDEO_ID);
      expect(res.status).toBe(200);
      const body = await bodyJson(res);
      expect(body.source.id).toBe(VIDEO_ID);
      expect(body.source.frame_count).toBe(600);
      expect(body.source).not.toHaveProperty("source_key_hash");
      expect(body.clips).toHaveLength(1);
      expect(body.clips[0]).toMatchObject({
        id: CLIP_ID,
        start_frame: 120,
        end_frame: 175,
        auto_detected: true,
        proposal_model_version: "trick-v1.3",
        suggested_names: ["cork"],
        suggestions_withheld: false,
      });
      expect(body.clips[0].labels).toHaveLength(1);
      expect(body.clips[0].labels[0]).toMatchObject({ name: "cork", origin: "model", taxonomy_version: 1 });
      expect(body.clips[0].labels[0]).not.toHaveProperty("trick_name");

      await expectError(
        await handleGetSource(get(`/api/sources/${VIDEO_ID}`, authed(token)), d, VIDEO_ID),
        404,
        "NOT_FOUND",
      );
      await expectError(
        await handleGetSource(get(`/api/sources/${VIDEO_ID}`, authed(token, { "source-key": OTHER_KEY })), d, VIDEO_ID),
        404,
        "NOT_FOUND",
      );
      await expectError(
        await handleGetSource(get(`/api/sources/${VIDEO_ID_2}`, authed(token, key)), d, VIDEO_ID_2),
        404,
        "NOT_FOUND",
      );
    });
  });
  test("trained_in: [] until a model trains on it; promoted versions oldest first", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const token = await seedUser(tx, "u1");
      const d = deps(tx, fakeR2());
      const reg = await registerSource(tx, d, token);
      expect(reg.status).toBe(201);
      const key = { "source-key": SOURCE_KEY };
      const trainedIn = async () => {
        const res = await handleGetSource(
          get(`/api/sources/${VIDEO_ID}`, authed(token, key)),
          d,
          VIDEO_ID,
        );
        expect(res.status).toBe(200);
        return (await bodyJson(res)).source.trained_in;
      };
      expect(await trainedIn()).toEqual([]);

      // v1.3 promoted first, v1.4 second, v1.5 trained but never promoted.
      await tx`INSERT INTO models (version, taxonomy_version, r2_key, sha256)
        VALUES ('trick-v1.3', 1, 'models/trick-v1.3', ${"c".repeat(64)}),
               ('trick-v1.4', 1, 'models/trick-v1.4', ${"d".repeat(64)}),
               ('trick-v1.5', 1, 'models/trick-v1.5', ${"e".repeat(64)})`;
      await tx`UPDATE models SET promoted_at = now() - interval '2 days' WHERE version = 'trick-v1.3'`;
      await tx`UPDATE models SET promoted_at = now() - interval '1 day' WHERE version = 'trick-v1.4'`;
      await tx`INSERT INTO model_training_sources (model_version, source_id)
        VALUES ('trick-v1.3', ${VIDEO_ID}), ('trick-v1.4', ${VIDEO_ID}), ('trick-v1.5', ${VIDEO_ID})`;
      expect(await trainedIn()).toEqual(["trick-v1.3", "trick-v1.4"]);
    });
  });
});

describeDb("GET /api/sources/:id/pose", () => {
  test("200 presigned URL; 422 when not ingested; 404 on wrong key", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const token = await seedUser(tx, "u1");
      const d = deps(tx, fakeR2());
      const reg = await registerSource(tx, d, token);
      expect(reg.status).toBe(201);
      const key = { "source-key": SOURCE_KEY };

      const missing = await handleGetSourcePose(get(`/api/sources/${VIDEO_ID}/pose`, authed(token, key)), d, VIDEO_ID);
      await expectError(missing, 422, "BLOB_MISSING");

      await tx`UPDATE sources SET sha256 = ${createHash("sha256").update("b").digest("hex")} WHERE id = ${VIDEO_ID}`;
      const res = await handleGetSourcePose(get(`/api/sources/${VIDEO_ID}/pose`, authed(token, key)), d, VIDEO_ID);
      expect(res.status).toBe(200);
      const body = await bodyJson(res);
      expect(body.url).toBe(`https://r2.test/get/poses/${VIDEO_ID}.tkp1.gz?sig=get`);
      expect(body.expires_at).toBe("2026-10-14T08:15:00.000Z");

      await expectError(
        await handleGetSourcePose(get(`/api/sources/${VIDEO_ID}/pose`, authed(token, { "source-key": OTHER_KEY })), d, VIDEO_ID),
        404,
        "NOT_FOUND",
      );
    });
  });
});

describeDb("DELETE /api/sources/:id", () => {
  test("204 deletes the row and both R2 objects; 404 on wrong key", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const token = await seedUser(tx, "u1");
      const r2 = fakeR2();
      const d = deps(tx, r2);
      const reg = await registerSource(tx, d, token);
      expect(reg.status).toBe(201);
      const key = { "source-key": SOURCE_KEY };

      const wrong = await handleDeleteSource(
        new Request(`http://farm.test/api/sources/${VIDEO_ID}`, { method: "DELETE", headers: authed(token, { "source-key": OTHER_KEY }) }),
        d,
        VIDEO_ID,
      );
      await expectError(wrong, 404, "NOT_FOUND");

      const res = await handleDeleteSource(
        new Request(`http://farm.test/api/sources/${VIDEO_ID}`, { method: "DELETE", headers: authed(token, key) }),
        d,
        VIDEO_ID,
      );
      expect(res.status).toBe(204);
      const rows = await tx`SELECT id FROM sources WHERE id = ${VIDEO_ID}`;
      expect(rows).toHaveLength(0);
      expect(r2.deleted).toContain(`poses/${VIDEO_ID}.tkp1.gz`);
      expect(r2.deleted).toContain(`staging/${VIDEO_ID}.tkp1.gz`);
    });
  });

  test("500 when the blob delete fails; the row survives for retry", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const token = await seedUser(tx, "u1");
      const d = deps(tx, fakeR2({ failDelete: true }));
      const reg = await registerSource(tx, d, token);
      expect(reg.status).toBe(201);
      const res = await handleDeleteSource(
        new Request(`http://farm.test/api/sources/${VIDEO_ID}`, {
          method: "DELETE",
          headers: authed(token, { "source-key": SOURCE_KEY }),
        }),
        d,
        VIDEO_ID,
      );
      await expectError(res, 500, "INTERNAL");
      const rows = await tx`SELECT id FROM sources WHERE id = ${VIDEO_ID}`;
      expect(rows).toHaveLength(1);
    });
  });
});

describeDb("purgeExpiredAttribution", () => {
  test("deletes 30-day-old attribution and reports, keeps fresh rows", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const token = await seedUser(tx, "u1");
      const d = deps(tx, fakeR2());
      const reg = await registerSource(tx, d, token);
      expect(reg.status).toBe(201);
      await tx`INSERT INTO reports (reporter_user_id, target_type, target_id, reason) VALUES ('u1', 'clip', 'x', 'old')`;
      await tx`UPDATE source_attribution SET attributed_at = now() - interval '31 days' WHERE source_id = ${VIDEO_ID}`;
      await tx`UPDATE reports SET created_at = now() - interval '31 days' WHERE target_id = 'x'`;
      await tx`INSERT INTO reports (reporter_user_id, target_type, target_id, reason) VALUES ('u1', 'clip', 'y', 'new')`;

      await purgeExpiredAttribution(tx);

      expect(await tx`SELECT source_id FROM source_attribution`).toHaveLength(0);
      const reports = await tx`SELECT target_id FROM reports`;
      expect(reports.map((r: Record<string, unknown>) => r.target_id)).toEqual(["y"]);
    });
  });
});

