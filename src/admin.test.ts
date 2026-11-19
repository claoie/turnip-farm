// Admin endpoints (BACKEND_DESIGN.md §7.1 "Admin", §7.3): the session
// gate, its rate limit, the source list's paging and filter, the holdout flag,
// and the pose blob. DB tests run only when TEST_DATABASE_URL names a
// database, each in a rolled-back transaction (db/testing.ts).

import { SQL, type TransactionSQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../db/testing";
import { type AppDeps, createHandler, startServer } from "./app";
import { fakeAdminAuth, seedAdminSession } from "./auth/admin-testing";
import { noDatabase, testCandidateKey } from "./auth/testing";
import { sha256Hex } from "./auth/tokens";
import { BlobTooLargeError, MAX_CANONICAL_BLOB_BYTES, type R2Client } from "./r2/client";
import { TokenBucket } from "./ratelimit";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : (null as unknown as SQL);
afterAll(async () => {
  await sharedSql?.end();
});

// Test-only stand-in, not a secret.
const PIPELINE_KEY = ["pipeline", "key", "for", "tests"].join("-");

// A signed-in admin's cookie, with the farm's Origin so writes pass too.
const adminHeaders = async (tx: TransactionSQL) => (await seedAdminSession(tx)).writeHeaders;

const noR2: R2Client = {
  presignPut: () => {
    throw new Error("r2 unavailable in this test");
  },
  presignGet: () => {
    throw new Error("r2 unavailable in this test");
  },
  getStream: () => {
    throw new Error("r2 unavailable in this test");
  },
  deleteObject: () => {
    throw new Error("r2 unavailable in this test");
  },
};

const baseDeps: AppDeps = {
  sql: noDatabase,
  verifyIdentityToken: () => Promise.reject(new Error("verifier unavailable in this test")),
  exchangeCode: () => Promise.reject(new Error("Apple unavailable in this test")),
  verifyNotificationPayload: () => Promise.reject(new Error("verifier unavailable in this test")),
  revokeRefreshToken: () => Promise.reject(new Error("revoker unavailable in this test")),
  refreshTokenKey: {} as CryptoKey,
  r2: noR2,
  pipelineKey: PIPELINE_KEY,
  adminAuth: fakeAdminAuth(),
  currentDisclosureVersion: 3,
  candidateKey: testCandidateKey,
  limits: {
    user: new TokenBucket(1000, 60000),
    ip: new TokenBucket(1000, 60000),
    publicIp: new TokenBucket(1000, 60000),
    adminIp: new TokenBucket(1000, 60000),
  },
};

const vid = (ch: string) => ch.repeat(64);
const SOURCE = vid("a");

function req(method: string, path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://farm.test${path}`, { method, headers });
}

const ADMIN_ROUTES: [string, string][] = [
  ["GET", "/api/admin/sources"],
  ["GET", "/api/admin/sources?holdout=true"],
  ["PUT", `/api/admin/sources/${SOURCE}/holdout`],
  ["DELETE", `/api/admin/sources/${SOURCE}/holdout`],
  ["GET", `/api/admin/sources/${SOURCE}/pose`],
];

describe("admin gate", () => {
  // sql and r2 throw if reached: a refused request must touch neither.
  for (const [method, path] of ADMIN_ROUTES) {
    test(`${method} ${path}: 404 when admin sign-in isn't configured`, async () => {
      for (const adminAuth of [null, undefined]) {
        const handle = createHandler({ ...baseDeps, adminAuth });
        const res = await handle(req(method, path, { cookie: "__Host-turnip-admin=x", origin: "https://farm.test" }));
        expect(res.status).toBe(404);
        expect(((await res.json()) as any).error.code).toBe("NOT_FOUND");
      }
    });

    test(`${method} ${path}: 401 without an admin session cookie`, async () => {
      const handle = createHandler(baseDeps);
      const refused: Record<string, string>[] = [
        { origin: "https://farm.test" },
        { origin: "https://farm.test", authorization: `Bearer ${PIPELINE_KEY}` },
        { origin: "https://farm.test", cookie: "__Host-turnip-admin=" },
        { origin: "https://farm.test", cookie: "turnip-admin=" + "a".repeat(43) },
      ];
      for (const headers of refused) {
        const res = await handle(req(method, path, headers));
        expect(res.status).toBe(401);
        expect(((await res.json()) as any).error.code).toBe("UNAUTHENTICATED");
      }
    });
  }

  test("an unknown admin path or method is a JSON 404, never the SPA shell", async () => {
    const handle = createHandler(baseDeps, { clientDir: "/nonexistent" });
    for (const [method, path] of [
      ["POST", "/api/admin/sources"],
      ["GET", `/api/admin/sources/${SOURCE}`],
      ["POST", `/api/admin/sources/${SOURCE}/holdout`],
      ["GET", "/api/admin"],
    ] as const) {
      const res = await handle(req(method, path, { origin: "https://farm.test" }));
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).error.code).toBe("NOT_FOUND");
    }
  });

  test("admin and sign-in requests are per-IP rate limited before the session check", async () => {
    const server = startServer(0, {
      ...baseDeps,
      limits: { ...baseDeps.limits, adminIp: new TokenBucket(3, 1) },
    });
    try {
      const url = new URL("/api/admin/sources", server.url);
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { method: "PUT" })).status).toBe(404);
      expect((await fetch(new URL("/auth/login", server.url), { redirect: "manual" })).status).toBe(302);
      const res = await fetch(url);
      expect(res.status).toBe(429);
      expect(((await res.json()) as any).error.code).toBe("RATE_LIMITED");
      expect(res.headers.get("Retry-After")).not.toBeNull();
      expect((await fetch(new URL("/auth/login", server.url), { redirect: "manual" })).status).toBe(429);
      // The public endpoints keep their own bucket.
      expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);
    } finally {
      server.stop(true);
    }
  });
});

