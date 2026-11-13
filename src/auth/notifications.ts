// Apple server-to-server notifications (BACKEND_DESIGN.md §7.3
// `POST /api/auth/apple/notifications`).
//
// Apple posts here when a user changes their Sign in with Apple account;
// the URL is registered for the App ID in the Apple Developer account.
// No session: authenticity comes from Apple's RS256 signature on the
// `payload` JWT, verified the §7.1 way (no `exp` on notifications).
//
// The handler never logs the payload or the parsed events: notification
// bodies carry the user's email address, which the farm never stores or
// logs (§8).

import type { SQL } from "bun";
import type { JWTPayload } from "jose";
import { errorResponse } from "../errors";
import type { R2Client } from "../r2/client";
import { InvalidTokenError, type VerifyAppleJwt } from "./apple";
import { deleteAccountData } from "./account";

export interface NotificationsDeps {
  sql: SQL;
  r2: R2Client;
  verifyNotificationPayload: VerifyAppleJwt;
}

export async function handleAppleNotifications(req: Request, deps: NotificationsDeps): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const payload = body?.payload;
  if (typeof payload !== "string" || payload === "") {
    return errorResponse(422, "VALIDATION_ERROR", "payload must be a non-empty string");
  }

  let claims: JWTPayload;
  try {
    claims = await deps.verifyNotificationPayload(payload);
  } catch (err) {
    // A forged or malformed payload is the sender's fault (401); a JWKS
    // outage is the farm's (500), since whether Apple redelivers is
    // undocumented (§7.3).
    if (err instanceof InvalidTokenError) return errorResponse(401, "UNAUTHENTICATED", "Invalid notification signature");
    throw err;
  }

  const event = parseEvent(claims.events);
  if (event === null) return new Response(null, { status: 200 }); // Unknown type: no-op.
  const [user] = await deps.sql`SELECT id FROM users WHERE id = ${event.sub}`;
  if (!user) return new Response(null, { status: 200 }); // Unknown sub: no-op.

  switch (event.type) {
    case "consent-revoked": {
      // The user stopped using Sign in with Apple for the app; Apple has
      // already invalidated the refresh token, so the stored ciphertext is
      // cleared. Contributions stay; the user can sign in again, or delete
      // the account.
      await deps.sql`DELETE FROM sessions WHERE user_id = ${event.sub}`;
      await deps.sql`UPDATE users SET apple_refresh_token = NULL WHERE id = ${event.sub}`;
      return new Response(null, { status: 200 });
    }
    case "account-deleted": {
      // The user deleted their Apple Account and can never sign in again
      // to delete their data: run `DELETE /api/account` steps 2 and 3.
      try {
        await deleteAccountData(deps.sql, deps.r2, event.sub);
      } catch {
        return errorResponse(500, "INTERNAL", "Could not delete the account data; retry later");
      }
      return new Response(null, { status: 200 });
    }
    case "email-enabled":
    case "email-disabled":
      // Ignored. These events carry an email address, which the farm never
      // stores or logs (§8).
      return new Response(null, { status: 200 });
    default:
      return new Response(null, { status: 200 }); // Unknown type: no-op.
  }
}

// The `events` claim, which Apple documents as an object but may arrive as
// a JSON-encoded string (§7.3). Returns null when the type or sub cannot be
// determined — the caller treats that as a no-op.
function parseEvent(events: unknown): { type: string; sub: string } | null {
  let value: unknown = events;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const { type, sub } = value as Record<string, unknown>;
  if (typeof type !== "string" || type === "" || typeof sub !== "string" || sub === "") return null;
  return { type, sub };
}
