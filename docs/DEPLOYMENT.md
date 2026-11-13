# Deployment runbook

Covers turnip-farm#12. The first production farm: one DigitalOcean Basic
droplet (Ubuntu 24.04) running the Bun service under systemd, self-hosted
Postgres 16, Caddy as the TLS reverse proxy, Cloudflare DNS, and R2 for pose
blobs and model artifacts only — never video (`docs/MASTER_PLAN.md` §1).
The API is stateless in the deployment sense (`docs/BACKEND_DESIGN.md`
§7.1): everything durable lives in Postgres and R2. Budget is roughly
$15–30/month, including a later cutover to managed Postgres by swapping
`DATABASE_URL`.

## 0. Before the first deployment — blockers

These are decisions, not tasks. They land **before** the first deploy:

- **Unlinking: final or reversed** (`BACKEND_DESIGN.md` §9 Q9, master plan
  §1). If counsel's answer reverses unlinking contributions from accounts,
  the reversal lands while restoring `sources.user_id` is still a plain
  additive migration.
- **Multi-device `video_id`** (master plan §9 Q2). Whether `video_id`
  derives from an identifier that is the same on all of a user's devices
  has to be settled before the first contribution ships — changing the
  derivation afterwards orphans every contributed source.

## 1. Provisioning

1. Create the droplet: DigitalOcean Basic, Ubuntu 24.04, in the region
   closest to most contributors.
2. Point DNS at it (Cloudflare): `A farm.example.com → <droplet ip>`.
   The exact hostname is the maintainer's call; `farm.example.com` below
   is a placeholder.
   Keep the record proxied (orange cloud): the farm's country backstop
   reads Cloudflare's `CF-IPCountry` header, which a DNS-only record
   never carries (`BACKEND_DESIGN.md` §7.2). A proxied record also puts
   Cloudflare's edge in front of Caddy, so add Cloudflare's published
   IP ranges to `TRUSTED_PROXIES` (§2), or every client shares the
   per-IP rate limit of the edge address it came through.
3. Create a non-root deploy user, lock down SSH (key-only), enable
   `ufw` allowing 22, 80, 443.
4. Create the service user and its layout (as root) — the systemd unit
   in §4 runs as this user:
   `useradd --system --shell /usr/sbin/nologin turnip-farm`
   `mkdir -p /opt/turnip-farm /etc/turnip-farm`
   `chown turnip-farm:turnip-farm /opt/turnip-farm /etc/turnip-farm`
5. Install the runtime dependencies:
   - Bun, installed system-wide: `BUN_INSTALL=/usr/local bash` on the
     bun.sh installer gives `/usr/local/bin/bun` (see `packageManager`
     in `package.json` for the pinned version). Do NOT install as root into
     `/root/.bun` — `/root` is mode `0700`, so the service user gets
     EACCES on the binary itself.
   - Postgres 16 (`postgresql-16`), `postgresql-client-16` for `pg_dump`.
   - Caddy.
   - `dbmate` is a devDependency (`bun run db:migrate`); no separate
     install needed.

## 2. Environment

`src/config.ts` fails fast at startup: every variable in `REQUIRED_ENV`
must be present and non-empty, and all problems are reported together.
Keep them in a systemd `EnvironmentFile` (e.g.
`/etc/turnip-farm/env`), owned by the service user, mode `600`.

