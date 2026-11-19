// Training export (BACKEND_DESIGN.md §6, §7.3).
// GET /api/labels/export?since= — the pipeline's training pull, service-key
// auth. One row per (source, clip, label), carrying the source's
// whole-recording TKP1 blob reference; quarantined sources excluded;
// ordered by the full (row_cursor, clip_id, trick_name) cursor ascending.
// The keyset is on the whole triple because row_cursor ties are
// guaranteed, not rare — §5 replaces a clip's label set in the same
// transaction as the clip upserts, and Postgres now() returns the
// transaction start, so every row a batch touches shares the exact same
// updated_at.

import { transaction } from "./db";
import { errorResponse } from "./errors";
import { heavyJobs } from "./heavy-jobs";
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
  /** Rows read from the page's cursor at a time; tests lower it like pageLimit. */
  fetchRows?: number;
}

export const EXPORT_PAGE_LIMIT = 10000;

/**
 * A page is read from a server-side cursor this many rows at a time and
 * kept only as JSON text, so the page's row objects are never all alive.
 */
export const EXPORT_FETCH_ROWS = 1000;

/**
 * The fewest distinct contributors a trick needs before turnip-ml trains
 * on it (§1.2.27); exported so the pipeline reads it from one place.
 * A judgment call.
 */
export const HOLD_BACK_MIN_CONTRIBUTORS = 5;

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
 */
