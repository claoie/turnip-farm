import { SQL } from "bun";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../../db/testing";
import { createAppleTokenVerifier, createCodeExchanger } from "./apple";
import { type SignInDeps, authenticateClient, handleSignIn, handleSignOut } from "./sessions";
import { APPLE_REFRESH_TOKEN, AUDIENCE, SUB, noDatabase, startMockApple } from "./testing";
import { decryptRefreshToken, importRefreshTokenKey, sha256Hex } from "./tokens";

const apple = await startMockApple();
afterAll(() => apple.stop());
afterEach(() => apple.reset());

const RAW_NONCE = "raw-nonce-from-the-app";
const DAY_MS = 24 * 60 * 60 * 1000;

const refreshTokenKey = await importRefreshTokenKey(crypto.getRandomValues(new Uint8Array(32)));

function deps(sql: SQL): SignInDeps {
  return {
    sql,
    verifyIdentityToken: createAppleTokenVerifier({ audience: AUDIENCE, jwksUrl: apple.jwksUrl }),
    exchangeCode: createCodeExchanger({ credentials: apple.credentials, tokenUrl: apple.tokenUrl, timeoutMs: 1000 }),
    refreshTokenKey,
  };
}

async function signInBody(overrides: Record<string, unknown> = {}) {
  return {
    identity_token: await apple.identityToken({ claims: { nonce: sha256Hex(RAW_NONCE) } }),
    authorization_code: "auth-code",
    nonce: RAW_NONCE,
    ...overrides,
  };
}

function post(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`http://farm.test${path}`, init);
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error: { code, message: expect.any(String), details: {} } });
}

