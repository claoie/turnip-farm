// Country backstop (BACKEND_DESIGN.md §7.2, §8.1).

import { describe, expect, test } from "bun:test";
import { BLOCKED_CONTRIBUTION_COUNTRIES, refuseBlockedRegion } from "./region";

const req = (country?: string) =>
  new Request("http://farm.test/api/sources", {
    method: "POST",
    headers: country === undefined ? {} : { "CF-IPCountry": country },
  });

describe("refuseBlockedRegion", () => {
  test("covers exactly the EU 27, IS, LI, NO and GB", () => {
    expect(BLOCKED_CONTRIBUTION_COUNTRIES.size).toBe(31);
    for (const code of ["DE", "FR", "IE", "SE", "HR", "IS", "LI", "NO", "GB"]) {
      expect(BLOCKED_CONTRIBUTION_COUNTRIES.has(code)).toBe(true);
    }
    // Switzerland is in neither the EU nor the EEA; "UK" is not the ISO code.
    for (const code of ["US", "CH", "UK", "XX", "T1"]) {
      expect(BLOCKED_CONTRIBUTION_COUNTRIES.has(code)).toBe(false);
    }
  });

  test("403 REGION_UNAVAILABLE for a blocked country, any case", async () => {
    for (const country of ["GB", "de", " NO "]) {
      const res = refuseBlockedRegion(req(country));
      expect(res?.status).toBe(403);
      const body = (await res!.json()) as { error: { code: string; details: unknown } };
      expect(body.error.code).toBe("REGION_UNAVAILABLE");
      expect(body.error.details).toEqual({});
    }
  });

  test("null for other countries, Cloudflare's unknown codes, and a missing header", () => {
    expect(refuseBlockedRegion(req("US"))).toBeNull();
    expect(refuseBlockedRegion(req("CH"))).toBeNull();
    expect(refuseBlockedRegion(req("XX"))).toBeNull();
    expect(refuseBlockedRegion(req())).toBeNull();
    expect(refuseBlockedRegion(req(""))).toBeNull();
  });
});
