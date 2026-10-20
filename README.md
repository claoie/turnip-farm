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

Early. The service starts, validates its configuration, and serves
`GET /healthz`. The Postgres schema (BACKEND_DESIGN.md §3) is in place as
dbmate migrations. Sign in with Apple and farm sessions (§7.1) work:
`POST /api/auth/apple` and `POST /api/auth/signout`. The contribution,
model, and export endpoints are tracked as separate issues.

## Layout

```
src/
  index.ts         entry point: loads config, starts the server
  app.ts           HTTP routing
  errors.ts        the API error shape (BACKEND_DESIGN.md §7.2)
  db.ts            transaction helper
  auth/
    apple.ts       Apple JWT verification, client secret, code exchange
    sessions.ts    sign-in, sign-out, and session authentication (§7.1)
    tokens.ts      session tokens and refresh-token encryption
    testing.ts     stand-in Apple endpoints for tests
  config.ts        env-based configuration; fails fast on missing variables
  *.test.ts        tests (bun test), next to the code they cover
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

Tests that need a database (`db/schema.test.ts` and parts of
`src/auth/sessions.test.ts`) run only when `TEST_DATABASE_URL` names a migrated
database. They never read `DATABASE_URL`, and every test rolls its
transaction back, so pointing them at the local database above is safe. CI
sets it, and the tests fail rather than skip when it is missing there.

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
