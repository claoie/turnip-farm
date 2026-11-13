// Training export (BACKEND_DESIGN.md §6, §7.3).
// GET /api/labels/export?since= — the pipeline's training pull, service-key
// auth. Serves training segments (§1.2.24), never whole-session pose:
// one entry per segment with its labels, segments of quarantined sources
// excluded, ordered by segment id ascending. Segment ids are random UUIDs
// and segments carry no timestamps, so the cursor is a pagination
// position only; every training dataset is built from a full pull (§6).

import { errorResponse } from "./errors";
import { authenticatePipeline, type PipelineDeps } from "./pipeline";
import { isUuid } from "./contrib/validate";

export interface ExportDeps extends PipelineDeps {
  /**
   * Page size. 10000 in production (§7.3); tests pass a small limit to
   * cross the LIMIT boundary without inserting ten thousand segments.
   */
  pageLimit?: number;
}

export const EXPORT_PAGE_LIMIT = 10000;

/**
 * The fewest distinct contributors a trick needs before turnip-ml trains
 * on it (§1.2.27); exported so the pipeline reads it from one place.
 * A judgment call.
 */
export const HOLD_BACK_MIN_CONTRIBUTORS = 5;

/** Opaque cursor: base64url of the JSON array `[segment_id]`. */
export function encodeCursor(segmentId: string): string {
  return Buffer.from(JSON.stringify([segmentId]), "utf8").toString("base64url");
}

function decodeCursor(since: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(since, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) return null;
  return isUuid(parsed[0]) ? (parsed[0] as string).toLowerCase() : null;
}

const invalid = (message: string) => errorResponse(422, "VALIDATION_ERROR", message);

// The §6 training query. A segment still linked to a source is excluded
// while that source has an open quarantine row; a de-linked segment (its
// account was deleted) can no longer be quarantined. A segment always has
// at least one label (the segmenter cuts labeled clips only); the EXISTS
// states it. Bun's sql tag can't add a WHERE clause conditionally, so the
// first page uses the nil UUID as its lower bound: every v4 id sorts after it.
async function selectSegments(
  sql: ExportDeps["sql"],
  after: string,
  limit: number,
): Promise<Record<string, any>[]> {
  return (await sql`
    SELECT t.id                     AS segment_id,
           t.r2_key,
           t.sha256                 AS blob_sha256,
           t.frame_count,
           t.window_start,
           t.window_end,
           t.split_bucket,
           t.proposal_model_version,
           t.suggested_names,
           t.suggestions_withheld,
           (SELECT json_agg(json_build_object('trick_name', l.trick_name,
                                              'origin', l.origin,
                                              'taxonomy_version', l.taxonomy_version)
                            ORDER BY l.trick_name)
            FROM training_segment_labels l
            WHERE l.segment_id = t.id)::text AS labels_json
    FROM training_segments t
    LEFT JOIN segment_sources ss ON ss.segment_id = t.id
    LEFT JOIN data_quarantine q  ON q.source_id = ss.source_id AND q.resolved_at IS NULL
    WHERE q.id IS NULL
      AND EXISTS (SELECT 1 FROM training_segment_labels l WHERE l.segment_id = t.id)
      AND t.id > ${after}::uuid
    ORDER BY t.id ASC
    LIMIT ${limit}`) as Record<string, any>[];
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// GET /api/labels/export?since= — training pull (service key).
export async function handleGetLabelsExport(req: Request, deps: ExportDeps): Promise<Response> {
  const authed = authenticatePipeline(req, deps.pipelineKey);
  if (authed) return authed;
  const limit = deps.pageLimit ?? EXPORT_PAGE_LIMIT;

  const sinceRaw = new URL(req.url).searchParams.get("since");
  let after = NIL_UUID;
  if (sinceRaw !== null && sinceRaw !== "") {
    const cursor = decodeCursor(sinceRaw);
    if (cursor === null) return invalid("since must be the opaque cursor from a previous next_cursor");
    after = cursor;
  }

  const segments = await selectSegments(deps.sql, after, limit);

  // The whole label_taxonomy table, not just the versions present in rows:
  // a raw string mapped only at an old version would otherwise silently
  // become unmapped in training (maintainer decision 2026-10-14 on #19).
  const taxonomy = (await deps.sql`
    SELECT raw, canonical, taxonomy_version
    FROM label_taxonomy
    ORDER BY taxonomy_version ASC, raw ASC`) as Record<string, any>[];

  // Distinct contributing accounts per canonical trick (§1.2.27), for the
  // pipeline's hold-back. Counted over exported segments still linked to
  // an attributed source; a de-linked segment's contributor is unknown,
  // so it counts for nobody. A raw name resolves through its
  // greatest-version mapping; one with no mapping counts as itself.
  const contributors = (await deps.sql`
    WITH current_map AS (
      SELECT DISTINCT ON (lower(raw)) lower(raw) AS raw, canonical
      FROM label_taxonomy
      ORDER BY lower(raw), taxonomy_version DESC
    )
    SELECT COALESCE(m.canonical, lower(l.trick_name)) AS canonical,
           count(DISTINCT a.user_id)::int             AS contributors
    FROM training_segment_labels l
    JOIN segment_sources ss    ON ss.segment_id = l.segment_id
    JOIN source_attribution a  ON a.source_id = ss.source_id
    LEFT JOIN data_quarantine q ON q.source_id = ss.source_id AND q.resolved_at IS NULL
    LEFT JOIN current_map m     ON m.raw = lower(l.trick_name)
    WHERE q.id IS NULL
    GROUP BY 1
    ORDER BY 1`) as { canonical: string; contributors: number }[];

  const last = segments[segments.length - 1];
  return Response.json({
    segments: segments.map((s) => ({
      segment_id: s.segment_id,
      r2_key: s.r2_key,
      blob_sha256: s.blob_sha256,
      frame_count: s.frame_count,
      window_start: s.window_start,
      window_end: s.window_end,
      split_bucket: s.split_bucket,
      proposal_model_version: s.proposal_model_version,
      suggested_names: s.suggested_names,
      suggestions_withheld: s.suggestions_withheld,
      labels: JSON.parse(s.labels_json as string),
    })),
    taxonomy: taxonomy.map((t) => ({
      raw: t.raw,
      canonical: t.canonical,
      taxonomy_version: t.taxonomy_version,
    })),
    trick_contributors: contributors.map((c) => ({ canonical: c.canonical, contributors: c.contributors })),
    contributor_minimum: HOLD_BACK_MIN_CONTRIBUTORS,
    // Non-null whenever segments is non-empty; null only on an empty page.
    next_cursor: last ? encodeCursor(last.segment_id as string) : null,
  });
}
