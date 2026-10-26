// Contribution: sources (BACKEND_DESIGN.md §7.3).
// Ownership is a per-source key (§1.2.13); a missing or wrong key is 404,
// never 403, so source IDs are not an ownership oracle (§7.2). Every write
// upserts source_attribution in the same transaction (§4); reads of
// attribution filter the 30-day window (§1.2.17) — this module only writes
// it. Logs never carry user/session IDs next to source IDs, nor source
// keys (§8).

import type { SQL } from "bun";
import { sha256Hex } from "../auth/tokens";
import { transaction } from "../db";
import { errorResponse } from "../errors";
import { authenticateClient } from "../auth/sessions";
import { canonicalKeyFor, stagingKeyFor } from "../r2/keys";
import type { R2Client } from "../r2/client";
import type { RateLimits } from "../app";
import { isSourceKey, isVideoId, readJsonObject } from "./validate";

export interface SourcesDeps {
  sql: SQL;
  r2: R2Client;
  limits: RateLimits;
}

type Authed = { userId: string };

async function authed(req: Request, deps: SourcesDeps): Promise<Authed | Response> {
  const auth = await authenticateClient(req, deps);
  return auth instanceof Response ? auth : { userId: auth.userId };
}

// Per-user token bucket on POSTs (§7.2). Null when the request may proceed.
function rateLimit(deps: SourcesDeps, userId: string): Response | null {
  if (deps.limits.user.take(userId)) return null;
  return errorResponse(429, "RATE_LIMITED", "Too many requests", {
    headers: { "Retry-After": String(deps.limits.user.retryAfterSec(userId)) },
  });
}

const notFound = () => errorResponse(404, "NOT_FOUND", "Not found");

const invalid = (message: string, details: Record<string, unknown> = {}) =>
  errorResponse(422, "VALIDATION_ERROR", message, { details });

function sourceKeyHash(req: Request): string | null {
  const key = req.headers.get("source-key");
  return key !== null && isSourceKey(key) ? sha256Hex(key) : null;
}

// POST /api/sources — register a source, get the blob upload URL (§7.3).
export async function handleRegisterSource(req: Request, deps: SourcesDeps): Promise<Response> {
  const auth = await authed(req, deps);
  if (auth instanceof Response) return auth;
  const limited = rateLimit(deps, auth.userId);
  if (limited) return limited;

  const body = await readJsonObject(req);
  const videoId = body?.video_id;
  const sourceKey = body?.source_key;
  const frameCount = body?.frame_count;
  const sampleRate = body?.sample_rate;
  const keypointFormat = body?.keypoint_format;
  if (!isVideoId(videoId)) return invalid("video_id must be 64-char lowercase hex");
  if (!isSourceKey(sourceKey)) return invalid("source_key must be 43-char base64url");
  if (!Number.isInteger(frameCount) || (frameCount as number) <= 0) {
    return invalid("frame_count must be a positive integer");
  }
  if (typeof sampleRate !== "number" || !(sampleRate >= 1 && sampleRate <= 30)) {
    return invalid("sample_rate must be a number in 1..30");
  }
  if (keypointFormat !== "tkp1") {
    return errorResponse(422, "UNSUPPORTED_FORMAT", "keypoint_format must be tkp1");
  }

  const keyHash = sha256Hex(sourceKey);
  const r2Key = canonicalKeyFor(videoId);
  const result = await transaction(deps.sql, async (tx) => {
    // §4: full replace on re-contribution, except ownership (first writer
    // wins) and sha256 (owned by ingest). No row → claimed under another
    // key → 409.
    const [row] = await tx`
      INSERT INTO sources
        (id, source_key_hash, frame_count, sample_rate, keypoint_format, r2_key, updated_at)
      VALUES (${videoId}, ${keyHash}, ${frameCount}, ${sampleRate}, ${keypointFormat}, ${r2Key}, now())
      ON CONFLICT (id) DO UPDATE SET
        frame_count     = EXCLUDED.frame_count,
        sample_rate     = EXCLUDED.sample_rate,
        keypoint_format = EXCLUDED.keypoint_format,
        r2_key          = EXCLUDED.r2_key,
        updated_at      = now()
      WHERE sources.source_key_hash = EXCLUDED.source_key_hash
      RETURNING (xmax = 0) AS inserted, sha256`;
    if (!row) return null;
    await tx`
      INSERT INTO source_attribution (source_id, user_id)
      VALUES (${videoId}, ${auth.userId})
      ON CONFLICT (source_id) DO UPDATE SET
        user_id       = EXCLUDED.user_id,
        attributed_at = now()`;
    return { inserted: row.inserted as boolean, sha256: row.sha256 as string | null };
  });
  if (result === null) {
    return errorResponse(409, "SOURCE_ALREADY_CLAIMED", "This source is already claimed under another key");
  }

  // Cross-PR contract with the ingest worker: the presigned upload
  // URL MUST target the staging key it polls.
  const upload = deps.r2.presignPut(stagingKeyFor(videoId));
  return Response.json(
    {
      source_id: videoId,
      r2_key: r2Key,
      upload_url: upload.url,
      upload_expires_at: upload.expiresAt.toISOString(),
      blob_present: result.sha256 !== null,
    },
    { status: result.inserted ? 201 : 200 },
  );
}