| Variable | Source |
|---|---|
| `DATABASE_URL` | `postgres://<role>:<password>@localhost:5432/turnip_farm` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare R2; one bucket for pose blobs and model artifacts |
| `APP_BUNDLE_ID` | The iOS app's bundle id — the Sign in with Apple `aud` claim (`BACKEND_DESIGN.md` §7.1) |
| `APPLE_TEAM_ID`, `APPLE_KEY_ID` | Apple Developer account |
| `APPLE_PRIVATE_KEY` | PKCS#8 PEM of the `.p8` key, on one line with newlines as `\n` (`src/config.ts` decodes them). A literal multiline PEM does NOT work: systemd's `EnvironmentFile` ignores lines without `=`, so only the first line would load — it passes the PKCS#8-header shape check, then `importApplePrivateKey` fails at startup and the service exits 1 |
| `APPLE_REFRESH_TOKEN_KEY` | 32 random bytes (base64) — the AES-256-GCM key for `users.apple_refresh_token`. Generate with `openssl rand -base64 32` |
| `TURNIP_PIPELINE_KEY` | Random service key for the pipeline endpoints (`BACKEND_DESIGN.md` §7.1). See §9 for rotation |
| `PORT` | Optional; defaults to `3000` |
| `INGEST_POLL_INTERVAL_MS` | Optional; ingest poll interval, defaults to `30000`. `0` disables the poller (e.g. when R2 event notifications drive ingest instead) |
| `CURRENT_DISCLOSURE_VERSION` | Optional; defaults to `3`. The contribution disclosure version an account must have agreed to (`POST /api/consent`) before contributing (`BACKEND_DESIGN.md` §7.3). Raise it only after the app release with the new wording is live: every account is then asked again on its next contribution |
| `TRUSTED_PROXIES` | Optional; trusted proxy addresses and CIDRs, comma-separated (`src/config.ts` validates the entries, `src/index.ts` feeds them to the rate-limit client-address walk). Set it to the proxy's subnet when the service sits behind a proxy on a non-loopback network (e.g. the Docker/CD image path) — otherwise every client looks like the proxy's address. Harmless to omit behind Caddy on loopback (`BACKEND_DESIGN.md` §7.2) |

## 3. Postgres

1. Create the role and database:
   `CREATE ROLE turnip_farm LOGIN PASSWORD '<password>';`
   `CREATE DATABASE turnip_farm OWNER turnip_farm;`
2. Run migrations: with `DATABASE_URL` in the environment,
   `bun run db:migrate` (dbmate, `db/migrations/`). Migrations are
   additive by convention — nothing here rewrites history.
3. Backups (§8 / §9 Q10 — **30 days max**): nightly
   `pg_dump --format=custom` to a local directory, then prune anything
   older than 30 days (`find <dir> -name '*.dump' -mtime +30 -delete`).
   A backup older than 30 days still holds deleted accounts and their
   contributions: a privacy defect, not an ops nicety.

## 4. The Bun service

Build once per deploy: `bun install --frozen-lockfile && bun run build`
produces `build/` (the server bundle in `build/server/` and the web
client in `build/client/`). Start with `bun run start`
(`bun build/server/bundle.js`).

systemd unit (`/etc/systemd/system/turnip-farm.service`):

