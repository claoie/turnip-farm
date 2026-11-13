// Contribution consent (BACKEND_DESIGN.md §1.2.17, §7.3 POST /api/consent).
// The app records each agreement to its contribution disclosure here, and
// the contribution writes refuse an account that has not agreed to the
// current version, so a disclosure change asks everyone again once.

import type { SQL } from "bun";
import type { RateLimits } from "./app";
import { authenticateClient } from "./auth/sessions";
import { readJsonObject } from "./contrib/validate";
import { errorResponse } from "./errors";
import { refuseBlockedRegion } from "./region";

/**
 * The first disclosure version that tells users attribution is kept until
 * they delete it. Accounts that never agreed to it or a later one were told
 * 30 days, so their attribution keeps the 30-day purge (src/contrib/purge.ts).
 * A historical fact, not a setting.
 */
export const RETENTION_UNTIL_DELETION_DISCLOSURE = 3;

// Postgres INTEGER.
const MAX_DISCLOSURE_VERSION = 2_147_483_647;

export interface ConsentDeps {
  sql: SQL;
  limits: RateLimits;
  /** The disclosure version contribution requires (`CURRENT_DISCLOSURE_VERSION`). */
  currentDisclosureVersion: number;
}

// POST /api/consent {"disclosure_version": int, "age_confirmed": true} → 204.
export async function handlePostConsent(req: Request, deps: ConsentDeps): Promise<Response> {
  const region = refuseBlockedRegion(req);
  if (region) return region;
  const auth = await authenticateClient(req, deps);
  if (auth instanceof Response) return auth;
  if (!deps.limits.user.take(auth.userId)) {
    return errorResponse(429, "RATE_LIMITED", "Too many requests", {
      headers: { "Retry-After": String(deps.limits.user.retryAfterSec(auth.userId)) },
    });
  }

  const body = await readJsonObject(req);
  const version = body?.disclosure_version;
  if (!Number.isInteger(version) || (version as number) < 1 || (version as number) > MAX_DISCLOSURE_VERSION) {
    return errorResponse(422, "VALIDATION_ERROR", "disclosure_version must be a positive integer", {
      details: { field: "disclosure_version" },
    });
  }
  if (body?.age_confirmed !== true) {
    return errorResponse(422, "VALIDATION_ERROR", "age_confirmed must be true", {
      details: { field: "age_confirmed" },
    });
  }

  await deps.sql`
    INSERT INTO consents (user_id, disclosure_version)
    VALUES (${auth.userId}, ${version as number})
    ON CONFLICT (user_id, disclosure_version) DO NOTHING`;
  return new Response(null, { status: 204 });
}

/**
 * `403 CONSENT_REQUIRED` unless the account agreed to the current
 * disclosure version or a later one, else null. The contribution writes
 * call it after authentication and rate limiting, before any other work.
 */
export async function requireConsent(
  sql: SQL,
  userId: string,
  currentDisclosureVersion: number,
): Promise<Response | null> {
  const [row] = await sql`
    SELECT 1 FROM consents
    WHERE user_id = ${userId} AND disclosure_version >= ${currentDisclosureVersion}
    LIMIT 1`;
  if (row) return null;
  return errorResponse(403, "CONSENT_REQUIRED", "Agree to the current contribution disclosure first", {
    details: { disclosure_version: currentDisclosureVersion },
  });
}
