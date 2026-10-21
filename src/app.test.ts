import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { type AppDeps, createHandler, startServer } from "./app";
import { noDatabase } from "./auth/testing";
import type { R2Client } from "./r2/client";
import { TokenBucket, parseProxyRange } from "./ratelimit";
import type { SQL } from "bun";

const noR2: R2Client = {
  presignPut: () => {
    throw new Error("r2 unavailable in this test");
  },
  presignGet: () => {
    throw new Error("r2 unavailable in this test");
  },
  getBytes: () => {
    throw new Error("r2 unavailable in this test");
  },
  deleteObject: () => {
    throw new Error("r2 unavailable in this test");
  },
};

// Stand-ins that fail loudly if a route reaches them unexpectedly.
const deps: AppDeps = {
  sql: noDatabase,
  verifyIdentityToken: () => Promise.reject(new Error("verifier unavailable in this test")),
  exchangeCode: () => Promise.reject(new Error("Apple unavailable in this test")),
  verifyNotificationPayload: () => Promise.reject(new Error("notification verifier unavailable in this test")),
  revokeRefreshToken: () => Promise.reject(new Error("revoker unavailable in this test")),
  refreshTokenKey: {} as CryptoKey,
  r2: noR2,
  pipelineKey: "test-pipeline-key",
  limits: {
    user: new TokenBucket(1000, 60000),
    ip: new TokenBucket(1000, 60000),
    publicIp: new TokenBucket(1000, 60000),
  },
};

const NOT_FOUND = { error: { code: "NOT_FOUND", message: "Not found", details: {} } };

