// Env-based configuration. Every variable is checked at startup and all
// problems are reported together, so a misconfigured deploy fails fast with
// one actionable message instead of crashing on first use.

import { type ProxyRange, parseProxyRange } from "./ratelimit";

export interface Config {
  port: number;
  databaseUrl: string;
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
  };
  // Sign in with Apple `aud` claim and client_id (BACKEND_DESIGN.md §7.1).
  appBundleId: string;
  // The farm's Sign in with Apple credentials (BACKEND_DESIGN.md §7.1).
  apple: {
    teamId: string;
    keyId: string;
    // PKCS#8 PEM of the .p8 key; imported (and fully validated) at startup.
    privateKeyPem: string;
    // AES-256-GCM key for users.apple_refresh_token: exactly 32 bytes.
    refreshTokenKey: Uint8Array<ArrayBuffer>;
  };
  // Service key for the pipeline endpoints (BACKEND_DESIGN.md §7.1).
  pipelineKey: string;
  // Proxies, besides loopback, whose X-Forwarded-For per-IP rate limits
  // read through (BACKEND_DESIGN.md §7.2). Empty when unset.
  trustedProxies: ProxyRange[];
}

export const REQUIRED_ENV = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "APP_BUNDLE_ID",
  "APPLE_TEAM_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
  "APPLE_REFRESH_TOKEN_KEY",
  "TURNIP_PIPELINE_KEY",
] as const;

export const DEFAULT_PORT = 3000;

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: Env): Config {
  const problems: string[] = [];

  const required = {} as Record<(typeof REQUIRED_ENV)[number], string>;
  for (const name of REQUIRED_ENV) {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      problems.push(`${name} is required`);
    } else {
      required[name] = value;
    }
  }

  const port = parsePort(env.PORT);
  if (port === null) {
    problems.push(`PORT must be an integer between 1 and 65535 (got "${env.PORT}")`);
  }

  // .env files often carry the PEM on one line with literal \n escapes.
  const privateKeyPem = required.APPLE_PRIVATE_KEY?.replaceAll("\\n", "\n").trim();
  if (privateKeyPem !== undefined && !privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----")) {
    problems.push("APPLE_PRIVATE_KEY must be the PKCS#8 PEM contents of the .p8 key");
  }

  const refreshTokenKey = parseKey(required.APPLE_REFRESH_TOKEN_KEY);
  if (required.APPLE_REFRESH_TOKEN_KEY !== undefined && refreshTokenKey === null) {
    problems.push("APPLE_REFRESH_TOKEN_KEY must be 32 random bytes, base64-encoded");
  }

  const trustedProxies: ProxyRange[] = [];
  for (const entry of (env.TRUSTED_PROXIES ?? "").split(",")) {
    if (entry.trim() === "") continue;
    const range = parseProxyRange(entry);
    if (range === null) {
      problems.push(`TRUSTED_PROXIES entry "${entry.trim()}" is not an IP address or CIDR range`);
    } else {
      trustedProxies.push(range);
    }
  }

  if (problems.length > 0 || port === null || privateKeyPem === undefined || refreshTokenKey === null) {
    throw new ConfigError(problems);
  }

  return {
    port,
    databaseUrl: required.DATABASE_URL,
    r2: {
      accountId: required.R2_ACCOUNT_ID,
      accessKeyId: required.R2_ACCESS_KEY_ID,
      secretAccessKey: required.R2_SECRET_ACCESS_KEY,
      bucket: required.R2_BUCKET,
    },
    appBundleId: required.APP_BUNDLE_ID,
    apple: {
      teamId: required.APPLE_TEAM_ID,
      keyId: required.APPLE_KEY_ID,
      privateKeyPem,
      refreshTokenKey,
    },
    pipelineKey: required.TURNIP_PIPELINE_KEY,
    trustedProxies,
  };
}

function parseKey(raw: string | undefined): Uint8Array<ArrayBuffer> | null {
  if (raw === undefined || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.trim())) return null;
  const bytes = Buffer.from(raw.trim(), "base64");
  return bytes.length === 32 ? new Uint8Array(bytes) : null;
}

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  if (!/^\d+$/.test(raw.trim())) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}
