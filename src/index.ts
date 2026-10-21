import { SQL } from "bun";
import { startServer } from "./app";
import { createAppleJwtVerifier, createAppleRevoker, createAppleTokenVerifier, createCodeExchanger, importApplePrivateKey } from "./auth/apple";
import { importRefreshTokenKey } from "./auth/tokens";
import { type Config, ConfigError, loadConfig } from "./config";
import { purgeExpiredAttribution } from "./contrib/purge";
import { R2BlobStore } from "./ingest/store";
import { createPostgresSourceStore, startIngestPoller } from "./ingest/worker";
import { createR2Client } from "./r2/client";
import { TokenBucket } from "./ratelimit";

function loadConfigOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}

// The .p8 key passes the PEM shape check in config but can still be
// malformed; importing it here fails fast in the same error format.
async function importApplePrivateKeyOrExit(pem: string): Promise<CryptoKey> {
  try {
    return await importApplePrivateKey(pem);
  } catch {
    console.error(new ConfigError(["APPLE_PRIVATE_KEY is not a valid ES256 PKCS#8 key"]).message);
    process.exit(1);
  }
}

const config = loadConfigOrExit();
const privateKey = await importApplePrivateKeyOrExit(config.apple.privateKeyPem);
const sql = new SQL(config.databaseUrl);

// The farm's Sign in with Apple credentials: the code exchange and the
// token revocation authenticate with the same client secret (§7.1).
const appleCredentials = {
  teamId: config.apple.teamId,
  keyId: config.apple.keyId,
  clientId: config.appBundleId,
  privateKey,
};

// 30-day attribution/report purge (§1.2.17, §4): at startup and hourly.
// Failures are logged, never fatal: a late purge never extends the link
// because every attribution read also filters the 30-day window.
const purge = () =>
  purgeExpiredAttribution(sql).catch((err) => console.error("attribution purge failed:", err));
await purge();
const purgeTimer = setInterval(purge, 60 * 60 * 1000);
purgeTimer.unref?.();

const server = startServer(config.port, {
  sql,
  verifyIdentityToken: createAppleTokenVerifier({ audience: config.appBundleId }),
  exchangeCode: createCodeExchanger({ credentials: appleCredentials }),
  // Server-to-server notifications carry no `exp` (§7.1).
  verifyNotificationPayload: createAppleJwtVerifier({ audience: config.appBundleId, requireExp: false }),
  revokeRefreshToken: createAppleRevoker({ credentials: appleCredentials }),
  refreshTokenKey: await importRefreshTokenKey(config.apple.refreshTokenKey),
  r2: createR2Client(config.r2),
  pipelineKey: config.pipelineKey,
  limits: {
    // §7.2 suggestions: 60/min per user on POSTs, 10/min per IP on sign-in
    // and notifications, 30/min per IP on the public GET endpoints.
    user: new TokenBucket(60, 60),
    ip: new TokenBucket(10, 10),
    publicIp: new TokenBucket(30, 30),
    trustedProxies: config.trustedProxies,
  },
});
console.log(`turnip-farm listening on ${server.url}`);

// The ingest worker's "or poll" trigger (BACKEND_DESIGN.md §1.2.10):
// sweep the staging prefix on an interval. Optional env override;
// 0 disables (e.g. when R2 event notifications drive ingest instead).
const ingestIntervalMs = parseIngestIntervalMs(process.env.INGEST_POLL_INTERVAL_MS);
if (ingestIntervalMs > 0) {
  startIngestPoller(
    { store: new R2BlobStore(config.r2), sources: createPostgresSourceStore(sql) },
    ingestIntervalMs,
  );
  console.log(`ingest poller running every ${ingestIntervalMs}ms`);
}

function parseIngestIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 30_000;
  const ms = Number(raw);
  return Number.isInteger(ms) && ms >= 0 ? ms : 30_000;
}
