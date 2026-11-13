// Country backstop for contribution (BACKEND_DESIGN.md §7.2, §8.1).
// The app hides contribution on EU, EEA and UK storefronts; this refuses
// the contribution entry points when Cloudflare places the request in one
// of those countries. A missing header passes: requests that reach the
// farm without Cloudflare in front (tests, local runs) carry none, and the
// header is only a backstop behind the app's own check. A client that sets
// the header itself can only refuse itself or claim a country it could
// equally get by omitting the header.

import { errorResponse } from "./errors";

/** ISO 3166-1 alpha-2 codes where contribution is switched off: EU 27, the EEA's IS, LI and NO, and GB. */
export const BLOCKED_CONTRIBUTION_COUNTRIES: ReadonlySet<string> = new Set([
  // EU 27
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  // EEA outside the EU
  "IS", "LI", "NO",
  // United Kingdom
  "GB",
]);

/** Cloudflare's visitor-country header. */
export const COUNTRY_HEADER = "cf-ipcountry";

/**
 * `403 REGION_UNAVAILABLE` when the request's country is one where
 * contribution is switched off, else null. Call it before any other work
 * in a contribution entry point, so a refused request touches nothing.
 */
export function refuseBlockedRegion(req: Request): Response | null {
  const country = req.headers.get(COUNTRY_HEADER)?.trim().toUpperCase();
  if (country === undefined || !BLOCKED_CONTRIBUTION_COUNTRIES.has(country)) return null;
  return errorResponse(403, "REGION_UNAVAILABLE", "Contribution is not available in this region");
}
