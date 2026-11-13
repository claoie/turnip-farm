import { SQL } from "bun";
import { join, resolve } from "node:path";
import { startServer } from "./app";
import { createAppleJwtVerifier, createAppleRevoker, createAppleTokenVerifier, createCodeExchanger, importApplePrivateKey } from "./auth/apple";
import { importRefreshTokenKey } from "./auth/tokens";
import { type Config, ConfigError, loadConfig } from "./config";
import { deleteIdleAccounts } from "./auth/account";
import { purgeExpiredAttribution } from "./contrib/purge";
import { R2BlobStore } from "./ingest/store";
import { createPostgresSourceStore, startIngestPoller } from "./ingest/worker";
import { startSegmenter } from "./ingest/segmenter";
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

const r2 = createR2Client(config.r2);
const refreshTokenKey = await importRefreshTokenKey(config.apple.refreshTokenKey);
const revokeRefreshToken = createAppleRevoker({ credentials: appleCredentials });

// Retention jobs (§1.2.17, §4), at startup and hourly: the report purge
// (and the 30-day attribution purge for accounts that only agreed to the
// 30-day disclosure), then the 24-month idle-account deletion. Failures are
// logged, never fatal; the next run retries.
const retention = async () => {
  await purgeExpiredAttribution(sql).catch((err) => console.error("retention purge failed:", err));
  await deleteIdleAccounts({ sql, r2, refreshTokenKey, revokeRefreshToken })
    .then(({ deleted, failed }) => {
      if (deleted > 0 || failed > 0) console.log(`idle accounts: ${deleted} deleted, ${failed} failed`);
    })
    .catch((err) => console.error("idle-account deletion failed:", err));
};
await retention();
const retentionTimer = setInterval(retention, 60 * 60 * 1000);
retentionTimer.unref?.();

// The built web client lives next to the server bundle (build/client).
// Run from source there is no build, so the API runs without file serving
// and Vite serves the client in development (bun run dev).
const clientCandidate = resolve(import.meta.dir, "..", "client");
const clientDir = (await Bun.file(join(clientCandidate, "index.html")).exists())
  ? clientCandidate
  : undefined;

const server = startServer(config.port, {
  sql,
  verifyIdentityToken: createAppleTokenVerifier({ audience: config.appBundleId }),
  exchangeCode: createCodeExchanger({ credentials: appleCredentials }),
  // Server-to-server notifications carry no `exp` (§7.1).
  verifyNotificationPayload: createAppleJwtVerifier({ audience: config.appBundleId, requireExp: false }),
  revokeRefreshToken,
  refreshTokenKey,
  r2,
  pipelineKey: config.pipelineKey,
  currentDisclosureVersion: config.currentDisclosureVersion,
  limits: {
    // §7.2 suggestions: 60/min per user on POSTs, 10/min per IP on sign-in
    // and notifications, 30/min per IP on the public GET endpoints.
    user: new TokenBucket(60, 60),
    ip: new TokenBucket(10, 10),
    publicIp: new TokenBucket(30, 30),
    trustedProxies: config.trustedProxies,
  },
}, { clientDir });
console.log(`turnip-farm listening on ${server.url}`);

// The ingest worker's "or poll" trigger (BACKEND_DESIGN.md §1.2.10):
// sweep the staging prefix on an interval. Optional env override;
// 0 disables (e.g. when R2 event notifications drive ingest instead).
const ingestIntervalMs = parseIngestIntervalMs(process.env.INGEST_POLL_INTERVAL_MS);
let stopIngest: (() => void) | undefined;
let stopSegmenter: (() => void) | undefined;
if (ingestIntervalMs > 0) {
  const store = new R2BlobStore(config.r2);
  stopIngest = startIngestPoller({ store, sources: createPostgresSourceStore(sql) }, ingestIntervalMs);
  // Training segments are cut from stored blobs once clips arrive
  // (BACKEND_DESIGN.md §1.2.24), on the same interval.
  stopSegmenter = startSegmenter({ sql, store }, ingestIntervalMs);
  console.log(`ingest poller and segmenter running every ${ingestIntervalMs}ms`);
}

// Graceful shutdown on SIGTERM, which `docker stop` and `systemctl restart`
// send: stop accepting connections, let in-flight requests finish, then
// close the database pool. Without a handler, Bun as a container's PID 1
// ignores SIGTERM and is killed mid-request when the grace period ends.
let stopping = false;
process.on("SIGTERM", async () => {
  if (stopping) return;
  stopping = true;
  console.log("turnip-farm shutting down");
  clearInterval(retentionTimer);
  stopIngest?.();
  stopSegmenter?.();
  await server.stop();
  await sql.end();
  process.exit(0);
});

function parseIngestIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 30_000;
  const ms = Number(raw);
  return Number.isInteger(ms) && ms >= 0 ? ms : 30_000;
}
