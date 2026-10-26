// Training export (BACKEND_DESIGN.md §6, §7.3; issue #19).
// GET /api/labels/export?since= — the pipeline's training pull, service-key
// auth. Label-granular rows, quarantined sources excluded, ordered by the
// full (row_cursor, clip_id, trick_name) cursor ascending. The keyset is on
// the whole triple because row_cursor ties are guaranteed, not rare — §5
// replaces a clip's label set in the same transaction as the clip upserts,
// and Postgres now() returns the transaction start, so every row a batch
// touches shares the exact same updated_at.

import { errorResponse } from "./errors";
import { authenticatePipeline, type PipelineDeps } from "./pipeline";
import { isUuid } from "./contrib/validate";

export interface ExportDeps extends PipelineDeps {
  /**
   * Page size. 10000 in production (§7.3); tests pass a small limit to
   * cross the LIMIT boundary without inserting ten thousand rows — the
   * keyset logic is limit-agnostic, so the small-limit torture test
   * exercises the exact production code path.
   */
  pageLimit?: number;
}

export const EXPORT_PAGE_LIMIT = 10000;

interface Cursor {
  rowCursor: string; // ISO-8601 UTC with microseconds, the GREATEST(updated_at) triple's head
  clipId: string;
  trickName: string;
}

/**
 * Opaque cursor: base64url of the JSON triple. The pipeline treats it as opaque.
 * rowCursor is row_cursor_iso, formatted by Postgres at full microsecond
 * precision: updated_at comes from now(), and a JS Date (milliseconds) would
 * truncate it, so the keyset predicate would match the page's last row again.
 * Cursors encoded before that (".sssZ") still decode and still cast.
 */
export function encodeCursor(rowCursor: string, clipId: string, trickName: string): string {
  return Buffer.from(
    JSON.stringify([rowCursor, clipId, trickName]),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(since: string): Cursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(since, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [iso, clipId, trickName] = parsed;
  if (typeof iso !== "string" || Number.isNaN(Date.parse(iso))) return null;
  if (!isUuid(clipId)) return null;
  if (typeof trickName !== "string" || trickName === "") return null;
  return { rowCursor: iso, clipId, trickName };
}

const invalid = (message: string) => errorResponse(422, "VALIDATION_ERROR", message);

// The §6 training query, with the maintainer's #19 refinements:
// s.sha256 IS NOT NULL is explicit (label submission already requires an
// ingested blob, so this only states it; the pipeline fails the run on a
// null blob_sha256 rather than training on a row it can't fetch).
// The two shapes below must stay identical except for the keyset
// predicate — Bun's sql tag can't conditionally add a WHERE clause.
async function selectRows(
  sql: ExportDeps["sql"],
  cursor: Cursor | null,
  limit: number,
): Promise<Record<string, any>[]> {
  // The two shapes must stay identical except for the keyset predicate.
  if (cursor) {
    return (await sql`
      SELECT s.id            AS source_id,
             s.r2_key,
             s.sha256        AS blob_sha256,
             c.id            AS clip_id,
             c.start_frame,
             c.end_frame,
             c.proposal_model_version,
             c.suggested_names,
             c.suggestions_withheld,
             l.trick_name,
             l.origin,
             l.taxonomy_version,
             GREATEST(s.updated_at, c.updated_at, l.updated_at) AS row_cursor,
             to_char(GREATEST(s.updated_at, c.updated_at, l.updated_at) AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS row_cursor_iso
      FROM sources s
      JOIN clips  c ON c.source_id = s.id
      JOIN labels l ON l.clip_id   = c.id
      LEFT JOIN data_quarantine q
             ON q.source_id = s.id AND q.resolved_at IS NULL
      WHERE q.id IS NULL
        AND s.sha256 IS NOT NULL
        AND (GREATEST(s.updated_at, c.updated_at, l.updated_at), c.id, l.trick_name)
            > (${cursor.rowCursor}::timestamptz, ${cursor.clipId}::uuid, ${cursor.trickName})
      ORDER BY row_cursor ASC, clip_id ASC, trick_name ASC
      LIMIT ${limit}`) as Record<string, any>[];
  }
  return (await sql`
    SELECT s.id            AS source_id,
           s.r2_key,
           s.sha256        AS blob_sha256,
           c.id            AS clip_id,
           c.start_frame,
           c.end_frame,
           c.proposal_model_version,
           c.suggested_names,
           c.suggestions_withheld,
           l.trick_name,
           l.origin,
           l.taxonomy_version,
           GREATEST(s.updated_at, c.updated_at, l.updated_at) AS row_cursor,
           to_char(GREATEST(s.updated_at, c.updated_at, l.updated_at) AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS row_cursor_iso
    FROM sources s
    JOIN clips  c ON c.source_id = s.id
    JOIN labels l ON l.clip_id   = c.id
    LEFT JOIN data_quarantine q
           ON q.source_id = s.id AND q.resolved_at IS NULL
    WHERE q.id IS NULL
      AND s.sha256 IS NOT NULL
    ORDER BY row_cursor ASC, clip_id ASC, trick_name ASC
    LIMIT ${limit}`) as Record<string, any>[];
}

// GET /api/labels/export?since= — training pull (service key).
export async function handleGetLabelsExport(req: Request, deps: ExportDeps): Promise<Response> {
  const authed = authenticatePipeline(req, deps.pipelineKey);
  if (authed) return authed;
  const limit = deps.pageLimit ?? EXPORT_PAGE_LIMIT;

  const sinceRaw = new URL(req.url).searchParams.get("since");
  let cursor: Cursor | null = null;
  if (sinceRaw !== null && sinceRaw !== "") {
    cursor = decodeCursor(sinceRaw);
    if (!cursor) return invalid("since must be the opaque cursor from a previous next_cursor");
  }

  const rows = await selectRows(deps.sql, cursor, limit);

  // The whole label_taxonomy table, not just the versions present in rows:
  // a raw string mapped only at an old version would otherwise silently
  // become unmapped in training (maintainer decision 2026-10-14 on #19).
  const taxonomy = (await deps.sql`
    SELECT raw, canonical, taxonomy_version
    FROM label_taxonomy
    ORDER BY taxonomy_version ASC, raw ASC`) as Record<string, any>[];

  const last = rows[rows.length - 1];
  return Response.json({
    rows: rows.map((r) => ({
      source_id: r.source_id,
      r2_key: r.r2_key,
      blob_sha256: r.blob_sha256,
      clip_id: r.clip_id,
      start_frame: r.start_frame,
      end_frame: r.end_frame,
      proposal_model_version: r.proposal_model_version,
      suggested_names: r.suggested_names,
      suggestions_withheld: r.suggestions_withheld,
      trick_name: r.trick_name,
      origin: r.origin,
      taxonomy_version: r.taxonomy_version,
    })),
    taxonomy: taxonomy.map((t) => ({
      raw: t.raw,
      canonical: t.canonical,
      taxonomy_version: t.taxonomy_version,
    })),
    // Non-null whenever rows is non-empty; null only on an empty page —
    // the pipeline gets an exact watermark for the cost of one extra
    // empty request per pull (maintainer decision 2026-10-14 on #19).
    next_cursor: last ? encodeCursor(last.row_cursor_iso as string, last.clip_id, last.trick_name) : null,
  });
}
