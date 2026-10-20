# Turnip Farm — Deployment Runbook

*Draft · 2026-10-19 · Never executed. Nothing described here is
provisioned yet, and no environment holds data.*

**Scope.** How to stand up one production `turnip-farm`: a DigitalOcean
droplet running the Bun service, a self-hosted Postgres 16 and Caddy,
with Cloudflare for DNS and R2. It implements the design documents and
decides nothing they leave open. The ops questions in
`BACKEND_DESIGN.md` §9 are the maintainer's: §9 below lays each one out
with options and a recommendation, and names what this runbook assumes
until it is decided. Where the code falls short of a production
deployment, §3 says so instead of working around it.

Bare section numbers (§4.2) refer to this runbook; sections of the
design documents always carry the document's name.

Placeholders: `farm.example.com` is the farm's hostname,
`<account-id>` the Cloudflare account ID, `turnip-farm-prod` the data
bucket and `turnip-farm-backups` the backup bucket. Prices are
approximate, as of writing; check the providers' pricing pages.

## 1. Before first deployment

Two decisions have deadlines at or before the first deployment. Check
both before §4 step 1.

- [ ] **Unlinking contributions from accounts: final, or reversed
  first.** Contributions are linked to an account for 30 days at most
  (`BACKEND_DESIGN.md` §1.2.17). The master plan (§1, *Unlinking stays*)
  keeps that, with a reopen trigger: if counsel answers
  `BACKEND_DESIGN.md` §9 Q9 that unlinked pose sequences are personal
  data anyway, linking may be the better trade. **A reversal has to land
  before the first deployment**, while restoring `sources.user_id` is
  still a plain additive migration. Once real contributions exist under
  unlinking, they cannot be re-linked except through the opt-in
  "link my contributions" call, and only for the sources whose keys a
  device still holds. Before deploying: counsel has answered that Q9 and
  any reversal has merged, or the maintainer records the decision to
  deploy without the answer.
- [ ] **Multi-device `video_id` derivation settled.** Master plan §9 Q2:
  whether `video_id` should derive from an identifier that is the same
  on all of a user's devices (PhotoKit's cloud identifier, for iCloud
  Photos users) **has to be settled before the first contribution
  ships**. Changing the derivation afterwards orphans every contributed
  source. The deadline is the first contribution, not the deployment
  itself, but a deployed farm is what the first contribution goes to:
  no contributing build of `turnip-ios` may point at this farm until
  Q2 is settled.

## 2. Target

```mermaid
flowchart LR
    iOS["turnip-ios"] -->|"HTTPS"| Caddy
    ML["turnip-ml (nightly)"] -->|"HTTPS + pipeline key"| Caddy
    Apple["Apple server-to-server<br/>notifications"] -->|"HTTPS"| Caddy
    subgraph Droplet["DigitalOcean droplet · Ubuntu 24.04"]
        Caddy["Caddy<br/>TLS · access log"] -->|"127.0.0.1:3000"| Farm["turnip-farm<br/>Bun 1.3.14 · systemd"]
        Farm --> PG[("Postgres 16<br/>localhost")]
        Backup["nightly pg_dump + age"] --> PG
    end
    iOS -->|"presigned PUT / GET"| R2[("R2 turnip-farm-prod<br/>staging/ · poses/ · models/ · reports/")]
    Farm -->|"S3 API"| R2
    ML -->|"S3 API"| R2
    Backup -->|"encrypted dumps"| R2B[("R2 turnip-farm-backups<br/>29-day expiry")]
```

- **One droplet**, Basic Regular, Ubuntu 24.04 LTS, running the farm
  under systemd, Postgres 16 from Ubuntu's own archive, and Caddy as the
  TLS reverse proxy. The API keeps no state in process memory beyond
  rate-limit buckets and caches (`BACKEND_DESIGN.md` §1.2.14):
  everything durable is in Postgres or R2.
- **Cloudflare DNS**, records set to *DNS only*. Recommended over
  proxying (orange cloud) because TLS then ends at Caddy, so Apple
  identity tokens, session tokens and source keys are never decrypted
  by a third party, Caddy sees real client addresses, and Caddy's
  automatic certificates work with no extra setup. The cost is no
  Cloudflare DDoS shielding and a public origin address. Proxying can be
  turned on later (SSL mode *Full (strict)*, Caddy `trusted_proxies`
  set to Cloudflare's ranges).
- **Cloudflare R2** holds pose blobs and model artifacts, never video
  (master plan §1). A second, private bucket holds encrypted database
  backups (§7.3); the farm process never sees it.
- **Not on the droplet:** the `turnip-ml` training job. Where it runs is
  `turnip-ml`'s decision; it needs the pipeline key (§9 Q1) and an R2
  token (§9 Q4), and reaches the farm over HTTPS like any client.

### 2.1 Budget

| Item                                   | Monthly, approx.                 |
| -------------------------------------- | -------------------------------- |
| Droplet `s-1vcpu-2gb` (2 GB, 1 vCPU)   | ~$12 (`s-1vcpu-1gb`: ~$6)        |
| Postgres 16, Caddy, Let's Encrypt      | $0 (on the droplet)              |
| Cloudflare DNS                         | $0                               |
| R2, both buckets                       | ~$0 inside the free tier         |
| Domain                                 | ~$1 (yearly fee, amortized)      |
| **Total**                              | **~$7–13**                       |
| After cutover to managed Postgres (§8) | **+~$15**, so ~$22–28            |

R2's free tier (10 GB-month storage, 1M Class A and 10M Class B
operations a month, egress always free) covers v1. A canonical pose blob
is about 2 KB per second of footage (`POSE_FORMAT.md` §8), so 10 GB is
roughly 80,000 one-minute sources. The ingest poller's LIST calls are
Class A: at the default 30 s interval that is ~86,000 a month, under a
tenth of the free allowance. The 2 GB droplet leaves Postgres room and
stays inside the budget after the managed-Postgres cutover; the 1 GB
size works with swap (§4.2).