export function encodeCursor(rowCursor: string, clipId: string, trickName: string): string {
  return Buffer.from(JSON.stringify([rowCursor, clipId, trickName]), "utf8").toString("base64url");
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

// The first page's lower bound: every row's row_cursor sorts after it, so
// one query shape serves both pages (Bun's sql tag can't add a WHERE
// clause conditionally).
const FIRST_PAGE: Cursor = {
  rowCursor: "-infinity",
  clipId: "00000000-0000-0000-0000-000000000000",
  trickName: "",
};

// The §6 training query. s.sha256 IS NOT NULL is explicit (label
// submission already requires an ingested blob, so this only states it;
// the pipeline fails the run on a null blob_sha256 rather than training on
// a row it can't fetch).
//
// Label names resolve to a canonical by their normalized form (trimmed,
// whitespace collapsed, lowercased; labels.ts normalizeName), whitespace
// being ASCII only (the E'...' strings below spell space, tab, LF,
// VT as \x0B, FF and CR): through the greatest-version raw mapping
// first, else as a canonical itself (§1.2.25), so a name accepted
// through a canonical with no raw row of its own, or typed with odd
// spacing or case, still maps. No match: null.
async function declareRowCursor(tx: ExportDeps["sql"], cursor: Cursor, limit: number): Promise<void> {
  await tx`
    DECLARE export_rows NO SCROLL CURSOR FOR
    WITH raw_map AS (
      SELECT DISTINCT ON (n) n, canonical
      FROM (SELECT lower(regexp_replace(btrim(raw, E' \\t\\n\\x0B\\f\\r'), E'[ \\t\\n\\x0B\\f\\r]+', ' ', 'g')) AS n,
                   canonical, taxonomy_version
            FROM label_taxonomy) r
      ORDER BY n, taxonomy_version DESC
    ),
    canonical_map AS (
      SELECT DISTINCT ON (n) n, canonical
      FROM (SELECT lower(regexp_replace(btrim(canonical, E' \\t\\n\\x0B\\f\\r'), E'[ \\t\\n\\x0B\\f\\r]+', ' ', 'g')) AS n,
                   canonical, taxonomy_version
            FROM label_taxonomy) c
      ORDER BY n, taxonomy_version DESC
    )
    SELECT s.id            AS source_id,
           s.r2_key,
           s.sha256        AS blob_sha256,
           s.holdout,
           c.id            AS clip_id,
           c.start_frame,
           c.end_frame,
           c.proposal_model_version,
           c.suggested_names,
           c.suggestions_withheld,
           l.trick_name,
           COALESCE(rm.canonical, cm.canonical) AS canonical,
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
    LEFT JOIN raw_map rm
           ON rm.n = lower(regexp_replace(btrim(l.trick_name, E' \\t\\n\\x0B\\f\\r'), E'[ \\t\\n\\x0B\\f\\r]+', ' ', 'g'))
    LEFT JOIN canonical_map cm
           ON cm.n = lower(regexp_replace(btrim(l.trick_name, E' \\t\\n\\x0B\\f\\r'), E'[ \\t\\n\\x0B\\f\\r]+', ' ', 'g'))
    WHERE q.id IS NULL
      AND s.sha256 IS NOT NULL
      AND (GREATEST(s.updated_at, c.updated_at, l.updated_at), c.id, l.trick_name)
          > (${cursor.rowCursor}::timestamptz, ${cursor.clipId}::uuid, ${cursor.trickName})
    ORDER BY row_cursor ASC, clip_id ASC, trick_name ASC
    LIMIT ${limit}`;
}

function exportRow(r: Record<string, any>) {
  return {
    source_id: r.source_id,
    r2_key: r.r2_key,
    blob_sha256: r.blob_sha256,
    holdout: r.holdout,
    clip_id: r.clip_id,
    start_frame: r.start_frame,
    end_frame: r.end_frame,
    proposal_model_version: r.proposal_model_version,
    suggested_names: r.suggested_names,
    suggestions_withheld: r.suggestions_withheld,
    trick_name: r.trick_name,
    canonical: r.canonical,
    origin: r.origin,
    taxonomy_version: r.taxonomy_version,
  };
}

// GET /api/labels/export?since= — training pull (service key).
export async function handleGetLabelsExport(req: Request, deps: ExportDeps): Promise<Response> {
  const authed = authenticatePipeline(req, deps.pipelineKey);
  if (authed) return authed;
  const limit = deps.pageLimit ?? EXPORT_PAGE_LIMIT;

  const sinceRaw = new URL(req.url).searchParams.get("since");
  let cursor = FIRST_PAGE;
  if (sinceRaw !== null && sinceRaw !== "") {
    const decoded = decodeCursor(sinceRaw);
    if (!decoded) return invalid("since must be the opaque cursor from a previous next_cursor");
    cursor = decoded;
  }
  return heavyJobs.use(() => exportPage(deps, cursor, limit));
}

async function exportPage(deps: ExportDeps, cursor: Cursor, limit: number): Promise<Response> {
  const fetchRows = deps.fetchRows ?? EXPORT_FETCH_ROWS;
  const page = await transaction(deps.sql, async (tx) => {
    await declareRowCursor(tx, cursor, limit);
    const json: string[] = [];
    let last: Record<string, any> | undefined;
    for (;;) {
      const rows = (await tx.unsafe(`FETCH ${fetchRows} FROM export_rows`)) as Record<string, any>[];
      if (rows.length === 0) break;
      json.push(rows.map((r) => JSON.stringify(exportRow(r))).join(","));
      last = rows[rows.length - 1];
    }
    await tx.unsafe("CLOSE export_rows");
    return { json, last };
  });

  // The whole label_taxonomy table, not just the versions present in rows:
  // a raw string mapped only at an old version would otherwise silently
  // become unmapped in training (maintainer decision 2026-10-14 on #19).
  const taxonomy = (await deps.sql`
    SELECT raw, canonical, taxonomy_version
    FROM label_taxonomy
    ORDER BY taxonomy_version ASC, raw ASC`) as Record<string, any>[];

  // Distinct contributing accounts per canonical trick (§1.2.27), for the
  // pipeline's hold-back. Counted over every exported row's source (not
  // just this page's) through its attribution; a source with no
  // attribution left counts for nobody, and neither does a holdout source
  // (§1.2.28: the maintainer's own footage, never trained on). Names
  // resolve as each row's `canonical` does; one with no match counts as
  // its normalized self.
  const contributors = (await deps.sql`
    WITH raw_map AS (
      SELECT DISTINCT ON (n) n, canonical
      FROM (SELECT lower(regexp_replace(btrim(raw, E' \\t\\n\\x0B\\f\\r'), E'[ \\t\\n\\x0B\\f\\r]+', ' ', 'g')) AS n,
                   canonical, taxonomy_version
            FROM label_taxonomy) r
      ORDER BY n, taxonomy_version DESC
    ),
    canonical_map AS (
      SELECT DISTINCT ON (n) n, canonical
      FROM (SELECT lower(regexp_replace(btrim(canonical, E' \\t\\n\\x0B\\f\\r'), E'[ \\t\\n\\x0B\\f\\r]+', ' ', 'g')) AS n,
                   canonical, taxonomy_version
            FROM label_taxonomy) c
      ORDER BY n, taxonomy_version DESC
    )
    SELECT COALESCE(rm.canonical, cm.canonical,
                    lower(regexp_replace(btrim(l.trick_name, E' \\t\\n\\x0B\\f\\r'), E'[ \\t\\n\\x0B\\f\\r]+', ' ', 'g'))) AS canonical,
           count(DISTINCT a.user_id)::int AS contributors
    FROM sources s
    JOIN clips  c ON c.source_id = s.id
    JOIN labels l ON l.clip_id   = c.id
    JOIN source_attribution a ON a.source_id = s.id
    LEFT JOIN data_quarantine q ON q.source_id = s.id AND q.resolved_at IS NULL
    LEFT JOIN raw_map rm
           ON rm.n = lower(regexp_replace(btrim(l.trick_name, E' \\t\\n\\x0B\\f\\r'), E'[ \\t\\n\\x0B\\f\\r]+', ' ', 'g'))
    LEFT JOIN canonical_map cm
           ON cm.n = lower(regexp_replace(btrim(l.trick_name, E' \\t\\n\\x0B\\f\\r'), E'[ \\t\\n\\x0B\\f\\r]+', ' ', 'g'))
    WHERE q.id IS NULL
      AND s.sha256 IS NOT NULL
      AND NOT s.holdout
    GROUP BY 1
    ORDER BY 1`) as { canonical: string; contributors: number }[];

  // The bytes Response.json would write, sent one fetched batch at a time.
  const { json, last } = page;
  const tail = JSON.stringify({
    taxonomy: taxonomy.map((t) => ({
      raw: t.raw,
      canonical: t.canonical,
      taxonomy_version: t.taxonomy_version,
    })),
    trick_contributors: contributors.map((c) => ({ canonical: c.canonical, contributors: c.contributors })),
    contributor_minimum: HOLD_BACK_MIN_CONTRIBUTORS,
    // Non-null whenever rows is non-empty; null only on an empty page:
    // the pipeline gets an exact watermark for the cost of one extra
    // empty request per pull.
    next_cursor: last ? encodeCursor(last.row_cursor_iso as string, last.clip_id, last.trick_name) : null,
  });
  const chunks = ['{"rows":[', ...json.map((part, i) => (i === 0 ? part : `,${part}`)), `],${tail.slice(1)}`];
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
    }),
    { headers: { "Content-Type": "application/json;charset=utf-8" } },
  );
}
