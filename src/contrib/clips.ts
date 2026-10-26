// Contribution: clips + labels (BACKEND_DESIGN.md §4, §5, §7.3).
// Batch and single-clip writes converge on one primitive: replace the
// label set of a clip, inside the same transaction as the clip upserts,
// so a batch is all-or-nothing (§5). Blob verification is per distinct
// source in the batch (§1.2.10) and runs BEFORE the transaction: the R2
// fetch is network I/O that must not hold a DB connection, and it is
// hard-capped at MAX_CANONICAL_BLOB_BYTES so one hostile blob can't
// exhaust the farm process's memory. NULL digest → 422 BLOB_MISSING, digest
// mismatch against the stored bytes → 422 BLOB_DIGEST_MISMATCH, blob over
// the cap → 422 BLOB_TOO_LARGE.

import type { SQL } from "bun";
import { sha256Hex } from "../auth/tokens";
import { authenticateClient } from "../auth/sessions";
import { transaction } from "../db";
import { errorResponse } from "../errors";
import {
  BlobTooLargeError,
  MAX_CANONICAL_BLOB_BYTES,
  type R2Client,
} from "../r2/client";
import type { RateLimits } from "../app";
import {
  isSourceKey,
  isUuid,
  isVideoId,
  type Label,
  provenanceProblem,
  type Provenance,
  readJsonObject,
  readLabels,
  readProvenance,
} from "./validate";

export interface ClipsDeps {
  sql: SQL;
  r2: R2Client;
  limits: RateLimits;
}

const notFound = () => errorResponse(404, "NOT_FOUND", "Not found");

// Per-user token bucket on POSTs (§7.2). Null when the request may proceed.
function rateLimit(deps: ClipsDeps, userId: string): Response | null {
  if (deps.limits.user.take(userId)) return null;
  return errorResponse(429, "RATE_LIMITED", "Too many requests", {
    headers: { "Retry-After": String(deps.limits.user.retryAfterSec(userId)) },
  });
}

const invalid = (message: string, details: Record<string, unknown> = {}) =>
  errorResponse(422, "VALIDATION_ERROR", message, { details });

interface ClipInput extends Provenance {
  clip_id: string;
  source_id: string;
  source_key: string;
  start_frame: number;
  end_frame: number;
  auto_detected: boolean;
  labels: Label[];
}

function readClipInput(
  raw: unknown,
  index: number,
): { clip?: ClipInput; error?: Response } {
  const fail = (field: string, message: string) =>
    ({ error: invalid(`clips[${index}].${field}: ${message}`, { index, field }) }) as const;
  if (typeof raw !== "object" || raw === null) return fail("", "must be an object");
  const c = raw as Record<string, unknown>;
  if (!isUuid(c.clip_id)) return fail("clip_id", "must be a uuid");
  if (!isVideoId(c.source_id)) return fail("source_id", "must be 64-char lowercase hex");
  if (!isSourceKey(c.source_key)) return fail("source_key", "must be 43-char base64url");
  if (!Number.isInteger(c.start_frame) || (c.start_frame as number) < 0) {
    return fail("start_frame", "must be an integer >= 0");
  }
  if (!Number.isInteger(c.end_frame) || (c.end_frame as number) <= (c.start_frame as number)) {
    return fail("end_frame", "must be an integer > start_frame");
  }
  if (typeof c.auto_detected !== "boolean") return fail("auto_detected", "must be a boolean");
  // `labels` is optional per clip and may be [] (clears the set).
  const labels = c.labels === undefined ? { labels: [] } : readLabels(c.labels);
  if ("error" in labels) return fail(`labels${labels.path}`, labels.error);
  const provenance = readProvenance(c);
  if ("error" in provenance) return fail(provenance.field, provenance.error);
  const problem = provenanceProblem(provenance.provenance, labels.labels);
  if (problem) return fail(problem.field, problem.error);
  return {
    clip: {
      clip_id: c.clip_id as string,
      source_id: c.source_id as string,
      source_key: c.source_key as string,
      start_frame: c.start_frame as number,
      end_frame: c.end_frame as number,
      auto_detected: c.auto_detected as boolean,
      ...provenance.provenance,
      labels: labels.labels,
    },
  };
}