interface ClipRow {
  id: string;
  start_frame: number;
  end_frame: number;
  auto_detected: boolean;
  proposal_model_version: string | null;
  suggested_names: string[];
  suggestions_withheld: boolean;
  labels: { name: string; origin: string; taxonomy_version: number; created_at: string }[];
}

// GET /api/sources/:id — source with confirmed clips + labels (§7.3).
export async function handleGetSource(
  req: Request,
  deps: SourcesDeps,
  sourceId: string,
): Promise<Response> {
  const auth = await authed(req, deps);
  if (auth instanceof Response) return auth;
  if (!isVideoId(sourceId)) return notFound();
  const keyHash = sourceKeyHash(req);
  if (keyHash === null) return notFound();

  const [source] = await deps.sql`
    SELECT id, frame_count, sample_rate, keypoint_format, sha256, created_at, updated_at
    FROM sources
    WHERE id = ${sourceId} AND source_key_hash = ${keyHash}`;
  if (!source) return notFound();

  const rows = await deps.sql`
    SELECT c.id, c.start_frame, c.end_frame, c.auto_detected, c.created_at,
           c.proposal_model_version, c.suggested_names, c.suggestions_withheld,
           l.trick_name, l.origin, l.taxonomy_version, l.created_at AS label_created_at
    FROM clips c
    LEFT JOIN labels l ON l.clip_id = c.id
    WHERE c.source_id = ${sourceId}
    ORDER BY c.created_at, c.id, l.created_at, lower(l.trick_name)`;
  const clips = new Map<string, ClipRow>();
  for (const r of rows as Record<string, unknown>[]) {
    let clip = clips.get(r.id as string);
    if (!clip) {
      clip = {
        id: r.id as string,
        start_frame: r.start_frame as number,
        end_frame: r.end_frame as number,
        auto_detected: r.auto_detected as boolean,
        proposal_model_version: r.proposal_model_version as string | null,
        suggested_names: r.suggested_names as string[],
        suggestions_withheld: r.suggestions_withheld as boolean,
        labels: [],
      };
      clips.set(clip.id, clip);
    }
    if (r.trick_name !== null) {
      clip.labels.push({
        name: r.trick_name as string,
        origin: r.origin as string,
        taxonomy_version: r.taxonomy_version as number,
        created_at: (r.label_created_at as Date).toISOString(),
      });
    }
  }

  // The impact read (§7.3, §1.2.20): promoted model versions whose training
  // set held this source, oldest first; [] until a model trains on it.
  // Promoted = non-null promoted_at (the greatest one is the current model).
  const trained = await deps.sql`
    SELECT m.version
    FROM model_training_sources mts
    JOIN models m ON m.version = mts.model_version
    WHERE mts.source_id = ${sourceId} AND m.promoted_at IS NOT NULL
    ORDER BY m.promoted_at ASC`;

  return Response.json({
    source: {
      id: source.id,
      frame_count: source.frame_count,
      sample_rate: source.sample_rate,
      keypoint_format: source.keypoint_format,
      sha256: source.sha256,
      trained_in: trained.map((r: { version: string }) => r.version),
      created_at: (source.created_at as Date).toISOString(),
      updated_at: (source.updated_at as Date).toISOString(),
    },
    clips: [...clips.values()],
  });
}

// GET /api/sources/:id/pose — owner-only pose blob download (§7.3).
export async function handleGetSourcePose(
  req: Request,
  deps: SourcesDeps,
  sourceId: string,
): Promise<Response> {
  const auth = await authed(req, deps);
  if (auth instanceof Response) return auth;
  if (!isVideoId(sourceId)) return notFound();
  const keyHash = sourceKeyHash(req);
  if (keyHash === null) return notFound();

  const [source] = await deps.sql`
    SELECT r2_key, sha256 FROM sources
    WHERE id = ${sourceId} AND source_key_hash = ${keyHash}`;
  if (!source) return notFound();
  if (source.sha256 === null) {
    return errorResponse(422, "BLOB_MISSING", "The pose blob is not ingested yet");
  }
  const download = deps.r2.presignGet(source.r2_key as string);
  return Response.json({ url: download.url, expires_at: download.expiresAt.toISOString() });
}

// DELETE /api/sources/:id — owner-only hard delete (§7.3).
export async function handleDeleteSource(
  req: Request,
  deps: SourcesDeps,
  sourceId: string,
): Promise<Response> {
  const auth = await authed(req, deps);
  if (auth instanceof Response) return auth;
  if (!isVideoId(sourceId)) return notFound();
  const keyHash = sourceKeyHash(req);
  if (keyHash === null) return notFound();

  // R2 first, then the row (§7.3 DELETE /api/account order): if either
  // delete throws, the source row survives so the client can retry the
  // whole delete — DELETE is idempotent, so the retry deletes both blobs
  // and then the row.
  const [source] = await deps.sql`
    SELECT r2_key FROM sources
    WHERE id = ${sourceId} AND source_key_hash = ${keyHash}`;
  if (!source) return notFound();
  try {
    await deps.r2.deleteObject(source.r2_key as string);
    await deps.r2.deleteObject(stagingKeyFor(sourceId));
  } catch {
    return errorResponse(500, "INTERNAL", "Could not delete the stored blob; retry later");
  }
  await transaction(deps.sql, async (tx) => {
    await tx`DELETE FROM sources WHERE id = ${sourceId}`;
  });
  return new Response(null, { status: 204 });
}
