// Test-only stand-ins for Sign in with Apple: one local server playing
// Apple's JWKS and token endpoints, plus the farm's own ES256 credentials.

import type { SQL } from "bun";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { APPLE_ISSUER, type AppleCredentials } from "./apple";
import { deriveCandidateKey } from "../labels";

export const AUDIENCE = "kim.hoie.turnip";
export const SUB = "001234.0123456789abcdef0123456789abcdef.0123";
export const APPLE_REFRESH_TOKEN = "apple-refresh-token";

// A database handle that fails the test if a request ever reaches it.
export const noDatabase = (() => {
  throw new Error("the database was queried");
}) as unknown as SQL;

type TokenEndpoint = (form: URLSearchParams) => Response | Promise<Response>;

export interface IdentityTokenOptions {
  kid?: string;
  // An RSA private key signs RS256; a shared secret signs HS256.
  key?: CryptoKey | Uint8Array;
  claims?: Record<string, unknown>;
}

const now = () => Math.floor(Date.now() / 1000);

export async function startMockApple() {
  const apple = await generateKeyPair("RS256", { extractable: true });
  const appleJwk = { ...(await exportJWK(apple.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const farmKey = await generateKeyPair("ES256");

  const credentials: AppleCredentials = {
    teamId: "TEAM123456",
    keyId: "KEY1234567",
    clientId: AUDIENCE,
    privateKey: farmKey.privateKey,
  };

  // Shaped like Apple's identity token, including the email claims the farm
  // must never keep.
  function identityToken({ kid = "k1", key = apple.privateKey, claims = {} }: IdentityTokenOptions = {}) {
    return new SignJWT({
      iss: APPLE_ISSUER,
      aud: AUDIENCE,
      sub: SUB,
      iat: now(),
      exp: now() + 600,
      email: "abc@privaterelay.appleid.com",
      is_private_email: true,
      ...claims,
    })
      .setProtectedHeader({ alg: key instanceof Uint8Array ? "HS256" : "RS256", kid })
      .sign(key);
  }

  const succeed: TokenEndpoint = async () =>
    Response.json({
      access_token: "apple-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: APPLE_REFRESH_TOKEN,
      id_token: await identityToken(),
    });

  // Shaped like Apple's server-to-server notification payload (§7.3): signed
  // like an identity token but with no `exp` (§7.1), carrying `iss`, `aud`,
  // `iat`, `jti`, and the `events` claim (an object, or a JSON string — see
  // parseEvent). Like Apple's real payloads, there is no top-level `sub`:
  // the subject lives inside `events`.
  function notificationPayload({ kid = "k1", key = apple.privateKey, claims = {} }: IdentityTokenOptions = {}) {
    return new SignJWT({
      iss: APPLE_ISSUER,
      aud: AUDIENCE,
      iat: now(),
      jti: "mock-jti-123",
      ...claims,
    })
      .setProtectedHeader({ alg: key instanceof Uint8Array ? "HS256" : "RS256", kid })
      .sign(key);
  }

  let tokenEndpoint = succeed;
  const tokenRequests: URLSearchParams[] = [];

  // The revoke endpoint answers 200 with an empty body, as Apple does —
  // both when it revokes the token and when the token was already invalid.
  let revokeEndpoint: TokenEndpoint = () => new Response(null, { status: 200 });
  const revokeRequests: URLSearchParams[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/auth/keys") return Response.json({ keys: [appleJwk] });
      if (pathname === "/auth/token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        tokenRequests.push(form);
        return tokenEndpoint(form);
      }
      if (pathname === "/auth/revoke" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        revokeRequests.push(form);
        return revokeEndpoint(form);
      }
      return new Response(null, { status: 404 });
    },
  });

  return {
    jwksUrl: new URL("/auth/keys", server.url),
    tokenUrl: new URL("/auth/token", server.url),
    revokeUrl: new URL("/auth/revoke", server.url),
    credentials,
    farmPublicKey: farmKey.publicKey,
    identityToken,
    notificationPayload,
    // Every form posted to the token endpoint, oldest first.
    tokenRequests,
    respondWith(endpoint: TokenEndpoint) {
      tokenEndpoint = endpoint;
    },
    // Every form posted to the revoke endpoint, oldest first.
    revokeRequests,
    respondWithRevoke(endpoint: TokenEndpoint) {
      revokeEndpoint = endpoint;
    },
    reset() {
      tokenEndpoint = succeed;
      tokenRequests.length = 0;
      revokeEndpoint = () => new Response(null, { status: 200 });
      revokeRequests.length = 0;
    },
    stop: () => server.stop(true),
  };
}

export type MockApple = Awaited<ReturnType<typeof startMockApple>>;

// The label-candidate HMAC key (§1.2.25) for tests, derived from 32 zero bytes.
export const testCandidateKey = await deriveCandidateKey(new Uint8Array(32));
