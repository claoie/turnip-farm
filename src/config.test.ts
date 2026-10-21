import { describe, expect, test } from "bun:test";
import { ConfigError, DEFAULT_PORT, REQUIRED_ENV, loadConfig } from "./config";
import { parseProxyRange } from "./ratelimit";

const PEM_LINES = ["-----BEGIN PRIVATE KEY-----", "MIGTAgEAMBMGByqGSM49AgEGCCqGSM49", "-----END PRIVATE KEY-----"];
const REFRESH_KEY_BYTES = new Uint8Array(32).fill(7);

const FULL_ENV = {
  DATABASE_URL: "postgres://turnip:turnip@localhost:5432/turnip",
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "access-key",
  R2_SECRET_ACCESS_KEY: "secret-key",
  R2_BUCKET: "turnip",
  APP_BUNDLE_ID: "kim.hoie.turnip",
  APPLE_TEAM_ID: "TEAM123456",
  APPLE_KEY_ID: "KEY1234567",
  // One line with literal \n escapes, as a .env file usually carries it.
  APPLE_PRIVATE_KEY: PEM_LINES.join("\\n"),
  APPLE_REFRESH_TOKEN_KEY: Buffer.from(REFRESH_KEY_BYTES).toString("base64"),
  TURNIP_PIPELINE_KEY: "pipeline-key",
};

function problemsFor(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  test("maps a complete environment", () => {
    expect(loadConfig(FULL_ENV)).toEqual({
      port: DEFAULT_PORT,
      databaseUrl: FULL_ENV.DATABASE_URL,
      r2: {
        accountId: "account",
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
        bucket: "turnip",
      },
      appBundleId: "kim.hoie.turnip",
      apple: {
        teamId: "TEAM123456",
        keyId: "KEY1234567",
        privateKeyPem: PEM_LINES.join("\n"),
        refreshTokenKey: REFRESH_KEY_BYTES,
      },
      pipelineKey: "pipeline-key",
      trustedProxies: [],
    });
  });

  test("accepts a PEM with real newlines", () => {
    const config = loadConfig({ ...FULL_ENV, APPLE_PRIVATE_KEY: PEM_LINES.join("\n") });
    expect(config.apple.privateKeyPem).toBe(PEM_LINES.join("\n"));
  });

  test("reports every missing variable at once", () => {
    expect(problemsFor({})).toEqual(REQUIRED_ENV.map((name) => `${name} is required`));
  });

  test("reports only the variables that are missing", () => {
    const { R2_BUCKET, APP_BUNDLE_ID, ...partial } = FULL_ENV;
    expect(problemsFor(partial)).toEqual(["R2_BUCKET is required", "APP_BUNDLE_ID is required"]);
  });

  test("treats blank values as missing", () => {
    expect(problemsFor({ ...FULL_ENV, DATABASE_URL: "  " })).toEqual([
      "DATABASE_URL is required",
    ]);
  });

  test("reads PORT", () => {
    expect(loadConfig({ ...FULL_ENV, PORT: "8080" }).port).toBe(8080);
  });

  test.each(["abc", "0", "65536", "80.5", "-1"])("rejects PORT=%p", (port) => {
    expect(problemsFor({ ...FULL_ENV, PORT: port })).toEqual([
      `PORT must be an integer between 1 and 65535 (got "${port}")`,
    ]);
  });

  test("rejects an APPLE_PRIVATE_KEY that isn't a PKCS#8 PEM", () => {
    expect(problemsFor({ ...FULL_ENV, APPLE_PRIVATE_KEY: "not-a-key" })).toEqual([
      "APPLE_PRIVATE_KEY must be the PKCS#8 PEM contents of the .p8 key",
    ]);
  });

  test.each([
    ["too short", Buffer.alloc(16).toString("base64")],
    ["too long", Buffer.alloc(33).toString("base64")],
    ["not base64", "%".repeat(44)],
  ])("rejects an APPLE_REFRESH_TOKEN_KEY that is %s", (_, key) => {
    expect(problemsFor({ ...FULL_ENV, APPLE_REFRESH_TOKEN_KEY: key })).toEqual([
      "APPLE_REFRESH_TOKEN_KEY must be 32 random bytes, base64-encoded",
    ]);
  });

  test("reads TRUSTED_PROXIES, skipping blank entries", () => {
    expect(loadConfig({ ...FULL_ENV, TRUSTED_PROXIES: " 172.16.0.0/12, fd00::/8, " }).trustedProxies).toEqual([
      parseProxyRange("172.16.0.0/12")!,
      parseProxyRange("fd00::/8")!,
    ]);
    expect(loadConfig({ ...FULL_ENV, TRUSTED_PROXIES: " " }).trustedProxies).toEqual([]);
  });

  test("rejects each TRUSTED_PROXIES entry that isn't an address or range", () => {
    expect(problemsFor({ ...FULL_ENV, TRUSTED_PROXIES: "172.16.0.0/12, docker, 10.0.0.0/33" })).toEqual([
      'TRUSTED_PROXIES entry "docker" is not an IP address or CIDR range',
      'TRUSTED_PROXIES entry "10.0.0.0/33" is not an IP address or CIDR range',
    ]);
  });

  test("message lists every problem", () => {
    expect(() => loadConfig({ PORT: "x" })).toThrow(/DATABASE_URL is required[\s\S]*PORT must be/);
  });
});