```ini
[Unit]
Description=Turnip farm API
After=network.target postgresql.service

[Service]
User=turnip-farm
WorkingDirectory=/opt/turnip-farm
EnvironmentFile=/etc/turnip-farm/env
ExecStart=/usr/local/bin/bun build/server/bundle.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Process supervision is systemd's `Restart=always` — a crash restarts in
5 seconds. `GET /healthz` answers `{"status":"ok"}` and is the
load-balancer / smoke-test probe.

## 5. Deploy and rollback

Deploy (from the droplet). Steps 1–3 run **as the `turnip-farm` service
user** (e.g. `sudo -u turnip-farm -s` from the deploy user): §1 step 4
chowns `/opt/turnip-farm` to `turnip-farm:turnip-farm`, so running them
as the deploy user fails with EACCES. Step 4 needs root/sudo (systemd).

1. `git pull` the release ref.
2. `bun install --frozen-lockfile && bun run build`.
3. `bun run db:migrate` (with `DATABASE_URL` set).
4. `systemctl restart turnip-farm`, then `curl localhost:3000/healthz`.

Rollback: keep the previous `build/` as `build.prev` before step 2
(`cp -r build build.prev`). To roll back, restore it and restart; run
`bun run db:rollback` only if the deploy migrated — migrations are
written additive, so most rollbacks don't touch the database.

## 6. Caddy

Reverse-proxy to the Bun service with automatic TLS:

```
farm.example.com {
    reverse_proxy localhost:3000
    log {
        output file /var/log/caddy/farm-access.log
    }
}
```

Access logs fall under the same 30-day cap as everything else (§8):
rotate with `logrotate`, keeping 30 days at most. Request logs never
record a user ID or session ID next to a source or clip ID (§8) — if a
log line ever does, that's a code bug, not a log-config problem.

## 7. R2

- One bucket (`R2_BUCKET`) holds pose blobs (`poses/<video_id>.tkp1.gz`)
  and model artifacts. Keys contain only the opaque source ID; nothing
  in a key identifies a person or a device (§8).
- Presigned URLs are per-request, single-blob, short-lived. The design
  doc assumes 15-minute TTLs (`BACKEND_DESIGN.md` §9 Q4); the TTL is
  fixed in code at `PRESIGN_TTL_SEC = 15 * 60` (`src/r2/presign.ts`) —
  changing it is a code change, not an operator knob.
- The client uploads staged blobs (`staging/<video_id>.tkp1.gz`) with a
  presigned PUT; the ingest worker canonicalizes them (see §8 below).

## 8. Ingest trigger: poller vs. R2 event notifications

Today ingest is an **in-process poller**: `startIngestPoller` sweeps the
`staging/` prefix every `INGEST_POLL_INTERVAL_MS` (default 30 s),
canonicalizes each staged blob to `poses/<video_id>.tkp1.gz`, and deletes
the staged object. Re-ingest is byte-identical, hence idempotent, and a
failed ingest leaves `sources.sha256` NULL with no partial blob at the
canonical key.

R2 event notifications are the alternative: lower ingest latency, but a
new webhook surface to authenticate and operate. The code already
anticipates the switch — setting `INGEST_POLL_INTERVAL_MS=0` disables the
poller. Recommendation: ship the poller; revisit notifications only if
ingest latency ever matters to users (it doesn't today — the client
polls `blob_present` and `POST /api/clips` answers `422 BLOB_MISSING`
until ingest completes).

## 9. Ops decisions (from `BACKEND_DESIGN.md` §9)

Each is the maintainer's call; the recommendation is the runbook's
starting position.

- **Q1 — pipeline key management.** Generate `TURNIP_PIPELINE_KEY` with
  `openssl rand -base64 32`, store it in `/etc/turnip-farm/env` like the
  other secrets. Rotation: deploy the new value, then update the
  pipeline consumer (turnip-ml's training job) in the same window —
  there is exactly one consumer, so a flag day is acceptable.
- **Q4 — R2 topology.** Single bucket, 15-minute presigned-URL TTLs
  (see §7).
- **Q6 — Apple keys.** `APPLE_PRIVATE_KEY` comes from the Apple
  Developer account (Services ID key). `APPLE_REFRESH_TOKEN_KEY` is
  generated locally as above. Note: rotating the refresh-token key
  needs a key ID on the stored ciphertext, which §3 does not have yet —
  that's a schema task before the first rotation, not during it.
- **Q7 — server-to-server notifications.** Register the notification
  endpoint URL for the App ID in the Apple Developer account. Apple
  does not document redelivery: a missed `account-deleted` leaves that
  user's data until an operator removes it manually — document the
  manual deletion query next to this runbook when the endpoint goes
  live.

## 10. Retention — the 30-day rule

`BACKEND_DESIGN.md` §8 caps all three at 30 days; this runbook
implements it:

| Data | Implementation |
|---|---|
| Postgres backups | Nightly `pg_dump`; prune `> 30` days (§3) |
| Farm logs | systemd journal with `MaxRetentionSec=30day`, or file + `logrotate` keeping 30 days |
| Caddy access logs | `logrotate`, 30 days max (§6) |

Plus the in-app jobs that need no ops work (hourly, in process):
reports are deleted 30 days after filing, and accounts idle for 24
months are deleted with their attributed contributions
(`BACKEND_DESIGN.md` §1.2.17). `source_attribution` itself is kept
until its account is deleted.

## 11. Cutover to managed Postgres

When the time comes: provision the managed instance, `pg_dump` /
`pg_restore` the data, point `DATABASE_URL` at it, run
`bun run db:migrate` to confirm the schema state, restart the service,
and verify `/healthz`. Keep the 30-day backup cap on the managed side
(managed backup retention configured to 30 days, not the provider
default).

## 12. Verify the deploy

1. `curl https://farm.example.com/healthz` → `{"status":"ok"}`.
2. `bun run db:status` — all migrations applied.
3. Sign in with Apple in a dev build against the farm URL; confirm a
   staged upload ingests (`sources.sha256` set, staged object gone).
4. Confirm the 30-day prunes ran at least once (backup dir, log ages).
