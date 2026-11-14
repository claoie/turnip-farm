-- migrate:up

-- BACKEND_DESIGN.md §1.2.24: segments now scale by the whole blob's median
-- torso, not the segment's own. Mark every ingested source dirty so the
-- segmenter re-cuts its segments with the new scale. Re-running only marks
-- them dirty again, which costs one more re-cut and changes nothing else.

UPDATE sources SET segments_dirty_at = now() WHERE sha256 IS NOT NULL;

-- migrate:down

-- Intentionally empty: migrations are additive only (BACKEND_DESIGN.md §2).
