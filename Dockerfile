# The farm's production image (docs/DEPLOYMENT.md §2). On start it applies
# pending migrations, then runs the bundled server. Configuration comes from
# the environment only (README, Configuration); no .env file is copied in.

# The Bun version pinned by `packageManager` in package.json.
FROM oven/bun:1.3.14 AS builder

WORKDIR /app

COPY package.json bun.lock ./
# Full install: dbmate, which the runtime stage needs, is a devDependency.
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src src
COPY db db
COPY scripts scripts

# The database tests skip here (no TEST_DATABASE_URL); CI runs them, and CD
# publishes only commits whose CI passed.
RUN bun run typecheck
RUN bun test
RUN bun run build

# dbmate's npm package ships one native binary per platform.
RUN cp node_modules/@dbmate/linux-*/bin/dbmate /usr/local/bin/dbmate

FROM oven/bun:1.3.14-slim

WORKDIR /app

COPY --from=builder /usr/local/bin/dbmate /usr/local/bin/dbmate
COPY --chown=bun:bun --from=builder /app/dist ./dist
COPY --chown=bun:bun db/migrations ./db/migrations
# The maintainer scripts run from source and need no node_modules:
#   docker exec <container> bun run moderation:block <account_id>
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun src src
COPY --chown=bun:bun scripts scripts

USER bun

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch(`http://localhost:${process.env.PORT}/healthz`); process.exit(r.ok ? 0 : 1)"]

# Migrations are additive and re-runnable (BACKEND_DESIGN.md §2), so applying
# them on every start is safe. --wait rides out a database that is still
# starting.
CMD ["sh", "-c", "dbmate --wait --no-dump-schema migrate && exec bun dist/index.js"]
