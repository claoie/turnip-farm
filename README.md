# turnip-farm

Backend and training dataset for [Turnip](https://github.com/hoiekim/turnip-ios).
The farm collects confirmed trick clips and free-text trick names from the
iOS app, stores them against on-device pose keypoint sequences, and serves
that dataset to the training pipeline. It never receives video: what leaves
the device is an opaque video ID, the pose keypoints, and the user's
confirmed labels.

How it fits with the other repos:

- [`turnip-ios`](https://github.com/hoiekim/turnip-ios) captures video, runs
  pose detection on-device, and lets the user confirm clips and trick names.
  On confirm it contributes keypoints and labels to the farm.
- **`turnip-farm`** (this repo) is a Bun + TypeScript API over Postgres
  (metadata and labels) and Cloudflare R2 (pose blobs and model artifacts).
- [`turnip-ml`](https://github.com/hoiekim/turnip-ml) pulls the labeled
  dataset from the farm each night, trains the trick-detection model, and
  publishes the champion back through the farm. The iOS app downloads it
  over the air.

The design documents are the contract. Read them before changing behavior:

- [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md): purpose, privacy boundary,
  and phased rollout across all three repos.
- [`docs/BACKEND_DESIGN.md`](docs/BACKEND_DESIGN.md): Postgres schema, upsert
  semantics, and the full REST API.
- [`docs/POSE_FORMAT.md`](docs/POSE_FORMAT.md): the `TKP1` pose wire and
  storage format.

Deploying is covered by [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), the
production runbook. It is a draft: nothing is deployed yet, and it lays
out the open ops decisions rather than settling them.

## Status

Every BACKEND_DESIGN.md §7.3 endpoint is in place. The service validates
its configuration and serves `GET /healthz`; the Postgres schema (§3) is
in place as dbmate migrations.

- **Accounts (§7.1):** Sign in with Apple and farm sessions
  (`POST /api/auth/apple`, `POST /api/auth/signout`), account deletion
  (`DELETE /api/account`), and Apple's server-to-server notifications
  (`POST /api/auth/apple/notifications`).
- **Contributions:** `POST /api/sources`, `GET /api/sources/:id`,
  `GET /api/sources/:id/pose`, `DELETE /api/sources/:id`,
  `POST /api/clips`, and `POST /api/clips/:id/labels`, with source-key
  ownership (§7.2). An ingest worker polls R2 and turns each staged
  upload into the canonical 10 Hz blob (§1.2.10).
- **Training:** the vocabulary (`GET /api/taxonomy/current`), the
  label export (`GET /api/labels/export`), the quarantine flow
  (`POST /api/quarantine` with its release and purge calls), and the
  model registry (`POST /api/models`, `GET /api/models/current`).
- **Moderation:** `POST /api/reports`, and maintainer scripts to resolve
  a source to its account within the attribution window and to block or
  unblock an account (see [Moderation](#moderation)). Blocked accounts
  get `403 ACCOUNT_BLOCKED` everywhere except sign-out and account
  deletion (§1.2.16).
- **Unlinking (§1.2.17):** a purge at startup and hourly deletes
  attribution 30 days after a source's last write and reports 30 days
  after they are filed.

## Layout

```
src/
  index.ts         entry point: loads config; starts the server, purge, and ingest poller
  app.ts           HTTP routing
  errors.ts        the API error shape (BACKEND_DESIGN.md §7.2)
  ratelimit.ts     per-user and per-IP token buckets, and the client address they key on (§7.2)
  db.ts            transaction helper
  config.ts        env-based configuration; fails fast on missing variables
  auth/
    apple.ts         Apple JWT verification, client secret, code exchange, revocation
    sessions.ts      sign-in, sign-out, and session authentication (§7.1)
    account.ts       DELETE /api/account
    notifications.ts Apple server-to-server notifications
    tokens.ts        session tokens and refresh-token encryption
    testing.ts       stand-in Apple endpoints for tests
  contrib/
    sources.ts     source registration, read, pose download, delete
    clips.ts       clip upserts and label-set replacement (§4, §5)
    validate.ts    request validation shared by the contribution endpoints
    purge.ts       the 30-day attribution and report purge (§1.2.17)
  ingest/          staged upload → canonical TKP1 blob (POSE_FORMAT.md)
  r2/              R2 client, presigned URLs, key conventions
  pipeline.ts      service-key auth for the pipeline endpoints (§7.1)
  export.ts        GET /api/labels/export (§6)
  quarantine.ts    the quarantine flow: report, release, purge
  taxonomy.ts      GET /api/taxonomy/current
  models.ts        the model registry: POST /api/models, GET /api/models/current
  reports.ts       POST /api/reports
  moderation.ts    attribution lookup and blocking, for the scripts below
  *.test.ts        tests (bun test), next to the code they cover
scripts/           maintainer scripts, run with bun run (see Moderation)
db/
  migrations/      dbmate migrations, additive only (BACKEND_DESIGN.md §2)
  schema.test.ts   checks a migrated database against BACKEND_DESIGN.md §3
  testing.ts       helpers for tests that need a database
docs/              design documents (see above)
.github/workflows/ CI: install, migrate, re-run newest migration, typecheck, test, build
```

## Development

Requires [Bun](https://bun.sh) 1.3.14, the version pinned by `packageManager`
in `package.json` and installed by CI.

```sh
bun install
cp .env.example .env   # then fill in the values
bun run dev            # watch mode on http://localhost:3000
curl -i localhost:3000/healthz
```

| Command               | What it does                                  |
| --------------------- | --------------------------------------------- |
| `bun test`            | Run the test suite                            |
| `bun run typecheck`   | Type-check with `tsc --noEmit`                |
| `bun run build`       | Bundle `src/index.ts` into `dist/`            |
| `bun run start`       | Run the bundle in `dist/` (build first)       |
| `bun run db:migrate`  | Apply pending migrations to `DATABASE_URL`    |
| `bun run db:rollback` | Unrecord the newest migration (down is empty) |
| `bun run db:status`   | List applied and pending migrations           |
| `bun run db:new`      | Create a migration: `bun run db:new <name>`   |

### Database

Migrations run with [dbmate](https://github.com/amacneil/dbmate), installed
as a pinned dev dependency, against `DATABASE_URL`. A throwaway local
Postgres 16:

```sh
docker run -d --name turnip-pg -p 5432:5432 \
  -e POSTGRES_USER=turnip -e POSTGRES_PASSWORD=turnip -e POSTGRES_DB=turnip \
  postgres:16-alpine
bun run db:migrate
```

dbmate refuses a server without TLS unless the URL ends in
`?sslmode=disable`, as the one in `.env.example` does.

Tests that need a database (`db/schema.test.ts` and most handler tests)
run only when `TEST_DATABASE_URL` names a migrated database. They never
read `DATABASE_URL`, and every test rolls its transaction back, so
pointing them at the local database above is safe. CI sets it, and the
tests fail rather than skip when it is missing there.

### Moderation

Two maintainer scripts work on the database at `DATABASE_URL`, for
quarantine review (BACKEND_DESIGN.md §1.2.16, §1.2.17, master plan §6):

```sh
bun run moderation:source-account <source_id>   # the account that last wrote it
bun run moderation:block <account_id>           # block the account
bun run moderation:block --clear <account_id>   # unblock it
```

`moderation:source-account` answers only within the 30-day attribution
window; past it the source belongs to no account. It prints the account
ID without the source ID. Keep it that way wherever you copy it: an
account ID must not sit next to a source ID in anything that outlives the
window, such as alerts, issues, or notes (§8). Blocking stops new
contributions at once and keeps the account's sessions, so it can still
sign out and delete itself. To remove what the account already
contributed, purge the quarantined sources.

### Configuration

All configuration comes from environment variables. Bun loads `.env`
automatically. When anything required is missing or invalid, the server
exits with status 1 and lists every problem at once.

| Variable                  | Required | Purpose                                                       |
| ------------------------- | -------- | ------------------------------------------------------------- |
| `PORT`                    | no       | HTTP listen port (default `3000`)                             |
| `DATABASE_URL`            | yes      | Postgres connection string                                    |
| `R2_ACCOUNT_ID`           | yes      | Cloudflare account that owns the R2 bucket                    |
| `R2_ACCESS_KEY_ID`        | yes      | R2 API token access key                                       |
| `R2_SECRET_ACCESS_KEY`    | yes      | R2 API token secret                                           |
| `R2_BUCKET`               | yes      | Bucket for pose blobs and model artifacts                     |
| `APP_BUNDLE_ID`           | yes      | `aud` of Sign in with Apple tokens; Apple `client_id`         |
| `APPLE_TEAM_ID`           | yes      | Apple Developer team ID (client-secret issuer)                |
| `APPLE_KEY_ID`            | yes      | ID of the Sign in with Apple key                              |
| `APPLE_PRIVATE_KEY`       | yes      | That key's `.p8` PEM; on one line, newlines as `\n`           |
| `APPLE_REFRESH_TOKEN_KEY` | yes      | 32 random bytes, base64: encrypts stored Apple refresh tokens |
| `TURNIP_PIPELINE_KEY`     | yes      | Service key for the training pipeline's endpoints             |
| `TRUSTED_PROXIES`         | no       | Trusted proxy addresses and CIDRs, comma-separated (§7.2)     |

## Contributing

1. **Start from an issue.** Work is tracked in GitHub issues. Each one cites
   the design-doc section it implements.
2. **Change the design first.** A change to the schema, the API, or the pose
   format goes to `docs/` in its own PR before any code depends on it.
3. **Respect the privacy boundary.** The farm never accepts or stores video
   pixels, audio, location, device identifiers, or Apple profile data beyond
   the `sub` claim. Logs never record identity tokens. See
   BACKEND_DESIGN.md §8.
4. **Open a PR against `main`.** Start the description with a
   `## Design alignment` section naming the doc sections it implements, then
   a summary. CI (migrate, re-run, typecheck, test, build) must be green.
5. **Migrations are additive.** Never edit or drop an applied migration; add
   a new one. Keep every statement re-runnable (`IF NOT EXISTS`,
   `ON CONFLICT DO NOTHING`) and leave `migrate:down` empty; CI unrecords
   the newest migration and applies it again to check. The one exception
   so far, dropping two `user_id` columns before the first deployment, is
   recorded in BACKEND_DESIGN.md §2.
