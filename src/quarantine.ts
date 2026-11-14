// Anti-poisoning quarantine (BACKEND_DESIGN.md §3, §6; TRAINING_DESIGN.md
// §7; issue #19).
//
// POST /api/quarantine — the pipeline reports the sources a regressing
// nightly run ingested: {source_ids, segment_ids, reason, metrics}. The
// pipeline trains on segments (BACKEND_DESIGN.md §1.2.24) and knows only
// their ids, so segment_ids resolve through segment_sources to the sources
// they are still linked to; the response reports those as counts, never
// source ids, so it doesn't hand the pipeline the segment-to-source link. Ids that already
// have an open quarantine are a no-op (the data_quarantine_open_uniq
// partial index enforces one open row per source), so resubmission is
// safe. The id list comes from a since=<watermark> export pull the
// pipeline takes after the dataset pull — the farm doesn't know the
// pipeline's watermark, so a farm-side time window would disagree with
// the Discord alert (maintainer decision 2026-10-14 on #19).
//
// POST /api/quarantine/:source_id/release — the maintainer's review queue
// marks a row released: the source rejoins the export on the next pull.
// POST /api/quarantine/:source_id/purge — marks it purged AND hard-deletes
// the source row (cascades to clips/labels; the R2 blob is deleted too,
// §1.2.3), so poisoned data is gone entirely rather than merely excluded.

import { errorResponse } from "./errors";
import { transaction } from "./db";
import { authenticatePipeline, type PipelineDeps } from "./pipeline";
import { isUuid, isVideoId, readJsonObject } from "./contrib/validate";
import type { R2Client } from "./r2/client";
import { stagingKeyFor } from "./r2/keys";
import { deleteLinkedSegmentRows, linkedSegmentKeys } from "./ingest/segmenter";
import { deleteSegmentBlobsAfterCommit } from "./contrib/sources";

export interface QuarantineDeps extends PipelineDeps {
  r2: R2Client;
}

const MAX_SOURCE_IDS = 10000;
const MAX_SEGMENT_IDS = 10000;
const MAX_REASON_LEN = 1000;

const notFound = () => errorResponse(404, "NOT_FOUND", "Not found");
const invalid = (message: string, details: Record<string, unknown> = {}) =>
  errorResponse(422, "VALIDATION_ERROR", message, { details });

interface QuarantineInput {
  sourceIds: string[];
  segmentIds: string[];
  reason: string;
  metrics: Record<string, unknown> | null;
}

async function readQuarantineInput(req: Request): Promise<{ input?: QuarantineInput; error?: Response }> {
  const body = await readJsonObject(req);
  if (!body) return { error: invalid("body must be a JSON object") };
  const { source_ids = [], segment_ids = [], reason, metrics } = body;

  if (!Array.isArray(source_ids) || source_ids.length > MAX_SOURCE_IDS) {
    return { error: invalid("source_ids must be an array", { max: MAX_SOURCE_IDS }) };
  }
  if (!Array.isArray(segment_ids) || segment_ids.length > MAX_SEGMENT_IDS) {
    return { error: invalid("segment_ids must be an array", { max: MAX_SEGMENT_IDS }) };
  }
  if (source_ids.length === 0 && segment_ids.length === 0) {
    return { error: invalid("source_ids or segment_ids must be a non-empty array") };
  }
  const seen = new Set<string>();
  for (const id of source_ids) {
    if (!isVideoId(id)) return { error: invalid("source_ids must be 64-char lowercase hex video ids", { id }) };
    seen.add(id);
  }
  const segments = new Set<string>();
  for (const id of segment_ids) {
    if (!isUuid(id)) return { error: invalid("segment_ids must be segment uuids", { id }) };
    segments.add((id as string).toLowerCase());
  }
  if (typeof reason !== "string" || reason.trim() === "" || reason.length > MAX_REASON_LEN) {
    return { error: invalid("reason must be a non-empty string", { maxLength: MAX_REASON_LEN }) };
  }
  if (metrics !== undefined && metrics !== null && (typeof metrics !== "object" || Array.isArray(metrics))) {
    return { error: invalid("metrics must be a JSON object or null") };
  }
  return {
    input: {
      sourceIds: [...seen],
      segmentIds: [...segments],
      reason: reason.trim(),
      metrics: (metrics ?? null) as Record<string, unknown> | null,
    },
  };
}

