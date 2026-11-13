-- migrate:up

-- BACKEND_DESIGN.md §3 as amended by the privacy plan (§1.2.25): label
-- names the vocabulary lacks wait here instead of reaching `labels`.
-- Every statement is re-runnable (§2).

CREATE TABLE IF NOT EXISTS label_candidates (
  name         TEXT NOT NULL
               CHECK (name <> '' AND name = btrim(name) AND char_length(name) <= 64),
  account_hash CHAR(64) NOT NULL CHECK (account_hash ~ '^[0-9a-f]{64}$'),
  -- HMAC-SHA-256 of the account id under a server key: counts distinct
  -- accounts per name without storing the id.
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
  -- The account's first submission of the name; deleted 30 days after it.
);
CREATE UNIQUE INDEX IF NOT EXISTS label_candidates_name_account_uniq
  ON label_candidates (lower(name), account_hash);
CREATE INDEX IF NOT EXISTS label_candidates_account_hash_idx ON label_candidates (account_hash);
CREATE INDEX IF NOT EXISTS label_candidates_submitted_at_idx ON label_candidates (submitted_at);

-- migrate:down

-- Intentionally empty: migrations are additive only (BACKEND_DESIGN.md §2).