describe("POST /api/auth/apple without a database", () => {
  test.each([
    ["a non-JSON body", "{not json"],
    ["a missing field", { identity_token: "x", authorization_code: "y" }],
    ["an empty field", { identity_token: "x", authorization_code: "", nonce: "z" }],
    ["a non-string field", { identity_token: "x", authorization_code: "y", nonce: 7 }],
  ])("returns 422 VALIDATION_ERROR for %s", async (_, body) => {
    await expectError(await handleSignIn(post("/api/auth/apple", body), deps(noDatabase)), 422, "VALIDATION_ERROR");
  });

  test.each([
    ["an invalid identity token", async () => signInBody({ identity_token: "not.a.jwt" })],
    ["a nonce that doesn't match", async () => signInBody({ nonce: "another-nonce" })],
    ["an identity token with no nonce", async () => signInBody({ identity_token: await apple.identityToken() })],
  ])("returns 401 for %s, before calling Apple or the database", async (_, makeBody) => {
    const res = await handleSignIn(post("/api/auth/apple", await makeBody()), deps(noDatabase));
    await expectError(res, 401, "UNAUTHENTICATED");
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(apple.tokenRequests).toHaveLength(0);
  });

  test("returns 401 when Apple rejects the authorization code", async () => {
    apple.respondWith(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expectError(await handleSignIn(post("/api/auth/apple", await signInBody()), deps(noDatabase)), 401, "UNAUTHENTICATED");
  });

  test("returns 401 when Apple's id_token names a different user", async () => {
    const otherUser = await apple.identityToken({ claims: { sub: "999999.other.0001" } });
    apple.respondWith(() => Response.json({ id_token: otherUser, refresh_token: APPLE_REFRESH_TOKEN }));
    await expectError(await handleSignIn(post("/api/auth/apple", await signInBody()), deps(noDatabase)), 401, "UNAUTHENTICATED");
  });

  test("returns 503 APPLE_UNAVAILABLE when Apple's token endpoint fails", async () => {
    apple.respondWith(() => new Response("down", { status: 502 }));
    await expectError(await handleSignIn(post("/api/auth/apple", await signInBody()), deps(noDatabase)), 503, "APPLE_UNAVAILABLE");
  });

  test("propagates a misconfiguration (invalid_client) as a server error", async () => {
    apple.respondWith(() => Response.json({ error: "invalid_client" }, { status: 400 }));
    await expect(handleSignIn(post("/api/auth/apple", await signInBody()), deps(noDatabase))).rejects.toThrow(/invalid_client/);
  });
});

describe("sessions without a database", () => {
  test.each([
    ["no Authorization header", {}],
    ["a non-Bearer scheme", { authorization: "Basic dXNlcjpwYXNz" }],
  ])("authenticateClient returns 401 for %s", async (_, headers) => {
    const auth = await authenticateClient(new Request("http://farm.test/api/x", { headers }), { sql: noDatabase });
    expect(auth).toBeInstanceOf(Response);
    expect((auth as Response).headers.get("www-authenticate")).toBe("Bearer");
    await expectError(auth as Response, 401, "UNAUTHENTICATED");
  });

  test("sign-out without a token is a 204 that touches nothing", async () => {
    expect((await handleSignOut(post("/api/auth/signout"), { sql: noDatabase })).status).toBe(204);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("sessions with a database", () => {
  const sql = new SQL(TEST_DATABASE_URL ?? "");
  afterAll(() => sql.close());

  async function signIn(tx: SQL): Promise<string> {
    const res = await handleSignIn(post("/api/auth/apple", await signInBody()), deps(tx));
    expect(res.status).toBe(200);
    return ((await res.json()) as { session_token: string }).session_token;
  }

  function authenticate(tx: SQL, token: string, options?: { allowBlocked?: boolean }) {
    return authenticateClient(new Request("http://farm.test/api/x", { headers: bearer(token) }), { sql: tx }, options);
  }

  test("sign-in creates the user, stores Apple's refresh token encrypted, and issues a hashed session", async () => {
    await inRollback(sql, async (tx) => {
      const res = await handleSignIn(post("/api/auth/apple", await signInBody()), deps(tx));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { session_token: string; expires_at: string };
      expect(body.session_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.expires_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(Date.parse(body.expires_at) - Date.now()).toBeGreaterThan(89 * DAY_MS);

      const [user] = await tx`SELECT apple_refresh_token FROM users WHERE id = ${SUB}`;
      const sealed = new Uint8Array(user.apple_refresh_token);
      expect(await decryptRefreshToken(refreshTokenKey, SUB, sealed)).toBe(APPLE_REFRESH_TOKEN);
      expect(Buffer.from(sealed).includes(APPLE_REFRESH_TOKEN)).toBe(false);

      const sessions = await tx`SELECT token_hash FROM sessions WHERE user_id = ${SUB}`;
      expect(sessions.map((s: { token_hash: string }) => s.token_hash)).toEqual([sha256Hex(body.session_token)]);
    });
  });

  test("a second sign-in adds a session and replaces the stored refresh token", async () => {
    await inRollback(sql, async (tx) => {
      await signIn(tx);
      apple.respondWith(async () =>
        Response.json({ id_token: await apple.identityToken(), refresh_token: "second-refresh-token" }),
      );
      await signIn(tx);

      const [counts] = await tx`
        SELECT (SELECT count(*) FROM users WHERE id = ${SUB})::int         AS users,
               (SELECT count(*) FROM sessions WHERE user_id = ${SUB})::int AS sessions`;
      expect(counts).toEqual({ users: 1, sessions: 2 });
      const [user] = await tx`SELECT apple_refresh_token FROM users WHERE id = ${SUB}`;
      expect(await decryptRefreshToken(refreshTokenKey, SUB, new Uint8Array(user.apple_refresh_token))).toBe(
        "second-refresh-token",
      );
    });
  });

  test("sign-in marks an idle account active again (§1.2.17)", async () => {
    await inRollback(sql, async (tx) => {
      await signIn(tx);
      await tx`UPDATE users SET last_active_at = now() - interval '25 months' WHERE id = ${SUB}`;
      apple.respondWith(async () =>
        Response.json({ id_token: await apple.identityToken(), refresh_token: "second-refresh-token" }),
      );
      await signIn(tx);
      const [{ fresh }] = await tx`
        SELECT last_active_at > now() - interval '1 minute' AS fresh FROM users WHERE id = ${SUB}`;
      expect(fresh).toBe(true);
    });
  });

  test("sign-in purges expired sessions", async () => {
    await inRollback(sql, async (tx) => {
      await tx`INSERT INTO users (id) VALUES ('expired-user')`;
      await tx`INSERT INTO sessions (user_id, token_hash, expires_at)
               VALUES ('expired-user', ${sha256Hex("old")}, now() - interval '1 second')`;
      await signIn(tx);
      const [{ n }] = await tx`SELECT count(*)::int AS n FROM sessions WHERE user_id = 'expired-user'`;
      expect(n).toBe(0);
    });
  });

  test("a session authenticates its user; unknown and expired tokens don't", async () => {
    await inRollback(sql, async (tx) => {
      const token = await signIn(tx);
      expect(await authenticate(tx, token)).toEqual({ userId: SUB });
      await expectError((await authenticate(tx, "unknown-token")) as Response, 401, "UNAUTHENTICATED");

      await tx`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = ${sha256Hex(token)}`;
      await expectError((await authenticate(tx, token)) as Response, 401, "UNAUTHENTICATED");
    });
  });

  test("a blocked user signs in, then gets 403 except where blocked users are allowed", async () => {
    await inRollback(sql, async (tx) => {
      await tx`INSERT INTO users (id, is_blocked) VALUES (${SUB}, TRUE)`;
      const token = await signIn(tx);
      await expectError((await authenticate(tx, token)) as Response, 403, "ACCOUNT_BLOCKED");
      expect(await authenticate(tx, token, { allowBlocked: true })).toEqual({ userId: SUB });
    });
  });

  test("a session idle for over a day slides its expiry forward; a recent one is left alone", async () => {
    await inRollback(sql, async (tx) => {
      const token = await signIn(tx);
      const hash = sha256Hex(token);
      const read = async () => (await tx`SELECT last_used_at, expires_at FROM sessions WHERE token_hash = ${hash}`)[0];

      const fresh = await read();
      await authenticate(tx, token);
      expect(await read()).toEqual(fresh);

      await tx`UPDATE sessions SET last_used_at = now() - interval '2 days', expires_at = now() + interval '1 day'
               WHERE token_hash = ${hash}`;
      await authenticate(tx, token);
      const slid = await read();
      expect(slid.expires_at.getTime() - Date.now()).toBeGreaterThan(89 * DAY_MS);
      expect(Date.now() - slid.last_used_at.getTime()).toBeLessThan(DAY_MS);
    });
  });

  test("sign-out deletes the session, and is a 204 for an unknown token too", async () => {
    await inRollback(sql, async (tx) => {
      const token = await signIn(tx);
      expect((await handleSignOut(post("/api/auth/signout", undefined, bearer(token)), { sql: tx })).status).toBe(204);
      await expectError((await authenticate(tx, token)) as Response, 401, "UNAUTHENTICATED");
      expect((await handleSignOut(post("/api/auth/signout", undefined, bearer(token)), { sql: tx })).status).toBe(204);
    });
  });
});
