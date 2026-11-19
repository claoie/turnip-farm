-- migrate:up

-- BACKEND_DESIGN.md §1.2.20, §3: training-source ids the pipeline sends
-- in pages ahead of POST /api/models, keyed by the version and artifact
-- digest they are for. The publish moves them into model_training_sources
-- in its own transaction. No account column; a deleted source drops out.
CREATE TABLE IF NOT EXISTS model_training_source_pages (
  model_version TEXT NOT NULL,
  model_sha256  CHAR(64) NOT NULL CHECK (model_sha256 ~ '^[0-9a-f]{64}$'),
  source_id     CHAR(64) NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  staged_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (model_version, model_sha256, source_id)
);
CREATE INDEX IF NOT EXISTS model_training_source_pages_staged_at_idx
  ON model_training_source_pages (staged_at);

-- migrate:down

-- Intentionally empty: migrations are additive only (BACKEND_DESIGN.md §2).
