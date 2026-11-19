// The maintainer's admin endpoints (BACKEND_DESIGN.md §7.1 "Admin", §7.3):
// browse ingested sources, play one's pose blob, and set or clear the
// curated-holdout flag (§1.2.28). They back the /admin page of the web
// client and need an admin session, from a sign-in through the auth
// service (auth/admin.ts). With admin sign-in not configured, every route
// here answers 404, as if it did not exist.
//
// Nothing here returns an account id or anything from source_attribution.

import { type AdminAuthDeps, authenticateAdmin } from "./auth/admin";
import { isVideoId } from "./contrib/validate";
import { errorResponse } from "./errors";
import { setHoldout } from "./holdout";
import { BlobTooLargeError, MAX_CANONICAL_BLOB_BYTES, type R2Client } from "./r2/client";

export interface AdminDeps extends AdminAuthDeps {
  r2: R2Client;
  /** Page size of GET /api/admin/sources; tests lower it to cross pages cheaply. */
  adminPageLimit?: number;
}

export const ADMIN_PAGE_LIMIT = 50;

// Admin responses describe sources by id; no shared cache keeps them.
const NO_STORE = { "Cache-Control": "no-store" };

const notFound = () => errorResponse(404, "NOT_FOUND", "Not found");

interface Cursor {
  createdAt: string; // created_at as Postgres formats it, microseconds included
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [createdAt, id] = parsed;
  if (typeof createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(createdAt)) return null;
  if (!isVideoId(id)) return null;
  return { createdAt, id };
}

// The first page's upper bound: every row sorts before it, so one query
// shape serves every page.
const FIRST_PAGE: Cursor = { createdAt: "infinity", id: "" };

export interface AdminClip {
  id: string;
  start_frame: number;
  end_frame: number;
  names: string[];
}

export interface AdminSource {
  id: string;
  created_at: string;
  ingested_at: string | null;
  frame_count: number;
  sample_rate: number;
  ingested: boolean;
  holdout: boolean;
  quarantined: boolean;
  clips: AdminClip[];
}

// GET /api/admin/sources?holdout=all|true|false&cursor=<opaque>
// Newest first, keyset-paged on (created_at, id): sources registered in
// one transaction share created_at, so id breaks the tie.
export async function handleListAdminSources(req: Request, deps: AdminDeps): Promise<Response> {
  const session = await authenticateAdmin(req, deps);
  if (session instanceof Response) return session;

  const params = new URL(req.url).searchParams;
  const filter = params.get("holdout") ?? "all";
  if (filter !== "all" && filter !== "true" && filter !== "false") {
    return errorResponse(422, "VALIDATION_ERROR", "holdout must be all, true or false", {
      details: { field: "holdout" },
    });
  }
  const rawCursor = params.get("cursor");
  let cursor = FIRST_PAGE;
  if (rawCursor !== null) {
    const decoded = decodeCursor(rawCursor);
    if (!decoded) {
      return errorResponse(422, "VALIDATION_ERROR", "cursor must be a next_cursor from a previous page", {
        details: { field: "cursor" },
      });
    }
    cursor = decoded;
  }
  const holdout = filter === "all" ? null : filter === "true";
  const limit = deps.adminPageLimit ?? ADMIN_PAGE_LIMIT;

  // Clip names are the clip's distinct label names; the clips array is
  // ordered by window so the player can list them in playback order.
  const rows = (await deps.sql`
    SELECT s.id,
           to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso,
           to_char(s.ingested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ingested_at_iso,
           s.frame_count,
           s.sample_rate,
           s.sha256 IS NOT NULL AS ingested,
           s.holdout,
           EXISTS (SELECT 1 FROM data_quarantine q
                   WHERE q.source_id = s.id AND q.resolved_at IS NULL) AS quarantined,
           COALESCE((
             SELECT json_agg(json_build_object(
                      'id', c.id,
                      'start_frame', c.start_frame,
                      'end_frame', c.end_frame,
                      'names', COALESCE((SELECT json_agg(DISTINCT l.trick_name ORDER BY l.trick_name)
                                         FROM labels l WHERE l.clip_id = c.id), '[]'::json))
                    ORDER BY c.start_frame, c.end_frame, c.id)::text
             FROM clips c WHERE c.source_id = s.id), '[]') AS clips_json
    FROM sources s
    WHERE (${holdout}::boolean IS NULL OR s.holdout = ${holdout}::boolean)
      AND (s.created_at, s.id) < (${cursor.createdAt}::timestamptz, ${cursor.id})
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT ${limit + 1}`) as Record<string, any>[];

  const page = rows.slice(0, limit);
  const sources: AdminSource[] = page.map((r) => ({
    id: r.id as string,
    created_at: r.created_at_iso as string,
    ingested_at: (r.ingested_at_iso as string | null) ?? null,
    frame_count: r.frame_count as number,
    sample_rate: r.sample_rate as number,
    ingested: r.ingested as boolean,
    holdout: r.holdout as boolean,
    quarantined: r.quarantined as boolean,
    clips: JSON.parse(r.clips_json as string) as AdminClip[],
  }));
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last ? encodeCursor({ createdAt: last.created_at_iso as string, id: last.id as string }) : null;
  return Response.json({ sources, next_cursor: nextCursor }, { headers: NO_STORE });
}

// PUT (holdout = true) or DELETE (holdout = false) /api/admin/sources/:id/holdout.
// The same write as `bun run sources:holdout`, updated_at included, so the
// change reaches the export cursor (§1.2.28).
export async function handleSetAdminHoldout(
  req: Request,
  deps: AdminDeps,
  sourceId: string,
  holdout: boolean,
): Promise<Response> {
  const session = await authenticateAdmin(req, deps);
  if (session instanceof Response) return session;
  if (!isVideoId(sourceId)) return notFound();
  const result = await setHoldout(deps.sql, sourceId, holdout);
  if (result === "unknown") return notFound();
  return Response.json(
    { source_id: sourceId, holdout, changed: result === "changed" },
    { headers: NO_STORE },
  );
}

// GET /api/admin/sources/:id/pose — the canonical .tkp1.gz bytes, streamed
// through the farm rather than presigned: a browser fetch of a presigned
// R2 URL needs a CORS rule on the bucket, which the app's downloads do not.
export async function handleGetAdminSourcePose(
  req: Request,
  deps: AdminDeps,
  sourceId: string,
): Promise<Response> {
  const session = await authenticateAdmin(req, deps);
  if (session instanceof Response) return session;
  if (!isVideoId(sourceId)) return notFound();
  const [source] = await deps.sql`SELECT r2_key, sha256 FROM sources WHERE id = ${sourceId}`;
  if (!source) return notFound();
  if (source.sha256 === null) {
    return errorResponse(422, "BLOB_MISSING", "The pose blob is not ingested yet");
  }
  let body: ReadableStream<Uint8Array<ArrayBuffer>> | null;
  try {
    body = await deps.r2.getStream(source.r2_key as string, { maxBytes: MAX_CANONICAL_BLOB_BYTES });
  } catch (err) {
    if (err instanceof BlobTooLargeError) {
      return errorResponse(422, "BLOB_TOO_LARGE", `The pose blob exceeds ${MAX_CANONICAL_BLOB_BYTES} bytes`);
    }
    throw err;
  }
  if (body === null) {
    return errorResponse(422, "BLOB_MISSING", "The pose blob is not in storage");
  }
  // The response pulls from R2 as the browser reads. A body over the cap
  // that didn't declare its length errors mid-stream, cutting the response short.
  return new Response(body, {
    headers: {
      ...NO_STORE,
      "Content-Type": "application/gzip",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