## 3. Code gaps this runbook depends on

Found while writing this runbook. None is fixed here; each needs its own
issue (and a design change first where it touches the schema or API).

1. **Per-IP rate limits become global behind Caddy.** `src/app.ts` keys
   the sign-in, notification and public-GET buckets
   (`BACKEND_DESIGN.md` §7.2) on `server.requestIP(req)`. Behind Caddy
   on loopback that is `127.0.0.1` for every request, so on day one the
   whole user base shares one bucket: 10 sign-ins a minute and 30
   vocabulary fetches a minute, total. Caddy's `reverse_proxy` already
   sets `X-Forwarded-For` to the real client address and discards
   client-supplied values unless `trusted_proxies` is configured, so the
   fix is small: when the peer is loopback, take the client address from
   `X-Forwarded-For`. **Recommended before first deployment.**
2. **The farm listens on every interface.** `Bun.serve` is started with
   a port and no hostname, so port 3000 is reachable from the internet
   unless a firewall stops it. §4.2 denies it in two places. An optional
   bind-address setting would make that defense in depth instead of the
   only defense.
3. **R2 settings that are code, not configuration.** The presigned-URL
   TTL is the constant `PRESIGN_TTL_SEC` (15 minutes) in
   `src/r2/presign.ts`, and the R2 endpoint is hard-coded as
   `<account-id>.r2.cloudflarestorage.com` in `src/r2/presign.ts` and
   `src/ingest/store.ts`, so a bucket under an R2 jurisdiction (EU,
   FedRAMP), whose endpoint differs, would not work. See §9 Q4.
4. **`APPLE_REFRESH_TOKEN_KEY` cannot be rotated.** Stored ciphertexts
   carry no key ID (§9 Q6).
5. **Failed Apple notifications leave no trace.** A transient failure
   answers `500` and records nothing, so a missed `account-deleted` is
   invisible to the operator (§9 Q7).
6. **`INGEST_POLL_INTERVAL_MS` is undocumented and lenient.**
   `src/index.ts` reads it straight from the environment; it is missing
   from the README's table and `.env.example`, and an invalid value
   silently falls back to 30000 instead of failing fast like every other
   variable.

## 4. Provisioning

### 4.1 Cloudflare

1. **Data bucket.** Create `turnip-farm-prod` (no dots in the name: the
   farm uses virtual-hosted-style URLs). Location hint and jurisdiction
   per §9 Q4. Leave public access off (no `r2.dev` URL, no custom
   domain). No CORS policy is needed: the app uploads with URLSession,
   not a browser.
2. **Staging lifecycle rule.** On `turnip-farm-prod`, add a rule for
   prefix `staging/` that deletes objects 1 day after upload. Ingest
   picks up a staged upload within one poll, so anything older failed
   or was abandoned; without the rule a permanently invalid upload is
   retried, and logged, on every poll forever. No rule on `poses/`,
   `models/` or `reports/`.
3. **Farm token.** R2 → Manage API tokens → create a token with
   *Object Read & Write*, scoped to `turnip-farm-prod` only. Its access
   key ID and secret become `R2_ACCESS_KEY_ID` and
   `R2_SECRET_ACCESS_KEY`. The pipeline gets its own token (§9 Q4).
4. **Backup bucket.** Create `turnip-farm-backups`, private, with a
   lifecycle rule deleting every object 29 days after upload (R2
   removes expired objects within about 24 hours, so nothing outlives
   30 days). Create a second *Object Read & Write* token scoped to this
   bucket only, for the backup job.
5. **DNS** (after §4.2 gives the droplet its address): an `A` record
   for `farm.example.com` to the droplet's IPv4 address, and `AAAA` if
   IPv6 is enabled, both *DNS only*.

### 4.2 Droplet and host

1. Create the droplet: Ubuntu 24.04 LTS x64, Basic Regular,
   `s-1vcpu-2gb`, in the region nearest the users and the R2 location
   hint. SSH key authentication only. Enable the free monitoring agent.
   **Leave DigitalOcean backups off** (§7.3).
