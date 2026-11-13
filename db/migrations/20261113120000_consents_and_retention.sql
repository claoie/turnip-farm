-- migrate:up

-- BACKEND_DESIGN.md §3 as amended by the privacy plan (§1.2.17, §7.3
-- POST /api/consent): consent recorded on the farm, and attribution kept
-- until deletion or 24 months without activity. Every statement is
-- re-runnable (§2).

CREATE TABLE IF NOT EXISTS consents (
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  disclosure_version INTEGER NOT NULL CHECK (disclosure_version > 0),
  -- The contribution disclosure the account agreed to; the app shows it
  -- with the 16+ confirmation (§7.1).
  agreed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The first agreement to that version; agreeing again keeps it.
  PRIMARY KEY (user_id, disclosure_version)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ NOT NULL DEFAULT now();
-- Set at sign-in and, at most hourly, by authenticated requests (§7.1).
-- Accounts idle for 24 months are deleted (§1.2.17).
CREATE INDEX IF NOT EXISTS users_last_active_at_idx ON users (last_active_at);

-- migrate:down

-- Intentionally empty: migrations are additive only (BACKEND_DESIGN.md §2).