export async function handlePostQuarantine(req: Request, deps: QuarantineDeps): Promise<Response> {
  const authed = authenticatePipeline(req, deps.pipelineKey);
  if (authed) return authed;
  const { input, error } = await readQuarantineInput(req);
  if (error) return error;

  const metricsJson = JSON.stringify(input!.metrics);
  const result = await transaction(deps.sql, async (tx) => {
    const quarantined: string[] = [];
    const alreadyOpen: string[] = [];
    const unknown: string[] = [];
    for (const id of input!.sourceIds) {
      const [source] = await tx`SELECT id FROM sources WHERE id = ${id}`;
      if (!source) {
        // Reported, not fatal: a source can be owner-deleted between the
        // pipeline's export pull and this call, and quarantining a deleted
        // source is meaningless.
        unknown.push(id);
        continue;
      }
      const inserted = await tx`
        INSERT INTO data_quarantine (source_id, reason, metrics)
        VALUES (${id}, ${input!.reason}, ${metricsJson}::text::jsonb)
        ON CONFLICT (source_id) WHERE resolved_at IS NULL DO NOTHING
        RETURNING id`;
      if (inserted.length > 0) quarantined.push(id);
      else alreadyOpen.push(id);
    }

    // Segment ids, set-based: one count and one insert however long the
    // list. Every id passed isUuid, so the array literal cannot inject
    // (Bun doesn't bind a JS array as a Postgres array).
    const segmentLiteral = `{${input!.segmentIds.join(",")}}`;
    const [linked] = await tx`
      SELECT count(*)::int AS segments, count(DISTINCT source_id)::int AS sources
      FROM segment_sources
      WHERE segment_id = ANY(${segmentLiteral}::uuid[])`;
    const fresh = await tx`
      INSERT INTO data_quarantine (source_id, reason, metrics)
      SELECT DISTINCT source_id, ${input!.reason}, ${metricsJson}::text::jsonb
      FROM segment_sources
      WHERE segment_id = ANY(${segmentLiteral}::uuid[])
      ON CONFLICT (source_id) WHERE resolved_at IS NULL DO NOTHING
      RETURNING source_id`;
    const segments = {
      // Sources the segments resolved to, newly quarantined or already open.
      sources_quarantined: fresh.length,
      sources_already_open: (linked.sources as number) - fresh.length,
      // De-linked (their account was deleted) or no longer existing (re-cut
      // or deleted since the pull): nothing left to quarantine.
      unlinked: input!.segmentIds.length - (linked.segments as number),
    };
    return { quarantined, already_open: alreadyOpen, unknown, segments };
  });
  return Response.json(result);
}

export async function handleReleaseQuarantine(
  req: Request,
  deps: QuarantineDeps,
  sourceId: string,
): Promise<Response> {
  const authed = authenticatePipeline(req, deps.pipelineKey);
  if (authed) return authed;
  if (!isVideoId(sourceId)) return notFound();
  const [row] = await deps.sql`
    UPDATE data_quarantine
    SET resolved_at = now(), resolution = 'released'
    WHERE source_id = ${sourceId} AND resolved_at IS NULL
    RETURNING id`;
  if (!row) return notFound();
  return Response.json({ source_id: sourceId, resolution: "released" });
}

export async function handlePurgeQuarantine(
  req: Request,
  deps: QuarantineDeps,
  sourceId: string,
): Promise<Response> {
  const authed = authenticatePipeline(req, deps.pipelineKey);
  if (authed) return authed;
  if (!isVideoId(sourceId)) return notFound();
  const [quarantine] = await deps.sql`
    SELECT id FROM data_quarantine WHERE source_id = ${sourceId} AND resolved_at IS NULL`;
  if (!quarantine) return notFound();
  const [source] = await deps.sql`SELECT r2_key FROM sources WHERE id = ${sourceId}`;
  if (!source) return notFound();

  // R2 first, then the row (the DELETE /api/sources/:id order): if either
  // delete throws, the source row survives so the call can be retried.
  // Poisoned data leaves training, so its linked segments go too (§1.2.24).
  const segmentKeys = await linkedSegmentKeys(deps.sql, sourceId);
  try {
    await deps.r2.deleteObject(source.r2_key as string);
    await deps.r2.deleteObject(stagingKeyFor(sourceId));
    for (const key of segmentKeys) await deps.r2.deleteObject(key);
  } catch {
    return errorResponse(500, "INTERNAL", "Could not delete the stored blob; retry later");
  }
  const lateKeys = await transaction(deps.sql, async (tx) => {
    const keys = await deleteLinkedSegmentRows(tx, sourceId);
    // The purge transition, then the hard delete (§1.2.3): the source row
    // is gone entirely, and the quarantine row cascades with it — a purged
    // source has nothing left to exclude.
    await tx`
      UPDATE data_quarantine
      SET resolved_at = now(), resolution = 'purged'
      WHERE source_id = ${sourceId} AND resolved_at IS NULL`;
    await tx`DELETE FROM sources WHERE id = ${sourceId}`;
    return keys.filter((k) => !segmentKeys.includes(k));
  });
  await deleteSegmentBlobsAfterCommit(deps.r2, lateKeys);
  return new Response(null, { status: 204 });
}
