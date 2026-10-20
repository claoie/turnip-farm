// Model registry (BACKEND_DESIGN.md §7.3; issue #10).
//
// POST /api/models — the training pipeline publishes a new champion
// (service-key auth, never a user session, §1.2.7). The model insert and
// the training-source membership land in one transaction; an existing
// version is a 409 VERSION_EXISTS with nothing recorded, because a
// version is immutable once published (§4).
//
// GET /api/models/current — the public trick-model manifest: the current
// champion's artifact pointer, descriptors, metrics, and the vocabulary
// the model trained on. Public like GET /api/taxonomy/current (§1.2.19):
// no session, per-IP rate limited in startServer's fetch wrapper, an ETag
// of the model version, Cache-Control: max-age=300. 404 NO_MODEL before
// the first promotion.

import { errorResponse } from "./errors";
import { transaction } from "./db";
import { authenticatePipeline, type PipelineDeps } from "./pipeline";
import { isVideoId, readJsonObject } from "./contrib/validate";
import type { R2Client } from "./r2/client";
import { buildVocabulary } from "./taxonomy";

export interface ModelsDeps extends PipelineDeps {
  r2: R2Client;
}

const invalid = (message: string, details: Record<string, unknown> = {}) =>
  errorResponse(422, "VALIDATION_ERROR", message, { details });

const MAX_VERSION_LEN = 200;
const MAX_KEY_LEN = 1024;
const MAX_CLIENT_VERSION_LEN = 50;
const MAX_REPORT_KEY_LEN = 1024;
const MAX_RUN_ID_LEN = 200;
const MAX_SOURCE_IDS = 100000;