2. Add a DigitalOcean Cloud Firewall: inbound TCP 22 (from the
   maintainer's addresses if practical), 80 and 443; deny the rest.
3. On the host, as root: create a sudo user with the same SSH key, then
   set `PermitRootLogin no` and `PasswordAuthentication no` in
   `/etc/ssh/sshd_config.d/` and restart `ssh`.
4. Host firewall, so port 3000 stays closed even if the cloud firewall
   is edited (§3 item 2):

   ```sh
   ufw allow OpenSSH
   ufw allow 80/tcp
   ufw allow 443/tcp
   ufw enable
   ```

5. Check that `unattended-upgrades` is enabled (Ubuntu's default) and
   that the clock is synchronized (`timedatectl` shows
   `System clock synchronized: yes`): Apple JWTs are checked with a
   60-second leeway (`BACKEND_DESIGN.md` §7.1).
6. One log store: configure journald and remove rsyslog (§7.1).
7. On a 1 GB droplet only, add 1 GB of swap (`fallocate -l 1G
   /swapfile`, `chmod 600`, `mkswap`, `swapon`, and an `/etc/fstab`
   entry).

### 4.3 Postgres 16

Ubuntu 24.04's archive ships PostgreSQL 16; no extra repository is
needed. It listens on localhost only by default; keep it that way.

```sh
apt install -y postgresql
openssl rand -hex 24                       # the turnip role's password
sudo -u postgres createuser --pwprompt turnip   # paste it at the prompt
sudo -u postgres createdb --owner turnip turnip
```

The `turnip` role owns its database and is not a superuser. That is
enough for the first migration's `CREATE EXTENSION IF NOT EXISTS
pgcrypto`: `pgcrypto` is a trusted extension, which a database owner may
create.

`DATABASE_URL` is then
`postgres://turnip:<password>@localhost:5432/turnip?sslmode=disable`.
Loopback traffic never leaves the host, and dbmate refuses a server
without TLS unless the URL says `sslmode=disable` (README, *Database*).
Ubuntu's package also enables TLS with a self-signed certificate, so
`sslmode=require` works too.

Ubuntu rotates the server log (`/var/log/postgresql/`) with its own
logrotate rule, which keeps weeks of history: cap it per §7.1.

### 4.4 Bun

Install the version CI uses, 1.3.14 (`packageManager` in
`package.json`), system-wide from the GitHub release, checking it
against the release's `SHASUMS256.txt`. If `grep -c avx2 /proc/cpuinfo`
prints `0`, use the `bun-linux-x64-baseline` build instead.

```sh
cd "$(mktemp -d)"
v=bun-v1.3.14; f=bun-linux-x64.zip
curl -fsSLO "https://github.com/oven-sh/bun/releases/download/$v/$f"
curl -fsSLO "https://github.com/oven-sh/bun/releases/download/$v/SHASUMS256.txt"
grep " $f\$" SHASUMS256.txt | sha256sum -c -
apt install -y unzip && unzip "$f"
install -m 0755 bun-linux-x64/bun /usr/local/bin/bun
bun --version                              # 1.3.14
```

### 4.5 Service user and layout

```sh
useradd --system --home-dir /var/lib/turnip-farm --create-home \
  --shell /usr/sbin/nologin turnip
install -d -o turnip -g turnip /opt/turnip-farm /opt/turnip-farm/releases
install -d -m 0750 -o root -g root /etc/turnip-farm
```

- `/opt/turnip-farm/releases/<commit>/`: one checkout per deployed
  commit, built in place (§5).
- `/opt/turnip-farm/current`: symlink to the release that runs.
- `/etc/turnip-farm/env`: the farm's configuration, `root:root`, mode
  `0600`. systemd reads it as root before dropping to `turnip`, so the
  service user cannot read it from disk.
- `/etc/turnip-farm/backup.env`: the backup job's configuration (§7.3),
  same ownership and mode.

Never put a `.env` file in a release directory: Bun and dbmate both load
`.env` from the working directory automatically.

### 4.6 Configuration

Every variable the farm reads, plus one it must never see. `PORT` and
`INGEST_POLL_INTERVAL_MS` are optional; with any other missing or
invalid, the farm exits with status 1 and lists every problem at once
(`src/config.ts`).

| Variable                  | Value in production                                                   |
| ------------------------- | --------------------------------------------------------------------- |
| `PORT`                    | Leave unset (3000). If changed, change Caddy's upstream to match.     |
| `DATABASE_URL`            | §4.3 (self-hosted) or §8 (managed)                                    |
| `R2_ACCOUNT_ID`           | `<account-id>`                                                        |
| `R2_ACCESS_KEY_ID`        | Farm token (§4.1 step 3)                                              |
| `R2_SECRET_ACCESS_KEY`    | Farm token (§4.1 step 3)                                              |
| `R2_BUCKET`               | `turnip-farm-prod`                                                    |
| `APP_BUNDLE_ID`           | The iOS app's bundle ID                                               |
| `APPLE_TEAM_ID`           | Apple Developer team ID                                               |
| `APPLE_KEY_ID`            | ID of the Sign in with Apple key                                      |
| `APPLE_PRIVATE_KEY`       | That key's `.p8` PEM on one line, newlines written as `\n` (§9 Q6)    |
| `APPLE_REFRESH_TOKEN_KEY` | `openssl rand -base64 32`, generated once (§9 Q6)                     |
| `TURNIP_PIPELINE_KEY`     | `openssl rand -hex 32` (§9 Q1)                                        |
| `INGEST_POLL_INTERVAL_MS` | Optional. Default 30000; `0` disables the poller (§6)                 |
| `TEST_DATABASE_URL`       | **Never set in production.** Test-only; the farm does not read it.   |

Write each value in single quotes:

```sh
# /etc/turnip-farm/env (root:root 0600)
DATABASE_URL='postgres://turnip:...@localhost:5432/turnip?sslmode=disable'
APPLE_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\nMIGT...\n-----END PRIVATE KEY-----'
# ...one line per variable in the table above
```

Single quotes keep the PEM's `\n` escapes literal, and `src/config.ts`
turns them into newlines. If quoting ever turns them into real newlines
first, the check still passes; it only requires the value to start with
`-----BEGIN PRIVATE KEY-----`, and the key import at startup
(`src/index.ts`) rejects a malformed key with the same error format.

The canonical copy of every secret lives in the maintainer's password
manager, not on the droplet alone (§9 Q6).

### 4.7 Migrations

Migrations run with dbmate (README, *Database*), a pinned
`devDependency`, so every release is installed with a full
`bun install --frozen-lockfile`, never `--production`. A oneshot unit
runs them with the farm's environment, so the secrets never pass through
a shell:

```ini
# /etc/systemd/system/turnip-farm-migrate.service
[Unit]
Description=turnip-farm database migrations (dbmate)
After=postgresql.service

[Service]
Type=oneshot
User=turnip
Group=turnip
WorkingDirectory=/opt/turnip-farm/current
EnvironmentFile=/etc/turnip-farm/env
ExecStart=/usr/local/bin/bun run db:migrate
```

`systemctl start turnip-farm-migrate` applies whatever is pending and
returns when done; `journalctl -u turnip-farm-migrate -n 20` shows what
it applied. Migrations are additive and re-runnable
(`BACKEND_DESIGN.md` §2), so running it again is harmless, and a
rollback (§5) never needs a down migration.

### 4.8 Process supervision

```ini
# /etc/systemd/system/turnip-farm.service
[Unit]
Description=turnip-farm API
After=network-online.target postgresql.service
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=turnip
Group=turnip
WorkingDirectory=/opt/turnip-farm/current
EnvironmentFile=/etc/turnip-farm/env
# Bun's transpiler cache would write under the service user's home,
# which ProtectSystem=strict makes read-only; the bundle doesn't need it.
Environment=BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ExecStart=/usr/local/bin/bun dist/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
```

The farm logs to stdout and stderr only, so journald holds its logs
(§7.1). A configuration error exits with status 1, and systemd gives up
after five attempts in a minute: `systemctl status turnip-farm` and
`journalctl -u turnip-farm -n 50` show the list of problems. The
30-day attribution purge runs inside this process, at startup and
hourly (`src/index.ts`), so no cron job is needed for it.

### 4.9 Caddy

Install Caddy from its official apt repository (see Caddy's install
documentation; Ubuntu's own package lags). Then:

```caddyfile
# /etc/caddy/Caddyfile
{
	email ops@example.com
}

farm.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000

	# Access log to stderr, so journald holds it (§7.1). Caddy redacts
	# Authorization by default; the Source-Key header it would log in
	# plain text (BACKEND_DESIGN.md §8), so it is deleted here, and
	# client addresses are truncated.
	log {
		format filter {
			wrap json
			fields {
				request>headers>Authorization delete
				request>headers>Source-Key delete
				request>remote_ip ip_mask 24 48
				request>client_ip ip_mask 24 48
			}
		}
	}
}
```

`systemctl reload caddy`. Caddy obtains and renews the certificate
itself once DNS points at the droplet and ports 80 and 443 are open,
and redirects HTTP to HTTPS.

The access log records method, path, status and timing: source IDs
appear in paths, but no account does, because the farm's bearer tokens
are redacted and the farm itself never logs requests (`src/app.ts`). The
IP truncation (`/24`, `/48`) is a recommendation, not a
`BACKEND_DESIGN.md` §8 requirement; drop it if abuse investigation needs
full addresses.

### 4.10 First start and smoke test

1. Build and link the first release (§5 steps 1–4), then
   `systemctl daemon-reload`, `systemctl start turnip-farm-migrate`,
   and `systemctl enable --now turnip-farm`.
2. `journalctl -u turnip-farm -n 20` shows `turnip-farm listening on
   http://...:3000/` and `ingest poller running every 30000ms`, and no
   `ingest poll failed` (which would mean the R2 token or bucket is
   wrong) or `attribution purge failed`.
3. From outside the droplet:
   - `curl -fsS https://farm.example.com/healthz` → `{"status":"ok"}`.
     This proves the process is up, not that it reaches Postgres.
   - `curl -fsS https://farm.example.com/api/taxonomy/current` →
     `taxonomy_version` 1: Postgres is reachable and migrated.
   - `curl -m 5 http://<droplet-ip>:3000/healthz` must time out.
   - `GET /api/labels/export` with the pipeline key → `200` with no
     rows. Keep the key out of shell history: `curl -H @file`, where
     `file` holds the `Authorization: Bearer ...` line.
4. Check that the access log drops the `Source-Key` header. The second
   command must print `0`:

   ```sh
   curl -s -H 'Source-Key: smoke-test' \
     "https://farm.example.com/api/sources/$(printf '0%.0s' {1..64})"
   journalctl -u caddy --since -5min | grep -c smoke-test
   ```

5. Sign in with Apple, contribution and account deletion end to end
   need a `turnip-ios` build pointed at the farm; run them with the
   maintainer's own account, and see §1 before any contributing build.
6. Register the Apple notification URL (§9 Q7).

## 5. Deploying a new version

Deploy only commits on `main` whose CI run is green.

```sh
sha=<full commit hash>
rel=/opt/turnip-farm/releases/$sha
sudo -u turnip git clone --quiet https://github.com/hoiekim/turnip-farm.git "$rel"   # 1
sudo -u turnip git -C "$rel" checkout --quiet --detach "$sha"
cd "$rel" && sudo -u turnip bun install --frozen-lockfile                           # 2
sudo -u turnip bun run build                                                        # 3
sudo -u turnip ln -sfn "$rel" /opt/turnip-farm/current                              # 4
sudo systemctl start turnip-farm-migrate                                            # 5
sudo systemctl restart turnip-farm                                                  # 6
```

Then repeat §4.10 steps 2–3. Keep the last three releases and delete
older ones.

**Rollback:** point `current` at the previous release and restart the
farm. Do not roll the schema back: migrations are additive, so the
previous release runs against the newer schema.

A restart drops in-flight requests (the farm has no graceful-shutdown
handler). Every client write is idempotent (`BACKEND_DESIGN.md` §4) and
the app retries, uploads keep landing in R2 while the farm is down, and
ingest catches up on the first poll after the restart.

## 6. Ingest trigger: poller or R2 event notifications

The ingest worker turns a staged upload into the canonical blob
(`BACKEND_DESIGN.md` §1.2.10). The design allows two triggers.

**Poller (what the code implements).** Every `INGEST_POLL_INTERVAL_MS`
(default 30000) the farm lists `staging/` and ingests what it finds
(`src/index.ts`, `src/ingest/worker.ts`). Cost: one LIST per tick (§2.1)
plus a GET, PUT and DELETE per upload. Latency: up to one interval plus
processing, which the client absorbs by polling `blob_present`. Ingest
is idempotent (re-ingest is byte-identical), but the runbook assumes a
single farm process: two would duplicate the work.

**R2 event notifications.** R2 delivers object events only to a
Cloudflare Queue, filtered by prefix and suffix (`staging/`,
`.tkp1.gz`). A queue is consumed by a Worker or by HTTP pull. Queues are
on the Workers free plan since February 2026, with 10,000 operations a
day and 24-hour message retention (at the time of writing). The farm has
no consumer: this path needs either a pull loop in the farm (a
Cloudflare API token with Queues access, calling `ingestStagedSource`
per message and acknowledging it) or a Worker calling a farm endpoint
that does not exist yet. A slower poll would still be needed as a sweep
for messages that expire unread.

**Recommendation: the poller for v1.** It is implemented, tested, costs
nothing at this scale, and needs no second Cloudflare product.
Revisit if ingest latency starts to matter to the app. To switch, set
`INGEST_POLL_INTERVAL_MS` to a long sweep interval rather than `0`.

## 7. Retention: the 30-day cap

Contributions are linked to an account for 30 days after a source's
last write, and nothing may outlive that link (`BACKEND_DESIGN.md` §8).
That section caps the farm's logs, the reverse proxy's access logs and
database backups at 30 days, and its §9 Q10 leaves the implementation
to this runbook.

| Store                    | Where                                     | Cap                                    |
| ------------------------ | ----------------------------------------- | -------------------------------------- |
| Farm logs                | journald (`turnip-farm.service`)          | 28-day retention, daily files (§7.1)   |
| Caddy access logs        | journald (`caddy.service`)                | same                                   |
| Postgres server log      | `/var/log/postgresql/`                    | daily rotation, 28 kept (§7.1)         |
| Local database dumps     | `/var/backups/turnip-farm/`               | 7 days (§7.3)                          |
| Off-site database dumps  | R2 `turnip-farm-backups`                  | 29-day lifecycle rule (§4.1 step 4)    |

### 7.1 Logs

journald is the single store for the farm's and Caddy's logs:

```ini
# /etc/systemd/journald.conf.d/30-day-cap.conf
[Journal]
Storage=persistent
MaxFileSec=1day
MaxRetentionSec=28day
```

`systemctl restart systemd-journald`. journald deletes whole archived
files, so rotating daily and keeping 28 days leaves a margin under 30
for a file that is up to a day old and a deletion that runs late.

Ubuntu also runs rsyslog, which copies the journal into
`/var/log/syslog` under logrotate's own schedule: a second store the
cap would miss. Remove it (`apt purge rsyslog`) and delete what it left
(`/var/log/syslog*`, `auth.log*`, `kern.log*`).

Postgres writes its own log file, rotated by
`/etc/logrotate.d/postgresql-common`. Change that rule to `daily`,
`rotate 28` and `maxage 28`. The server log can carry statement errors
whose detail names a key value, so it falls under the cap too.

Monthly check: `journalctl -o short-iso | head -1` and
`ls -l --time-style=long-iso /var/log/postgresql/` show nothing older
than 30 days.

### 7.2 What the logs hold

The farm never logs requests or credentials (`src/app.ts`): it logs
startup, failed purges, ingest summaries and failures by source ID, and
unhandled errors. Caddy logs requests through the filter in §4.9. Neither
records an account next to a source or clip ID, which
`BACKEND_DESIGN.md` §8 forbids.

### 7.3 Database backups

A nightly `pg_dump`, encrypted on the droplet with
[age](https://age-encryption.org) to a key the droplet does not hold,
copied off-site to `turnip-farm-backups`.

- **Keys.** On the maintainer's own machine, `age-keygen -o
  turnip-backup.key`. The private key stays there and in the password
  manager; only its public `age1...` recipient goes to the droplet. A
  compromised droplet or a leaked backup token then exposes ciphertext
  only.
- **Tools.** `apt install -y age rclone`.
- **Configuration**, `/etc/turnip-farm/backup.env` (root, `0600`):

  ```sh
  AGE_RECIPIENT='age1...'
  BACKUP_BUCKET='turnip-farm-backups'
  RCLONE_CONFIG_R2_TYPE='s3'
  RCLONE_CONFIG_R2_PROVIDER='Cloudflare'
  RCLONE_CONFIG_R2_ENDPOINT='https://<account-id>.r2.cloudflarestorage.com'
  RCLONE_CONFIG_R2_ACCESS_KEY_ID='<backup token>'
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY='<backup token>'
  ```

- **Script**, `/usr/local/sbin/turnip-farm-backup` (root, `0700`):

  ```sh
  #!/usr/bin/env bash
  # Nightly encrypted Postgres dump, kept 30 days at most
  # (BACKEND_DESIGN.md §8). Run by turnip-farm-backup.service.
  set -euo pipefail
  umask 077
  dir=/var/backups/turnip-farm
  mkdir -p "$dir"
  file="$dir/turnip-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
  trap 'rm -f "$file.part"' EXIT
  runuser -u postgres -- pg_dump --format=custom \
    --exclude-table-data=source_attribution \
    --exclude-table-data=reports \
    turnip | age --recipient "$AGE_RECIPIENT" > "$file.part"
  mv "$file.part" "$file"
  rclone copyto --s3-no-check-bucket "$file" "r2:$BACKUP_BUCKET/${file##*/}"
  find "$dir" -name 'turnip-*.dump.age' -mtime +6 -delete
  ```

- **Units:**

  ```ini
  # /etc/systemd/system/turnip-farm-backup.service
  [Unit]
  Description=turnip-farm encrypted Postgres backup
  After=postgresql.service

  [Service]
  Type=oneshot
  EnvironmentFile=/etc/turnip-farm/backup.env
  ExecStart=/usr/local/sbin/turnip-farm-backup

  # /etc/systemd/system/turnip-farm-backup.timer
  [Unit]
  Description=Nightly turnip-farm backup

  [Timer]
  OnCalendar=*-*-* 03:30:00 UTC
  RandomizedDelaySec=15m
  Persistent=true

  [Install]
  WantedBy=timers.target
  ```

  `systemctl enable --now turnip-farm-backup.timer`; a failed run shows
  in `systemctl --failed`.

**Why the dump leaves out attribution and reports (recommended; the
maintainer should confirm).** A dump taken today holds attribution rows
up to 30 days old. Kept 30 days, the link would survive in the backup
until up to about 60 days after a source's last write, which
`BACKEND_DESIGN.md` §8 rules out ("nothing may outlive it"). Shorter
retention narrows that but never closes it. Dumping the schema of
`source_attribution` and `reports` without their rows keeps that section
literally true. The cost: after a restore, recent sources cannot be
traced for anti-poisoning and open reports are gone. If the maintainer
prefers full dumps, a restore that brings back expired attribution rows
is harmless to the API (every read filters the 30-day window and the
hourly purge deletes them), but the backups themselves then hold the
link past the window.

**Why not DigitalOcean backups.** Droplet backups and snapshots image
the whole disk, including `/etc/turnip-farm/env` with every secret.
Their retention is DigitalOcean's policy (weekly backups keep the last
four, at the time of writing), not something this runbook controls, and
manual snapshots never expire. Don't enable backups, and delete any
snapshot taken for maintenance within 30 days.

**Restore drill, monthly.** On the maintainer's machine, never against
production: fetch the newest dump, then
`age --decrypt -i turnip-backup.key <file> | pg_restore --no-owner
--dbname=<scratch database>`, and check that `bun run db:status`
against it lists no pending migrations.

**Restore for real.** Stop the farm, recreate the database (§4.3),
restore with `pg_restore --no-owner --no-acl --dbname="$DATABASE_URL"`,
start `turnip-farm-migrate` (it applies anything newer than the dump),
then start the farm.

## 8. Cutting over to managed Postgres

The farm keeps no database state outside `DATABASE_URL`, so the cutover
is a dump, a restore and a connection-string swap.

1. **Create** a DigitalOcean Managed PostgreSQL 16 cluster (smallest
   size, ~$15/month) in the droplet's region and VPC. Restrict trusted
   sources to the droplet. Create a database `turnip` and a user
   `turnip`, then, as `doadmin`, `ALTER DATABASE turnip OWNER TO
   turnip;` so the user can create the schema and the `pgcrypto`
   extension.
2. **Connection string**: the one the control panel shows for that user
   and database, e.g.
   `postgresql://turnip:<password>@<host>:25060/turnip?sslmode=require`.
   Managed Postgres requires TLS; the README's `sslmode=disable` note is
   for a local server only.
3. **Stop** the farm and the backup timer: `systemctl stop
   turnip-farm turnip-farm-backup.timer`. Uploads keep landing in R2
   and are ingested after the restart.
4. **Dump** the live database in full (attribution included; this is a
   move, not a backup):
   `runuser -u postgres -- pg_dump --format=custom --no-owner --no-acl
   turnip > /root/cutover.dump`.
5. **Restore** into the managed database:
   `pg_restore --no-owner --no-acl --dbname='<managed URL>'
   /root/cutover.dump`. The dump carries dbmate's `schema_migrations`
   table, so dbmate sees the same history.
6. **Swap** `DATABASE_URL` in `/etc/turnip-farm/env`, run
   `systemctl start turnip-farm-migrate` (it should apply nothing),
   then `systemctl start turnip-farm` and the smoke test (§4.10).
   Compare `count(*)` of `sources`, `clips`, `labels` and `users` on
   both databases.
7. **Retire** the self-hosted copy once satisfied, within days: delete
   `/root/cutover.dump`, `pg_dropcluster --stop 16 main`, remove the
   backup timer and script, and let the off-site dumps expire under
   their lifecycle rule (or delete them).
8. **Retention.** The managed cluster backs itself up daily and keeps
   about a week, inside the 30-day cap, but it backs up every table:
   attribution can no longer be left out of backups (§7.3), so the
   link survives in backups up to about 37 days after a source's last
   write. Check DigitalOcean's current backup retention, and record
   whether that is acceptable, before cutting over.
9. **Budget.** Droplet plus managed Postgres is ~$22–28 a month on the
   2 GB droplet; with Postgres gone, the 1 GB droplet (~$6) may be
   enough for the farm and Caddy.

Rolling back before step 7 is the same swap in reverse.

## 9. Ops decisions (`BACKEND_DESIGN.md` §9)

Each is open. The recommendations are this runbook's, for the
maintainer to accept or replace.

### Q1. Pipeline key issuance and rotation

*Question.* Who issues and rotates `TURNIP_PIPELINE_KEY`, and where is
it stored?

*Facts.* One key authenticates `POST /api/models`,
`GET /api/labels/export`, `POST /api/quarantine` and the quarantine
release and purge endpoints (`BACKEND_DESIGN.md` §1.2.22). Purge
hard-deletes a source, so the key is a destructive credential, and the
maintainer also uses it by hand for the review queue. The farm accepts
exactly one value, so a rotation has no overlap window.

*Options.*
- **(a)** The maintainer generates it (`openssl rand -hex 32`), keeps
  the canonical copy in a password manager, and installs it in the
  farm's env file and in the secret store of wherever `turnip-ml` runs.
  Rotation replaces both between two nightly runs.
- **(b)** As (a), plus a second accepted key so rotation needs no
  coordinated cut. A small code change.
- **(c)** Separate keys for the pipeline and the maintainer's review
  calls. A design change: `BACKEND_DESIGN.md` §1.2.22 deliberately has
  no admin credential yet.

*Recommendation.* (a). Rotate on any suspected leak, when anyone with
access stops needing it, and yearly. A missed nightly run is the only
cost of a clumsy rotation. Revisit (c) if anyone besides the maintainer
operates the pipeline.

*Assumed until decided.* (a); the key in §4.6 is generated by the
maintainer.

### Q4. R2 bucket, region and presigned-URL TTL

*Question.* Bucket, region and presigned-URL TTL policy (15 minutes
assumed in `BACKEND_DESIGN.md` §7.3).

*Facts.*
- The code takes one bucket (`R2_BUCKET`) and lays it out by prefix:
  `staging/` and `poses/` (farm), `models/` and `reports/` (pipeline,
  served by the farm through presigned GETs).
- R2 API tokens are scoped per bucket, not per prefix. The pipeline
  reads `poses/` (it resolves export rows' `r2_key` itself,
  `BACKEND_DESIGN.md` §7.3) and writes `models/` and `reports/`, so in
  one bucket its token can also overwrite or delete pose blobs.
- A location hint (e.g. `wnam`, `weur`) only places the bucket and
  changes nothing in the code. A jurisdiction (EU, FedRAMP) guarantees
  residency but changes the endpoint, which the farm hard-codes (§3
  item 3). Neither can change after creation without copying every
  object to a new bucket.
- The TTL is the code constant `PRESIGN_TTL_SEC`, 15 minutes for PUT
  and GET alike. The manifest is cached for 300 s with a presigned URL
  inside it (`BACKEND_DESIGN.md` §7.3), so the TTL must stay above
  that.

*Options.*
- Bucket: **(a)** one bucket, a farm token and a pipeline token, both
  read-write; **(b)** split poses and models into two buckets so the
  pipeline's pose access is read-only. (b) needs a second bucket
  setting in the farm.
- Region: **(a)** a location hint near the droplet and the users, no
  jurisdiction; **(b)** the EU jurisdiction, after making the endpoint
  configurable.
- TTL: **(a)** keep 15 minutes; **(b)** change it, a code change.

*Recommendation.* One bucket, a location hint matching the droplet's
region, no jurisdiction, 15 minutes. Choose (b) for the region if
counsel's answer to `BACKEND_DESIGN.md` §9 Q9, or where the users are,
calls for EU residency, and decide that before the first contribution,
since the bucket cannot move afterwards.

*Assumed until decided.* One bucket, `turnip-farm-prod`, as in §4.1.

### Q6. Where the Apple keys live, and rotating `APPLE_REFRESH_TOKEN_KEY`

*Question.* Where `APPLE_PRIVATE_KEY` and `APPLE_REFRESH_TOKEN_KEY`
live, and how the latter rotates.

*Facts.* `APPLE_PRIVATE_KEY` (with `APPLE_KEY_ID` and `APPLE_TEAM_ID`)
signs the client secret for the code exchange and token revocation; no
stored data depends on it. `APPLE_REFRESH_TOKEN_KEY` encrypts
`users.apple_refresh_token`, stored as nonce ‖ ciphertext ‖ tag with
`users.id` as associated data (`BACKEND_DESIGN.md` §3) and **no key
ID**, so the farm can hold only one key. Swapping it makes every stored
token undecryptable.
`DELETE /api/account` then logs the decryption failure and deletes the
account without revoking the user's Sign in with Apple authorization
(`src/auth/account.ts`). Each sign-in re-encrypts under the current key,
so the gap closes for a user only when they sign in again.

*Options, storage.*
- **(a)** The root-only env file on the droplet (§4.5), canonical copies
  in the maintainer's password manager. Never in git, the backup bucket,
  or a droplet snapshot.
- **(b)** A hosted secret manager injecting the values at start: one
  more account and dependency.
- **(c)** systemd encrypted credentials: the farm reads environment
  variables, so it needs a wrapper, and with no TPM on a droplet the
  encryption key sits on the same disk.

*Options, rotating `APPLE_REFRESH_TOKEN_KEY`.*
- **(a)** Add a key ID: an additive column recording which key
  encrypted each token, and a setting for retired keys that still
  decrypt. A schema change, so `BACKEND_DESIGN.md` §3 and §7.1 first.
  Being additive, it can land after the first deployment.
- **(b)** Offline re-encryption in a maintenance window: stop the farm,
  decrypt every token with the old key and encrypt it with the new one,
  swap the setting. The script does not exist.
- **(c)** Rotate only on compromise, and accept that revocation is lost
  for users who never sign in again.

*Recommendation.* Storage (a). Rotation (a), landed before the first
planned rotation. Rotating `APPLE_PRIVATE_KEY` needs nothing new:
create a key in the Apple Developer account, update `APPLE_KEY_ID` and
`APPLE_PRIVATE_KEY`, restart, confirm a sign-in, then revoke the old key.

*Assumed until decided.* Storage (a). `APPLE_REFRESH_TOKEN_KEY` is
generated once and not rotated; on a suspected compromise, (b) or (c).

### Q7. Registering the Apple server-to-server notification URL

*Question.* The endpoint has to be registered for the App ID, and Apple
does not document redelivery. A missed `account-deleted` leaves that
user's data until an operator removes it.

*Facts.* The URL is
`https://farm.example.com/api/auth/apple/notifications`, entered in the
Apple Developer account in the App ID's Sign in with Apple
configuration, in its server-to-server notification endpoint field. It
must be HTTPS, which Caddy provides. On a transient failure (Postgres or
R2 unreachable) the farm answers `500`, but records nothing about the
event: by design it logs no `sub` (`BACKEND_DESIGN.md` §8), and Caddy's
access log shows only the path and the status. So today an operator has
nothing to act on. A missed `account-deleted` leaves the `users` row,
its sessions until they expire after 90 days idle, and its attributed
sources until the 30-day window unlinks them, after which they stay as
unlinked training data.

*Options.*
- **(a)** Accept the gap; watch for `5xx` on the path
  (`journalctl -u caddy | grep notifications`). The damage is bounded by
  session expiry and the attribution window.
- **(b)** Log `events.sub` and `events.type` when an `account-deleted`
  fails: an account identifier with no source ID next to it, which
  `BACKEND_DESIGN.md` §8 allows, kept 30 days. The operator then
  finishes the deletion by hand, for which no procedure or admin
  endpoint exists yet.
- **(c)** A durable retry: an additive table of failed events, retried
  by the farm's hourly job. A schema change, so the design first.

*Recommendation.* Register the URL at the first deployment, once the
hostname is final (changing it later means registering again), and
before any build that signs users in against this farm ships. Run (a)
from then on, and land (c) as a follow-up; it is additive and does not
block the deployment.

*Assumed until decided.* Registered at first deployment (§4.10 step 6),
with (a).

## 10. Out of scope

- Where `turnip-ml` runs, and its Discord alert hook (master plan §6).
- The iOS app's farm base URL and its release process.
- A staging environment. If one is added, it follows this runbook with
  its own buckets, tokens and keys, and real users' data never goes
  there.
