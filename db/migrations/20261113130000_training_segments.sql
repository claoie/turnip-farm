-- migrate:up

-- BACKEND_DESIGN.md §3 as amended by the privacy plan (§1.2.24): the
-- training export serves short, re-targeted segments instead of
-- whole-session pose. Segments carry fresh random ids and no timestamps;
-- their only link to a source is segment_sources, which goes with the
-- source (and so with the account). Every statement is re-runnable (§2).

CREATE TABLE IF NOT EXISTS training_segments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  r2_key                 TEXT NOT NULL UNIQUE,
  -- segments/<id>.tks1.gz (POSE_FORMAT.md §12)
  sha256                 CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- Of the stored (gzipped) bytes.
  frame_count            INTEGER NOT NULL CHECK (frame_count > 0),
  window_start           INTEGER NOT NULL CHECK (window_start >= 0),
  window_end             INTEGER NOT NULL,
  -- The clip window inside the segment, in segment frames, end exclusive.
  split_bucket           SMALLINT NOT NULL CHECK (split_bucket BETWEEN 0 AND 9),
  -- Same for every segment of a source, for leakage-free holdout splits.
  proposal_model_version TEXT,
  suggested_names        TEXT[] NOT NULL DEFAULT '{}',
  suggestions_withheld   BOOLEAN NOT NULL DEFAULT FALSE,
  -- The clip's provenance (§1.2.18), copied at cut time.
  CONSTRAINT training_segments_window CHECK (window_start < window_end AND window_end <= frame_count)
);

CREATE TABLE IF NOT EXISTS training_segment_labels (
  segment_id       UUID NOT NULL REFERENCES training_segments(id) ON DELETE CASCADE,
  trick_name       TEXT NOT NULL,
  origin           TEXT NOT NULL CHECK (origin IN ('typed', 'vocabulary', 'model')),
  taxonomy_version INTEGER NOT NULL,
  PRIMARY KEY (segment_id, trick_name)
);

CREATE TABLE IF NOT EXISTS segment_sources (
  segment_id UUID PRIMARY KEY REFERENCES training_segments(id) ON DELETE CASCADE,
  source_id  CHAR(64) NOT NULL REFERENCES sources(id) ON DELETE CASCADE
  -- The only link from a segment to its source; deleted with the source,
  -- and so with the account. The segment itself stays, de-linked.
);
CREATE INDEX IF NOT EXISTS segment_sources_source_id_idx ON segment_sources (source_id);

ALTER TABLE sources ADD COLUMN IF NOT EXISTS segments_dirty_at TIMESTAMPTZ;
-- Set by ingest and by clip and label writes: the source's segments need
-- cutting again.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS segments_cut_at TIMESTAMPTZ;
-- The segments_dirty_at the current segments were cut for.
CREATE INDEX IF NOT EXISTS sources_segments_dirty_idx ON sources (segments_dirty_at)
  WHERE segments_dirty_at IS NOT NULL;

-- migrate:down

-- Intentionally empty: migrations are additive only (BACKEND_DESIGN.md §2).