const T0 = "2026-11-01T10:00:00.123456Z";
const T1 = "2026-11-02T10:00:00.000001Z";
const T2 = "2026-11-03T10:00:00.5Z";
const PAST = "2026-10-01T00:00:00.000000Z";

async function seedSource(
  tx: TransactionSQL,
  id: string,
  opts: { createdAt?: string; ingested?: boolean; ingestedAt?: string; holdout?: boolean; frames?: number } = {},
) {
  const sha = opts.ingested === false ? null : sha256Hex(`blob-${id}`);
  await tx`INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, r2_key, sha256, ingested_at, holdout, created_at, updated_at)
    VALUES (${id}, ${sha256Hex(`key-${id}`)}, ${opts.frames ?? 600}, 30, ${`poses/${id}.tkp1.gz`}, ${sha},
            ${opts.ingestedAt ?? null}::timestamptz, ${opts.holdout ?? false}, ${opts.createdAt ?? T0}::timestamptz,
            ${PAST}::timestamptz)`;
}

function dbDeps(tx: TransactionSQL, overrides: Partial<AppDeps> = {}) {
  return createHandler({ ...baseDeps, sql: tx as unknown as SQL, ...overrides });
}

async function list(handle: (r: Request) => Promise<Response>, asAdmin: Record<string, string>, query = ""): Promise<any> {
  const res = await handle(req("GET", `/api/admin/sources${query}`, asAdmin));
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  return res.json();
}

