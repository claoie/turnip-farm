// Farm sessions (BACKEND_DESIGN.md §7.1): Apple's identity token is verified
// once, at sign-in; every other request carries an opaque farm session token.

import type { SQL } from "bun";
import { transaction } from "../db";
import { errorResponse } from "../errors";
import { AppleUnavailableError, type ExchangeCode, InvalidTokenError, type VerifyIdentityToken } from "./apple";
import { encryptRefreshToken, newSessionToken, sha256Hex } from "./tokens";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface SignInDeps {
  sql: SQL;
  verifyIdentityToken: VerifyIdentityToken;
  exchangeCode: ExchangeCode;
  // AES-256-GCM key for users.apple_refresh_token.
  refreshTokenKey: CryptoKey;
}

// POST /api/auth/apple (§7.3).
export async function handleSignIn(req: Request, deps: SignInDeps): Promise<Response> {
  const body = await readSignInBody(req);
  if (body === null) {
    return errorResponse(422, "VALIDATION_ERROR", "identity_token, authorization_code, and nonce must be non-empty strings");
  }

  try {
    // 1. The identity token, bound to this sign-in attempt by its nonce.
    const identity = await deps.verifyIdentityToken(body.identity_token);
    if (identity.nonce !== sha256Hex(body.nonce)) throw new InvalidTokenError("Nonce mismatch");

    // 2–3. The code exchange; Apple's own id_token must name the same user.
    const apple = await deps.exchangeCode(body.authorization_code);
    const exchanged = await deps.verifyIdentityToken(apple.idToken);
    if (exchanged.sub !== identity.sub) throw new InvalidTokenError("Token subjects differ");

    // 4. User, purge, and session in one transaction (§4). A blocked user
    // still gets a session (§1.2.16); other endpoints answer 403.
    const userId = identity.sub;
    const sealed = await encryptRefreshToken(deps.refreshTokenKey, userId, apple.refreshToken);
    const sessionToken = newSessionToken();
    const expiresAt = await transaction(deps.sql, async (tx) => {
      await tx`
        INSERT INTO users (id, apple_refresh_token) VALUES (${userId}, ${sealed})
        ON CONFLICT (id) DO UPDATE SET
          apple_refresh_token = EXCLUDED.apple_refresh_token,
          last_active_at      = now(),
          updated_at          = now()`;
      await tx`DELETE FROM sessions WHERE expires_at < now()`;
      const [session] = await tx`
        INSERT INTO sessions (user_id, token_hash, expires_at)
        VALUES (${userId}, ${sha256Hex(sessionToken)}, now() + interval '90 days')
        RETURNING expires_at`;
      return session.expires_at as Date;
    });

    return Response.json({ session_token: sessionToken, expires_at: rfc3339(expiresAt) });
  } catch (err) {
    if (err instanceof InvalidTokenError) return unauthenticated("Sign in with Apple failed");
    if (err instanceof AppleUnavailableError) {
      return errorResponse(503, "APPLE_UNAVAILABLE", "Sign in with Apple is unavailable; retry later");
    }
    throw err;
  }
}

// POST /api/auth/signout (§7.3): no auth check, so a client can always sign
// out cleanly; 204 whether or not a session matched.
export async function handleSignOut(req: Request, { sql }: { sql: SQL }): Promise<Response> {
  const token = bearerToken(req);
  if (token !== null) await sql`DELETE FROM sessions WHERE token_hash = ${sha256Hex(token)}`;
  return new Response(null, { status: 204 });
}

export type ClientAuth = { userId: string } | Response;

// Authenticates a client request by its session token: returns the caller's
// user ID, or the error response to send. Route handlers start with
//
//   const auth = await authenticateClient(req, deps);
//   if (auth instanceof Response) return auth;
//
// Account data is then scoped with `user_id = auth.userId`; contributions are
// reached only through source keys (§7.2). allowBlocked is for the endpoints
// a blocked user may still use (§1.2.16).
export async function authenticateClient(
  req: Request,
  { sql }: { sql: SQL },
  { allowBlocked = false } = {},
): Promise<ClientAuth> {
  const token = bearerToken(req);
  if (token === null) return unauthenticated("Missing session token");

  const [session] = await sql`
    SELECT s.id, s.user_id, s.last_used_at, u.is_blocked, u.last_active_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${sha256Hex(token)} AND s.expires_at > now()`;
  if (!session) return unauthenticated("Invalid or expired session");
  if (session.is_blocked && !allowBlocked) return errorResponse(403, "ACCOUNT_BLOCKED", "Account blocked");

  // Slide the idle expiry at most once a day, so reads don't become writes.
  // The SQL guard keeps concurrent requests from sliding it twice.
  if (Date.now() - (session.last_used_at as Date).getTime() > DAY_MS) {
    await sql`
      UPDATE sessions
      SET last_used_at = now(), expires_at = now() + interval '90 days'
      WHERE id = ${session.id} AND last_used_at < now() - interval '1 day'`;
  }
  // Account activity for the 24-month idle deletion (§1.2.17), at most
  // hourly for the same reason.
  if (Date.now() - (session.last_active_at as Date).getTime() > HOUR_MS) {
    await sql`
      UPDATE users SET last_active_at = now()
      WHERE id = ${session.user_id} AND last_active_at < now() - interval '1 hour'`;
  }
  return { userId: session.user_id };
}

function bearerToken(req: Request): string | null {
  const match = /^Bearer +(\S+)$/i.exec(req.headers.get("authorization")?.trim() ?? "");
  return match?.[1] ?? null;
}

// A 401 always means "sign in again".
function unauthenticated(message: string): Response {
  return errorResponse(401, "UNAUTHENTICATED", message, { headers: { "WWW-Authenticate": "Bearer" } });
}

async function readSignInBody(
  req: Request,
): Promise<{ identity_token: string; authorization_code: string; nonce: string } | null> {
  const body: unknown = await req.json().catch(() => null);
  if (typeof body !== "object" || body === null) return null;
  const { identity_token, authorization_code, nonce } = body as Record<string, unknown>;
  for (const field of [identity_token, authorization_code, nonce]) {
    if (typeof field !== "string" || field === "") return null;
  }
  return body as { identity_token: string; authorization_code: string; nonce: string };
}

// RFC 3339 without fractional seconds, like the API examples (§7).
function rfc3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