describe("createHandler routing", () => {
  const handle = createHandler(deps);
  const request = (method: string, path: string) => new Request(`http://farm.test${path}`, { method });

  test("GET /healthz returns 200", async () => {
    const res = await handle(request("GET", "/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test.each([
    ["GET", "/nope"],
    ["POST", "/healthz"],
    ["GET", "/api/auth/apple"],
    ["GET", "/api/auth/signout"],
  ])("%s %s returns 404 in the API error shape", async (method, path) => {
    const res = await handle(request(method, path));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });

  test("POST /api/auth/apple reaches the sign-in handler", async () => {
    const res = await handle(new Request("http://farm.test/api/auth/apple", { method: "POST", body: "{}" }));
    expect(res.status).toBe(422);
  });

  test("POST /api/auth/signout reaches the sign-out handler", async () => {
    expect((await handle(request("POST", "/api/auth/signout"))).status).toBe(204);
  });

  test("contribution routes reach their handlers (401 before any DB touch)", async () => {
    // noDatabase throws if a handler reaches the database; 401 proves the
    // route dispatched to a session-guarded handler.
    for (const [method, path] of [
      ["POST", "/api/sources"],
      ["GET", "/api/sources/abc"],
      ["GET", "/api/sources/abc/pose"],
      ["DELETE", "/api/sources/abc"],
      ["POST", "/api/clips"],
      ["POST", "/api/clips/abc/labels"],
      ["POST", "/api/reports"],
    ] as const) {
      const res = await handle(request(method, path));
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
    }
  });

  test("wrong-method contribution routes are 404", async () => {
    for (const [method, path] of [
      ["GET", "/api/sources"],
      ["PUT", "/api/sources/abc"],
      ["GET", "/api/clips"],
      ["GET", "/api/clips/abc/labels"],
      ["DELETE", "/api/clips/abc/labels"],
      ["GET", "/api/account"],
      ["POST", "/api/account"],
      ["GET", "/api/auth/apple/notifications"],
      ["POST", "/api/labels/export"],
      ["GET", "/api/quarantine"],
      ["POST", "/api/taxonomy/current"],
      ["GET", "/api/quarantine/abc/release"],
      ["GET", "/api/reports"],
      ["POST", "/api/reports/abc"],
      ["GET", "/api/models"],
      ["POST", "/api/models/current"],
    ] as const) {
      const res = await handle(request(method, path));
      expect(res.status).toBe(404);
    }
  });

  test("pipeline routes reach their handlers (401 before any DB touch)", async () => {
    // noDatabase throws if a handler reaches the database; 401 proves the
    // route dispatched to a pipeline-key-guarded handler.
    const vid = "a".repeat(64);
    for (const [method, path, body] of [
      ["GET", "/api/labels/export", undefined],
      ["POST", "/api/quarantine", JSON.stringify({ source_ids: [vid], reason: "r" })],
      ["POST", `/api/quarantine/${vid}/release`, undefined],
      ["POST", `/api/quarantine/${vid}/purge`, undefined],
      ["POST", "/api/models", JSON.stringify({ version: "x" })],
    ] as const) {
      const res = await handle(
        new Request(`http://farm.test${path}`, {
          method,
          headers: body ? { "content-type": "application/json" } : {},
          body: body ?? undefined,
        }),
      );
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
    }
  });

  test("DELETE /api/account reaches the session-guarded handler (401 before any DB touch)", async () => {
    const res = await handle(request("DELETE", "/api/account"));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
  });

  test("POST /api/auth/apple/notifications reaches the notification handler", async () => {
    // A rejecting verifier becomes a 401 in the handler — the point is the
    // route dispatched past 404.
    const { InvalidTokenError } = await import("./auth/apple");
    const handleHere = createHandler({
      ...deps,
      verifyNotificationPayload: () => Promise.reject(new InvalidTokenError()),
    });
    const res = await handleHere(
      new Request("http://farm.test/api/auth/apple/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: "x" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
  });

  test("GET /api/taxonomy/current reaches the taxonomy handler", async () => {
    // A stub sql returning the v1 seed rows; the handler is public, so a
    // session-bearing request must be served too, not tied to an account.
    const stubSql = (async () => [
      { raw: "cork", canonical: "cork", taxonomy_version: 1 },
      { raw: "corkscrew", canonical: "cork", taxonomy_version: 1 },
    ]) as unknown as SQL;
    const handleHere = createHandler({ ...deps, sql: stubSql });
    const headerCases: Record<string, string>[] = [{}, { authorization: "Bearer <redacted>" }];
    for (const headers of headerCases) {
      const res = await handleHere(new Request("http://farm.test/api/taxonomy/current", { headers }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        taxonomy_version: 1,
        vocabulary: [{ canonical: "cork", aliases: ["cork", "corkscrew"] }],
      });
      expect(res.headers.get("ETag")).toBe('"1"');
      expect(res.headers.get("Cache-Control")).toBe("max-age=3600");
    }
  });

  test("GET /api/models/current reaches the models handler", async () => {
    // A stub sql dispatching on the query text, like models.test.ts; the
    // handler is public, so a session-bearing request must be served too,
    // not tied to an account. The stub r2 signs the artifact URL.
    const stubSql = (async (strings: TemplateStringsArray) => {
      const q = String(strings[0]);
      if (q.includes("FROM models")) {
        return [
          {
            version: "trick-v1.2",
            model_type: "trick-detection",
            taxonomy_version: 1,
            r2_key: "models/trick-v1.2.mlmodelc.zip",
            sha256: "a".repeat(64),
            byte_size: 10,
            min_client_version: null,
            input_desc: {},
            output_desc: {},
            holdout_report_r2_key: null,
            training_run_id: null,
            val_metrics: {},
            name_metrics: {},
            promoted_at: new Date("2026-10-06T06:00:00Z"),
          },
        ];
      }
      return [{ raw: "cork", canonical: "cork", taxonomy_version: 1 }];
    }) as unknown as SQL;
    const stubR2 = {
      ...noR2,
      presignGet: (key: string) => ({ url: `https://r2.test/${key}?sig=x`, expiresAt: new Date() }),
    };
    const handleHere = createHandler({ ...deps, sql: stubSql, r2: stubR2 });
    const headerCases: Record<string, string>[] = [{}, { authorization: "Bearer <redacted>" }];
    for (const headers of headerCases) {
      const res = await handleHere(new Request("http://farm.test/api/models/current", { headers }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { version: string; url: string };
      expect(body.version).toBe("trick-v1.2");
      expect(body.url).toBe("https://r2.test/models/trick-v1.2.mlmodelc.zip?sig=x");
      expect(res.headers.get("ETag")).toBe('"trick-v1.2"');
      expect(res.headers.get("Cache-Control")).toBe("max-age=300");
    }
  });
});

describe("startServer", () => {
  const server = startServer(0, deps);
  afterAll(() => server.stop(true));

  test("serves the routes over HTTP", async () => {
    const res = await fetch(new URL("/healthz", server.url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("POST /api/auth/apple/notifications is per-IP rate limited like sign-in", async () => {
    const limited = startServer(0, {
      ...deps,
      limits: {
        user: new TokenBucket(1000, 60000),
        ip: new TokenBucket(2, 1),
        publicIp: new TokenBucket(1000, 60000),
      },
    });
    try {
      const url = new URL("/api/auth/apple/notifications", limited.url);
      const post = () =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ payload: "x" }),
        });
      // The first two pass the limiter and reach the handler (the stand-in
      // verifier rejects loudly here, so 500 — the point is "not 429").
      expect((await post()).status).toBe(500);
      expect((await post()).status).toBe(500);
      const res = await post();
      expect(res.status).toBe(429);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
      expect(res.headers.get("Retry-After")).not.toBeNull();
    } finally {
      limited.stop(true);
    }
  });

  test("GET /api/taxonomy/current is per-IP rate limited", async () => {
    const limited = startServer(0, {
      ...deps,
      limits: {
        user: new TokenBucket(1000, 60000),
        ip: new TokenBucket(1000, 60000),
        publicIp: new TokenBucket(2, 1),
      },
    });
    try {
      const url = new URL("/api/taxonomy/current", limited.url);
      // The first two pass the limiter and reach the handler (noDatabase
      // throws on the taxonomy query, so 500 — the point is "not 429").
      expect((await fetch(url)).status).toBe(500);
      expect((await fetch(url)).status).toBe(500);
      const res = await fetch(url);
      expect(res.status).toBe(429);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
      expect(res.headers.get("Retry-After")).not.toBeNull();
    } finally {
      limited.stop(true);
    }
  });

  test("GET /api/models/current is per-IP rate limited", async () => {
    const limited = startServer(0, {
      ...deps,
      limits: {
        user: new TokenBucket(1000, 60000),
        ip: new TokenBucket(1000, 60000),
        publicIp: new TokenBucket(2, 1),
      },
    });
    try {
      const url = new URL("/api/models/current", limited.url);
      // The first two pass the limiter and reach the handler (noDatabase
      // throws on the models query, so 500 — the point is "not 429").
      expect((await fetch(url)).status).toBe(500);
      expect((await fetch(url)).status).toBe(500);
      const res = await fetch(url);
      expect(res.status).toBe(429);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
      expect(res.headers.get("Retry-After")).not.toBeNull();
    } finally {
      limited.stop(true);
    }
  });

  // The tests below dial 127.0.0.1, as Caddy does in production, so the
  // peer is loopback and X-Forwarded-For is honored.
  test("behind a loopback proxy, the public-GET bucket keys on X-Forwarded-For", async () => {
    const limited = startServer(0, {
      ...deps,
      limits: {
        user: new TokenBucket(1000, 60000),
        ip: new TokenBucket(1000, 60000),
        publicIp: new TokenBucket(2, 1),
      },
    });
    try {
      const url = `http://127.0.0.1:${limited.port}/api/taxonomy/current`;
      const get = (client: string) => fetch(url, { headers: { "X-Forwarded-For": client } });
      // 500 means the request passed the limiter (noDatabase throws).
      expect((await get("203.0.113.7")).status).toBe(500);
      expect((await get("203.0.113.7")).status).toBe(500);
      expect((await get("203.0.113.7")).status).toBe(429);
      // Another client behind the same proxy has its own bucket.
      expect((await get("198.51.100.2")).status).toBe(500);
    } finally {
      limited.stop(true);
    }
  });

  test("behind a loopback proxy, the sign-in bucket keys on X-Forwarded-For", async () => {
    const limited = startServer(0, {
      ...deps,
      limits: {
        user: new TokenBucket(1000, 60000),
        ip: new TokenBucket(2, 1),
        publicIp: new TokenBucket(1000, 60000),
      },
    });
    try {
      const url = `http://127.0.0.1:${limited.port}/api/auth/apple/notifications`;
      const post = (client: string) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "X-Forwarded-For": client },
          body: JSON.stringify({ payload: "x" }),
        });
      // 500 means the request passed the limiter (the verifier rejects).
      expect((await post("203.0.113.7")).status).toBe(500);
      expect((await post("203.0.113.7")).status).toBe(500);
      expect((await post("203.0.113.7")).status).toBe(429);
      expect((await post("198.51.100.2")).status).toBe(500);
    } finally {
      limited.stop(true);
    }
  });

  test("behind a chain of trusted proxies, the sign-in bucket keys on the client past them", async () => {
    // As if a container proxy at 10.0.0.1 forwarded to a loopback hop.
    const limited = startServer(0, {
      ...deps,
      limits: {
        user: new TokenBucket(1000, 60000),
        ip: new TokenBucket(2, 1),
        publicIp: new TokenBucket(1000, 60000),
        trustedProxies: [parseProxyRange("10.0.0.0/8")!],
      },
    });
    try {
      const url = `http://127.0.0.1:${limited.port}/api/auth/apple/notifications`;
      const post = (client: string) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "X-Forwarded-For": `${client}, 10.0.0.1` },
          body: JSON.stringify({ payload: "x" }),
        });
      // 500 means the request passed the limiter (the verifier rejects).
      expect((await post("203.0.113.7")).status).toBe(500);
      expect((await post("203.0.113.7")).status).toBe(500);
      expect((await post("203.0.113.7")).status).toBe(429);
      // Untrusted, 10.0.0.1 would be the client and this would share the bucket.
      expect((await post("198.51.100.2")).status).toBe(500);
    } finally {
      limited.stop(true);
    }
  });

  test("turns an unexpected error into 500 INTERNAL, logging the error but not the request", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const body = JSON.stringify({ identity_token: "secret-identity-token", authorization_code: "y", nonce: "z" });
      const res = await fetch(new URL("/api/auth/apple", server.url), { method: "POST", body });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: { code: "INTERNAL", message: "Internal server error", details: {} },
      });
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect(JSON.stringify(logged.mock.calls)).not.toContain("secret-identity-token");
    } finally {
      logged.mockRestore();
    }
  });
});