async function allPages(
  handle: (r: Request) => Promise<Response>,
  asAdmin: Record<string, string>,
  filter = "all",
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 20; pages++) {
    const q: string = `?holdout=${filter}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const body = await list(handle, asAdmin, q);
    ids.push(...body.sources.map((s: { id: string }) => s.id));
    cursor = body.next_cursor;
    if (cursor === null) return ids;
  }
  throw new Error("pagination did not end");
}

describeDb("GET /api/admin/sources", () => {
  test("newest first, paging through created_at ties with a small page", async () =>
    inRollback(sharedSql, async (tx) => {
      const asAdmin = await adminHeaders(tx);
      // Five sources share T1 to the microsecond (one transaction's now()).
      for (const ch of ["1", "2", "3", "4", "5"]) await seedSource(tx, vid(ch), { createdAt: T1 });
      await seedSource(tx, vid("6"), { createdAt: T0 });
      await seedSource(tx, vid("7"), { createdAt: T2 });
      const handle = dbDeps(tx, { adminPageLimit: 2 });
      expect(await allPages(handle, asAdmin)).toEqual([vid("7"), vid("5"), vid("4"), vid("3"), vid("2"), vid("1"), vid("6")]);

      const first = await list(handle, asAdmin);
      expect(first.sources).toHaveLength(2);
      expect(first.next_cursor).toBeString();
      // A full last page has no next cursor.
      const exact = dbDeps(tx, { adminPageLimit: 7 });
      const whole = await list(exact, asAdmin);
      expect(whole.sources).toHaveLength(7);
      expect(whole.next_cursor).toBeNull();
    }));

  test("filters holdout only, non-holdout only, or all", async () =>
    inRollback(sharedSql, async (tx) => {
      const asAdmin = await adminHeaders(tx);
      await seedSource(tx, vid("1"), { createdAt: T0, holdout: true });
      await seedSource(tx, vid("2"), { createdAt: T1 });
      await seedSource(tx, vid("3"), { createdAt: T2, holdout: true });
      const handle = dbDeps(tx, { adminPageLimit: 1 });
      expect(await allPages(handle, asAdmin, "true")).toEqual([vid("3"), vid("1")]);
      expect(await allPages(handle, asAdmin, "false")).toEqual([vid("2")]);
      expect(await allPages(handle, asAdmin, "all")).toEqual([vid("3"), vid("2"), vid("1")]);
    }));

  test("shows the source, its clips and names, and quarantine, and nothing about the account", async () =>
    inRollback(sharedSql, async (tx) => {
      const asAdmin = await adminHeaders(tx);
      await seedSource(tx, SOURCE, { frames: 450, holdout: true, ingestedAt: "2026-11-01T10:05:00.000001Z" });
      await seedSource(tx, vid("b"), { ingested: false, createdAt: T1 });
      const [user] = await tx`INSERT INTO users (id) VALUES ('apple-sub-for-admin-test') RETURNING id`;
      await tx`INSERT INTO source_attribution (source_id, user_id) VALUES (${SOURCE}, ${user!.id})`;
      const [late] = await tx`INSERT INTO clips (source_id, start_frame, end_frame) VALUES (${SOURCE}, 300, 340) RETURNING id`;
      const [early] = await tx`INSERT INTO clips (source_id, start_frame, end_frame) VALUES (${SOURCE}, 20, 55) RETURNING id`;
      for (const name of ["gainer", "cork"]) {
        await tx`INSERT INTO labels (clip_id, trick_name, origin, taxonomy_version) VALUES (${early!.id}, ${name}, 'typed', 1)`;
      }
      await tx`INSERT INTO data_quarantine (source_id, reason) VALUES (${SOURCE}, 'regression')`;

      const handle = dbDeps(tx);
      const res = await handle(req("GET", "/api/admin/sources", asAdmin));
      const text = await res.text();
      expect(text).not.toContain("apple-sub-for-admin-test");
      expect(text).not.toContain("source_key");
      const body = JSON.parse(text);
      expect(body.sources).toEqual([
        {
          id: vid("b"),
          created_at: "2026-11-02T10:00:00.000001Z",
          ingested_at: null,
          frame_count: 600,
          sample_rate: 30,
          ingested: false,
          holdout: false,
          quarantined: false,
          clips: [],
        },
        {
          id: SOURCE,
          created_at: T0,
          ingested_at: "2026-11-01T10:05:00.000001Z",
          frame_count: 450,
          sample_rate: 30,
          ingested: true,
          holdout: true,
          quarantined: true,
          clips: [
            { id: early!.id, start_frame: 20, end_frame: 55, names: ["cork", "gainer"] },
            { id: late!.id, start_frame: 300, end_frame: 340, names: [] },
          ],
        },
      ]);
      expect(Object.keys(body)).toEqual(["sources", "next_cursor"]);
    }));

  test("a released quarantine no longer shows", async () =>
    inRollback(sharedSql, async (tx) => {
      const asAdmin = await adminHeaders(tx);
      await seedSource(tx, SOURCE);
      await tx`INSERT INTO data_quarantine (source_id, reason, resolved_at, resolution)
               VALUES (${SOURCE}, 'regression', now(), 'released')`;
      const body = await list(dbDeps(tx), asAdmin);
      expect(body.sources[0].quarantined).toBe(false);
    }));

  test("rejects a bad filter or cursor", async () =>
    inRollback(sharedSql, async (tx) => {
      const asAdmin = await adminHeaders(tx);
      const handle = dbDeps(tx);
      for (const [query, field] of [
        ["?holdout=yes", "holdout"],
        ["?holdout=", "holdout"],
        ["?cursor=nope", "cursor"],
        [`?cursor=${Buffer.from(JSON.stringify(["2026-11-01T10:00:00Z", SOURCE])).toString("base64url")}`, "cursor"],
        [`?cursor=${Buffer.from(JSON.stringify([T0, "not-an-id"])).toString("base64url")}`, "cursor"],
      ]) {
        const res = await handle(req("GET", `/api/admin/sources${query}`, asAdmin));
        expect(res.status).toBe(422);
        const body = (await res.json()) as any;
        expect(body.error.code).toBe("VALIDATION_ERROR");
        expect(body.error.details.field).toBe(field);
      }
    }));
});

async function holdoutState(tx: TransactionSQL, id: string) {
  const [row] = await tx`SELECT holdout, updated_at > ${PAST}::timestamptz AS touched FROM sources WHERE id = ${id}`;
  return row as { holdout: boolean; touched: boolean };
}

describeDb("PUT and DELETE /api/admin/sources/:id/holdout", () => {
  test("sets and clears the flag like sources:holdout, moving updated_at only on a change", async () =>
    inRollback(sharedSql, async (tx) => {
      const asAdmin = await adminHeaders(tx);
      await seedSource(tx, SOURCE);
      await seedSource(tx, vid("b"));
      const handle = dbDeps(tx);
      const call = async (method: string) => {
        const res = await handle(req(method, `/api/admin/sources/${SOURCE}/holdout`, asAdmin));
        expect(res.status).toBe(200);
        return res.json();
      };

      expect(await call("DELETE")).toEqual({ source_id: SOURCE, holdout: false, changed: false });
      expect(await holdoutState(tx, SOURCE)).toEqual({ holdout: false, touched: false });

      expect(await call("PUT")).toEqual({ source_id: SOURCE, holdout: true, changed: true });
      expect(await holdoutState(tx, SOURCE)).toEqual({ holdout: true, touched: true });
      expect(await holdoutState(tx, vid("b"))).toEqual({ holdout: false, touched: false });
      expect(await call("PUT")).toEqual({ source_id: SOURCE, holdout: true, changed: false });

      expect(await call("DELETE")).toEqual({ source_id: SOURCE, holdout: false, changed: true });
      expect((await holdoutState(tx, SOURCE)).holdout).toBe(false);
    }));

  test("the change reaches the export as holdout on the source's rows", async () =>
    inRollback(sharedSql, async (tx) => {
      const asAdmin = await adminHeaders(tx);
      await seedSource(tx, SOURCE);
      const [clip] = await tx`INSERT INTO clips (source_id, start_frame, end_frame) VALUES (${SOURCE}, 0, 10) RETURNING id`;
      await tx`INSERT INTO labels (clip_id, trick_name, origin, taxonomy_version) VALUES (${clip!.id}, 'cork', 'typed', 1)`;
      const handle = dbDeps(tx);
      expect((await handle(req("PUT", `/api/admin/sources/${SOURCE}/holdout`, asAdmin))).status).toBe(200);
      const res = await handle(req("GET", "/api/labels/export", { authorization: `Bearer ${PIPELINE_KEY}` }));
      const body = (await res.json()) as any;
      expect(body.rows.map((r: any) => [r.source_id, r.holdout])).toEqual([[SOURCE, true]]);
    }));

  test("404 for an unknown or malformed source id", async () =>
    inRollback(sharedSql, async (tx) => {
      const asAdmin = await adminHeaders(tx);
      const handle = dbDeps(tx);
      for (const id of [vid("c"), "nope", "A".repeat(64)]) {
        for (const method of ["PUT", "DELETE"]) {
          const res = await handle(req(method, `/api/admin/sources/${id}/holdout`, asAdmin));
          expect(res.status).toBe(404);
        }
      }
    }));
});

function fakeR2(getStream: R2Client["getStream"]): R2Client & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    ...noR2,
    fetched,
    getStream: (key, opts) => {
      fetched.push(key);
      return getStream(key, opts);
    },
  };
}

function streamOf(...chunks: Uint8Array<ArrayBuffer>[]): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describeDb("GET /api/admin/sources/:id/pose", () => {
  test("streams the canonical blob's stored bytes", async () =>
    inRollback(sharedSql, async (tx) => {
      const asAdmin = await adminHeaders(tx);
      await seedSource(tx, SOURCE);
      const blob = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 250]);
      let cap: number | undefined;
      const r2 = fakeR2(async (_key, opts) => {
        cap = opts?.maxBytes;
        return streamOf(blob.slice(0, 3), blob.slice(3));
      });
      const res = await dbDeps(tx, { r2 })(req("GET", `/api/admin/sources/${SOURCE}/pose`, asAdmin));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/gzip");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(blob);
      expect(r2.fetched).toEqual([`poses/${SOURCE}.tkp1.gz`]);
      expect(cap).toBe(MAX_CANONICAL_BLOB_BYTES);
    }));

  test("422 BLOB_MISSING before ingest, without reading R2", async () =>
    inRollback(sharedSql, async (tx) => {
      const asAdmin = await adminHeaders(tx);
      await seedSource(tx, SOURCE, { ingested: false });
      const res = await dbDeps(tx)(req("GET", `/api/admin/sources/${SOURCE}/pose`, asAdmin));
      expect(res.status).toBe(422);
      expect(((await res.json()) as any).error.code).toBe("BLOB_MISSING");
    }));

  test("422 when the blob is gone from R2 or over the cap", async () =>
    inRollback(sharedSql, async (tx) => {
      const asAdmin = await adminHeaders(tx);
      await seedSource(tx, SOURCE);
      const gone = await dbDeps(tx, { r2: fakeR2(async () => null) })(
        req("GET", `/api/admin/sources/${SOURCE}/pose`, asAdmin),
      );
      expect(gone.status).toBe(422);
      expect(((await gone.json()) as any).error.code).toBe("BLOB_MISSING");

      const huge = await dbDeps(tx, {
        r2: fakeR2(async (key) => {
          throw new BlobTooLargeError(key, MAX_CANONICAL_BLOB_BYTES);
        }),
      })(req("GET", `/api/admin/sources/${SOURCE}/pose`, asAdmin));
      expect(huge.status).toBe(422);
      expect(((await huge.json()) as any).error.code).toBe("BLOB_TOO_LARGE");
    }));

  test("a blob that passes the cap mid-stream cuts the response short", async () =>
    inRollback(sharedSql, async (tx) => {
      const asAdmin = await adminHeaders(tx);
      await seedSource(tx, SOURCE);
      const r2 = fakeR2(async (key) =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([0x1f, 0x8b]));
            controller.error(new BlobTooLargeError(key, 2));
          },
        }),
      );
      const res = await dbDeps(tx, { r2 })(req("GET", `/api/admin/sources/${SOURCE}/pose`, asAdmin));
      expect(res.status).toBe(200);
      await expect(res.arrayBuffer()).rejects.toBeInstanceOf(BlobTooLargeError);
    }));

  test("404 for an unknown or malformed source id", async () =>
    inRollback(sharedSql, async (tx) => {
      const asAdmin = await adminHeaders(tx);
      const handle = dbDeps(tx);
      for (const id of [vid("c"), "nope"]) {
        expect((await handle(req("GET", `/api/admin/sources/${id}/pose`, asAdmin))).status).toBe(404);
      }
    }));
});