export interface PublishInput {
  version: string;
  taxonomyVersion: number;
  r2Key: string;
  sha256: string;
  byteSize: number | null;
  minClientVersion: string | null;
  inputDesc: Record<string, unknown>;
  outputDesc: Record<string, unknown>;
  holdoutReportR2Key: string | null;
  trainingRunId: string | null;
  valMetrics: Record<string, unknown>;
  nameMetrics: Record<string, unknown>;
  trainingSourceIds: string[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isOptionalString = (v: unknown, maxLen: number): v is string | undefined =>
  v === undefined || (typeof v === "string" && v.length <= maxLen);

/** Pure validation for the publish body; the handler maps `error` to 422. */
export function validatePublishInput(body: unknown): {
  input?: PublishInput;
  error?: string;
} {
  if (!isPlainObject(body)) return { error: "body must be a JSON object" };
  const {
    version,
    taxonomy_version: taxonomyVersion,
    r2_key: r2Key,
    sha256,
    byte_size: byteSize,
    min_client_version: minClientVersion,
    input_desc: inputDesc,
    output_desc: outputDesc,
    holdout_report_r2_key: holdoutReportR2Key,
    training_run_id: trainingRunId,
    val_metrics: valMetrics,
    name_metrics: nameMetrics,
    training_source_ids: trainingSourceIds,
  } = body;

  if (typeof version !== "string" || version.trim() === "" || version.length > MAX_VERSION_LEN) {
    return { error: "version must be a non-empty string" };
  }
  if (!Number.isInteger(taxonomyVersion) || (taxonomyVersion as number) < 1) {
    return { error: "taxonomy_version must be a positive integer" };
  }
  if (typeof r2Key !== "string" || r2Key === "" || r2Key.length > MAX_KEY_LEN) {
    return { error: "r2_key must be a non-empty string" };
  }
  if (!isVideoId(sha256)) {
    return { error: "sha256 must be a 64-char lowercase hex digest" };
  }
  if (
    byteSize !== undefined &&
    (!Number.isSafeInteger(byteSize) || (byteSize as number) < 0)
  ) {
    return { error: "byte_size must be a non-negative integer when present" };
  }
  if (!isOptionalString(minClientVersion, MAX_CLIENT_VERSION_LEN)) {
    return { error: "min_client_version must be a string when present" };
  }
  for (const [name, value] of [
    ["input_desc", inputDesc],
    ["output_desc", outputDesc],
    ["val_metrics", valMetrics],
    ["name_metrics", nameMetrics],
  ] as const) {
    if (value !== undefined && !isPlainObject(value)) {
      return { error: `${name} must be a JSON object when present` };
    }
  }
  if (!isOptionalString(holdoutReportR2Key, MAX_REPORT_KEY_LEN)) {
    return { error: "holdout_report_r2_key must be a string when present" };
  }
  if (!isOptionalString(trainingRunId, MAX_RUN_ID_LEN)) {
    return { error: "training_run_id must be a string when present" };
  }
  let sourceIds: string[] = [];
  if (trainingSourceIds !== undefined) {
    if (!Array.isArray(trainingSourceIds) || trainingSourceIds.length > MAX_SOURCE_IDS) {
      return { error: "training_source_ids must be an array" };
    }
    for (const id of trainingSourceIds) {
      if (!isVideoId(id)) {
        return { error: "training_source_ids must be 64-char lowercase hex source ids" };
      }
    }
    sourceIds = [...new Set(trainingSourceIds as string[])];
  }

  return {
    input: {
      version,
      taxonomyVersion: taxonomyVersion as number,
      r2Key,
      sha256: sha256 as string,
      byteSize: byteSize === undefined ? null : (byteSize as number),
      minClientVersion: (minClientVersion as string | undefined) ?? null,
      inputDesc: (inputDesc as Record<string, unknown> | undefined) ?? {},
      outputDesc: (outputDesc as Record<string, unknown> | undefined) ?? {},
      holdoutReportR2Key: (holdoutReportR2Key as string | undefined) ?? null,
      trainingRunId: (trainingRunId as string | undefined) ?? null,
      valMetrics: (valMetrics as Record<string, unknown> | undefined) ?? {},
      nameMetrics: (nameMetrics as Record<string, unknown> | undefined) ?? {},
      trainingSourceIds: sourceIds,
    },
  };
}

// POST /api/models — pipeline publishes the champion (service key).
export async function handlePostModels(req: Request, deps: ModelsDeps): Promise<Response> {
  const authed = authenticatePipeline(req, deps.pipelineKey);
  if (authed) return authed;
  const { input, error } = validatePublishInput(await readJsonObject(req));
  if (error || !input) return invalid(error ?? "invalid body");

  const published = await transaction(deps.sql, async (tx) => {
    // A published version is immutable (§4): the unique version is the
    // conflict target, and a re-publish records nothing — not even the
    // training sources (§7.3).
    const [row] = await tx`
      INSERT INTO models (
        version, taxonomy_version, r2_key, sha256, byte_size,
        min_client_version, input_desc, output_desc,
        holdout_report_r2_key, training_run_id,
        val_metrics, name_metrics, promoted_at
      ) VALUES (
        ${input.version}, ${input.taxonomyVersion}, ${input.r2Key}, ${input.sha256},
        ${input.byteSize}, ${input.minClientVersion},
        ${JSON.stringify(input.inputDesc)}::jsonb, ${JSON.stringify(input.outputDesc)}::jsonb,
        ${input.holdoutReportR2Key}, ${input.trainingRunId},
        ${JSON.stringify(input.valMetrics)}::jsonb, ${JSON.stringify(input.nameMetrics)}::jsonb,
        now()
      )
      ON CONFLICT (version) DO NOTHING
      RETURNING id, promoted_at`;
    if (!row) return null;
    // §1.2.20: ids of sources deleted between the training run and the
    // publish match no row and are skipped, not rejected (§4's shape).
    // Bun's SQL driver serializes a JS array as bare comma-joined text, so
    // interpolating the array directly is not a valid Postgres array literal
    // ("malformed array literal" 500s every publish). The literal is built in
    // JS instead: every id here passed isVideoId (64-char lowercase hex) in
    // validatePublishInput, so the joined literal cannot inject.
    const idLiteral = `{${input.trainingSourceIds.join(",")}}`;
    const recorded = await tx`
      INSERT INTO model_training_sources (model_version, source_id)
      SELECT ${input.version}, s.id FROM sources s
      WHERE s.id = ANY(${idLiteral}::char(64)[])
      ON CONFLICT DO NOTHING
      RETURNING source_id`;
    return {
      id: row.id as string,
      promotedAt: row.promoted_at as Date,
      recorded: (recorded as unknown[]).length,
    };
  });

  if (!published) {
    return errorResponse(409, "VERSION_EXISTS", "version is already published; bump the version instead");
  }
  return Response.json(
    {
      id: published.id,
      version: input.version,
      promoted_at: published.promotedAt.toISOString(),
      training_sources_recorded: published.recorded,
    },
    { status: 201 },
  );
}

// GET /api/models/current — the current champion's manifest.
export async function handleGetModelsCurrent(req: Request, deps: ModelsDeps): Promise<Response> {
  // The current model is the row with the greatest non-null promoted_at
  // (§4). The endpoint is public: no auth, no session (§1.2.19).
  const [model] = await deps.sql`
    SELECT version, model_type, taxonomy_version, r2_key, sha256, byte_size,
           min_client_version, input_desc, output_desc, holdout_report_r2_key,
           training_run_id, val_metrics, name_metrics, promoted_at
    FROM models
    WHERE promoted_at IS NOT NULL
    ORDER BY promoted_at DESC
    LIMIT 1`;
  if (!model) return errorResponse(404, "NO_MODEL", "no model has been promoted yet");
  const m = model as Record<string, unknown>;

  // The vocabulary the model trained on: each raw resolves through its
  // greatest mapping at or below the model's taxonomy_version — the same
  // buildVocabulary assembly as GET /api/taxonomy/current (§7.3), scoped
  // to the model's version rather than the farm's current one.
  const rows = (await deps.sql`
    SELECT raw, canonical, taxonomy_version
    FROM (
      SELECT DISTINCT ON (raw) raw, canonical, taxonomy_version
      FROM label_taxonomy
      WHERE taxonomy_version <= ${m.taxonomy_version as number}
      ORDER BY raw, taxonomy_version DESC
    ) AS resolved
    ORDER BY raw ASC`) as { raw: string; canonical: string; taxonomy_version: number }[];

  const { url } = deps.r2.presignGet(m.r2_key as string);
  return Response.json(
    {
      version: m.version,
      model_type: m.model_type,
      taxonomy_version: m.taxonomy_version,
      r2_key: m.r2_key,
      url,
      sha256: m.sha256,
      byte_size: m.byte_size == null ? null : Number(m.byte_size),
      min_client_version: m.min_client_version,
      input_desc: m.input_desc,
      output_desc: m.output_desc,
      holdout_report_r2_key: m.holdout_report_r2_key,
      training_run_id: m.training_run_id,
      val_metrics: m.val_metrics,
      name_metrics: m.name_metrics,
      vocabulary: buildVocabulary(rows),
      promoted_at: (m.promoted_at as Date).toISOString(),
    },
    { headers: { ETag: `"${m.version}"`, "Cache-Control": "max-age=300" } },
  );
}