function sha256HexBytes(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function replaceLabelSet(
  tx: SQL,
  clipId: string,
  labels: Label[],
  taxonomyVersion: number,
): Promise<void> {
  await tx`DELETE FROM labels WHERE clip_id = ${clipId}`;
  for (const { name, origin } of labels) {
    await tx`
      INSERT INTO labels (clip_id, trick_name, origin, taxonomy_version)
      VALUES (${clipId}, ${name}, ${origin}, ${taxonomyVersion})`;
  }
}

async function recordAttribution(tx: SQL, sourceId: string, userId: string): Promise<void> {
  await tx`
    INSERT INTO source_attribution (source_id, user_id)
    VALUES (${sourceId}, ${userId})
    ON CONFLICT (source_id) DO UPDATE SET
      user_id       = EXCLUDED.user_id,
      attributed_at = now()`;
}

// POST /api/clips — batch upsert clips + replace their label sets (§7.3).
export async function handlePostClips(req: Request, deps: ClipsDeps): Promise<Response> {
  const auth = await authenticateClient(req, deps);
  if (auth instanceof Response) return auth;
  const limited = rateLimit(deps, auth.userId);
  if (limited) return limited;

  const body = await readJsonObject(req);
  if (!Array.isArray(body?.clips)) return invalid("clips must be an array");
  const inputs: ClipInput[] = [];
  for (let i = 0; i < (body!.clips as unknown[]).length; i++) {
    const { clip, error } = readClipInput((body!.clips as unknown[])[i], i);
    if (error) return error;
    inputs.push(clip!);
  }

  // 1. Sources exist and keys match; existing clips stay on their source.
  //    Read-only and outside any transaction: step 3 fetches blob bytes over
  //    the network, and that I/O must not hold a DB connection.
  const sources = new Map<string, { frame_count: number; sha256: string | null; r2_key: string }>();
  for (const clip of inputs) {
    let s = sources.get(clip.source_id);
    if (!s) {
      const [row] = await deps.sql`
        SELECT frame_count, sha256, r2_key, source_key_hash FROM sources
        WHERE id = ${clip.source_id}`;
      if (!row || row.source_key_hash !== sha256Hex(clip.source_key)) {
        return notFound();
      }
      s = { frame_count: row.frame_count as number, sha256: row.sha256 as string | null, r2_key: row.r2_key as string };
      sources.set(clip.source_id, s);
    }
    const [existing] = await deps.sql`SELECT source_id FROM clips WHERE id = ${clip.clip_id}`;
    if (existing && existing.source_id !== clip.source_id) {
      return notFound();
    }
  }

  // 2. Frame windows are validated against the source's canonical count.
  for (let i = 0; i < inputs.length; i++) {
    const clip = inputs[i]!;
    const frameCount = sources.get(clip.source_id)!.frame_count;
    if (!(clip.start_frame < clip.end_frame && clip.end_frame <= frameCount)) {
      return errorResponse(422, "VALIDATION_ERROR", `clips[${i}]: end_frame must be > start_frame and <= source frame_count (${frameCount})`, {
        details: { index: i, field: "end_frame" },
      });
    }
  }

  // 3. Blob verification, once per distinct source (§1.2.10), still outside
  //    the transaction. The fetch is bounded at MAX_CANONICAL_BLOB_BYTES
  //    (POSE_FORMAT.md §8 sizing): a key-holding contributor can PUT an
  //    arbitrarily large blob to their presigned staging URL, so an
  //    unbounded buffer here would let one hostile blob exhaust the farm
  //    process's memory while holding a DB connection.
  for (const [sourceId, s] of sources) {
    if (s.sha256 === null) {
      return errorResponse(422, "BLOB_MISSING", `source ${sourceId}: blob not ingested yet`, { details: {} });
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await deps.r2.getBytes(s.r2_key);
    } catch (e) {
      if (e instanceof BlobTooLargeError) {
        return errorResponse(422, "BLOB_TOO_LARGE", `source ${sourceId}: blob exceeds ${MAX_CANONICAL_BLOB_BYTES} bytes`, { details: {} });
      }
      throw e;
    }
    if (bytes === null) {
      return errorResponse(422, "BLOB_MISSING", `source ${sourceId}: blob not found at ${s.r2_key}`, { details: {} });
    }
    if (sha256HexBytes(bytes) !== s.sha256) {
      return errorResponse(422, "BLOB_DIGEST_MISMATCH", `source ${sourceId}: stored blob digest mismatch`, { details: {} });
    }
  }

  // 4–6. All-or-nothing writes in one transaction. The source rows are
  //    re-read inside the transaction: the loads above race a concurrent
  //    source delete, so the row must still exist under the same key hash
  //    for the writes below to be valid.
  const out = await transaction(deps.sql, async (tx) => {
    for (const clip of inputs) {
      const [row] = await tx`
        SELECT frame_count FROM sources
        WHERE id = ${clip.source_id} AND source_key_hash = ${sha256Hex(clip.source_key)}`;
      if (!row) {
        return { status: 404 as const };
      }
      const [existing] = await tx`SELECT source_id FROM clips WHERE id = ${clip.clip_id}`;
      if (existing && existing.source_id !== clip.source_id) {
        return { status: 404 as const };
      }
    }

    // 4–5. Clip upserts (§4) + label-set replacement (§5).
    const [tax] = await tx`SELECT max(taxonomy_version) AS v FROM label_taxonomy`;
    const taxonomyVersion = tax.v as number;
    for (const clip of inputs) {
      // Bun binds a JS array as its comma-joined string, which Postgres can't read as
      // TEXT[]; JSON carries the names intact, commas included. Bound as text and cast by
      // Postgres: a parameter cast straight to jsonb, Bun JSON-encodes a second time.
      const suggestedNames = JSON.stringify(clip.suggested_names);
      await tx`
        INSERT INTO clips
          (id, source_id, start_frame, end_frame, auto_detected,
           proposal_model_version, suggested_names, suggestions_withheld, updated_at)
        VALUES (${clip.clip_id}, ${clip.source_id}, ${clip.start_frame}, ${clip.end_frame}, ${clip.auto_detected},
                ${clip.proposal_model_version},
                ARRAY(SELECT jsonb_array_elements_text(${suggestedNames}::text::jsonb)),
                ${clip.suggestions_withheld}, now())
        ON CONFLICT (id) DO UPDATE SET
          source_id              = EXCLUDED.source_id,
          start_frame            = EXCLUDED.start_frame,
          end_frame              = EXCLUDED.end_frame,
          auto_detected          = EXCLUDED.auto_detected,
          proposal_model_version = EXCLUDED.proposal_model_version,
          suggested_names        = EXCLUDED.suggested_names,
          suggestions_withheld   = EXCLUDED.suggestions_withheld,
          updated_at             = now()`;
      await replaceLabelSet(tx, clip.clip_id, clip.labels, taxonomyVersion);
    }

    // 6. Attribution for each distinct source (§4).
    for (const sourceId of sources.keys()) {
      await recordAttribution(tx, sourceId, auth.userId);
    }
    return {
      status: 200 as const,
      clips: inputs.map((c) => ({ clip_id: c.clip_id, labels: c.labels, taxonomy_version: taxonomyVersion })),
    };
  });

  if (out.status === 404) return notFound();
  return Response.json({ clips: out.clips });
}

// POST /api/clips/:id/labels — replace one clip's label set (§7.3).
export async function handlePostClipLabels(
  req: Request,
  deps: ClipsDeps,
  clipId: string,
): Promise<Response> {
  const auth = await authenticateClient(req, deps);
  if (auth instanceof Response) return auth;
  const limited = rateLimit(deps, auth.userId);
  if (limited) return limited;
  if (!isUuid(clipId)) return notFound();

  const body = await readJsonObject(req);
  if (!isSourceKey(body?.source_key)) return invalid("source_key must be 43-char base64url");
  const read = body!.labels === undefined ? { labels: [] } : readLabels(body!.labels);
  if ("error" in read) return invalid(`labels${read.path}: ${read.error}`, { field: `labels${read.path}` });
  const labels = read.labels;

  const out = await transaction(deps.sql, async (tx) => {
    const [clip] = await tx`
      SELECT c.id, c.source_id, c.proposal_model_version, c.suggested_names, c.suggestions_withheld FROM clips c
      JOIN sources s ON s.id = c.source_id
      WHERE c.id = ${clipId} AND s.source_key_hash = ${sha256Hex(body!.source_key as string)}`;
    if (!clip) return { status: 404 as const };
    // The labels answer to the provenance the clip was contributed with (§7.3).
    const problem = provenanceProblem(clip as unknown as Provenance, labels);
    if (problem) return { status: 422 as const, problem };
    const [tax] = await tx`SELECT max(taxonomy_version) AS v FROM label_taxonomy`;
    const taxonomyVersion = tax.v as number;
    await replaceLabelSet(tx, clipId, labels, taxonomyVersion);
    await recordAttribution(tx, clip.source_id as string, auth.userId);
    return { status: 200 as const, clip_id: clipId, labels, taxonomy_version: taxonomyVersion };
  });

  if (out.status === 404) return notFound();
  if (out.status === 422) return invalid(`${out.problem.field}: ${out.problem.error}`, { field: out.problem.field });
  return Response.json({ clip_id: out.clip_id, labels: out.labels, taxonomy_version: out.taxonomy_version });
}
