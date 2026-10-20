// Model registry (BACKEND_DESIGN.md §7.3; issue #10).
// validatePublishInput is pure; the POST handler's 401/422 paths run
// against a DB-throwing stub (validation precedes any DB touch); the
// publish/get round trips are DB-backed (rolled back per db/testing.ts)
// and run only when TEST_DATABASE_URL names a database.

import { SQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../db/testing";
import {
  handleGetModelsCurrent,
  handlePostModels,
  validatePublishInput,
  type ModelsDeps,
  type PublishInput,
} from "./models";
import type { R2Client } from "./r2/client";

const PIPELINE_KEY = ["pipeline", "key", "for", "tests"].join("-");
const AUTH = { authorization: `Bearer ${PIPELINE_KEY}` };

const throwingSql = (() => {
  throw new Error("database touched");
}) as unknown as SQL;

const stubR2: R2Client = {
  presignPut: () => {
    throw new Error("r2 put touched");
  },
  presignGet: (key: string) => ({ url: `https://r2.test/${key}?sig=x`, expiresAt: new Date() }),
  getBytes: () => {
    throw new Error("r2 get touched");
  },
  deleteObject: () => {
    throw new Error("r2 delete touched");
  },
};

const deps: ModelsDeps = { sql: throwingSql, pipelineKey: PIPELINE_KEY, r2: stubR2 };

const validBody = (): Record<string, unknown> => ({
  version: "trick-v1.2",
  taxonomy_version: 3,
  r2_key: "models/trick-v1.2.mlmodelc.zip",
  sha256: "a".repeat(64),
  byte_size: 48203110,
  min_client_version: "2.4.0",
  input_desc: { layout: "T×52" },
  output_desc: { segments: "source-frame coordinates" },
  holdout_report_r2_key: "reports/trick-v1.2-holdout.json",
  training_run_id: "run-20261006-01",
  val_metrics: { seg_map_05: 0.62 },
  name_metrics: { gainer: { precision: 0.9 } },
  training_source_ids: ["b".repeat(64)],
});

const postReq = (body: unknown, headers: Record<string, string> = AUTH) =>
  new Request("http://farm.test/api/models", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("validatePublishInput", () => {
  test("accepts the full §7.3 body", () => {
    const { input, error } = validatePublishInput(validBody());
    expect(error).toBeUndefined();
    expect(input!.version).toBe("trick-v1.2");
    expect(input!.taxonomyVersion).toBe(3);
    expect(input!.trainingSourceIds).toEqual(["b".repeat(64)]);
  });

  test("fills defaults for the optional fields", () => {
    const { input, error } = validatePublishInput({
      version: "trick-v1.0",
      taxonomy_version: 1,
      r2_key: "models/trick-v1.0.mlmodelc.zip",
      sha256: "c".repeat(64),
    });
    expect(error).toBeUndefined();
    const i = input as PublishInput;
    expect(i.byteSize).toBeNull();
    expect(i.minClientVersion).toBeNull();
    expect(i.inputDesc).toEqual({});
    expect(i.outputDesc).toEqual({});
    expect(i.holdoutReportR2Key).toBeNull();
    expect(i.trainingRunId).toBeNull();
    expect(i.valMetrics).toEqual({});
    expect(i.nameMetrics).toEqual({});
    expect(i.trainingSourceIds).toEqual([]);
  });

  test("dedupes training_source_ids", () => {
    const id = "d".repeat(64);
    const { input } = validatePublishInput({ ...validBody(), training_source_ids: [id, id] });
    expect(input!.trainingSourceIds).toEqual([id]);
  });

  test.each([
    ["non-object body", [1, 2], "body must be a JSON object"],
    ["missing version", { ...validBody(), version: undefined }, "version must be a non-empty string"],
    ["blank version", { ...validBody(), version: "  " }, "version must be a non-empty string"],
    [
      "zero taxonomy_version",
      { ...validBody(), taxonomy_version: 0 },
      "taxonomy_version must be a positive integer",
    ],
    [
      "fractional taxonomy_version",
      { ...validBody(), taxonomy_version: 1.5 },
      "taxonomy_version must be a positive integer",
    ],
    ["missing r2_key", { ...validBody(), r2_key: "" }, "r2_key must be a non-empty string"],
    ["short sha256", { ...validBody(), sha256: "abc" }, "sha256 must be a 64-char lowercase hex digest"],
    [
      "uppercase sha256",
      { ...validBody(), sha256: "A".repeat(64) },
      "sha256 must be a 64-char lowercase hex digest",
    ],
    [
      "negative byte_size",
      { ...validBody(), byte_size: -1 },
      "byte_size must be a non-negative integer when present",
    ],
    [
      "array val_metrics",
      { ...validBody(), val_metrics: [] },
      "val_metrics must be a JSON object when present",
    ],
    [
      "string name_metrics",
      { ...validBody(), name_metrics: "x" },
      "name_metrics must be a JSON object when present",
    ],
    [
      "bad source id",
      { ...validBody(), training_source_ids: ["nope"] },
      "training_source_ids must be 64-char lowercase hex source ids",
    ],
    [
      "non-array source ids",
      { ...validBody(), training_source_ids: "b".repeat(64) },
      "training_source_ids must be an array",
    ],
  ])("rejects %s", (_name, body, message) => {
    const { input, error } = validatePublishInput(body);
    expect(input).toBeUndefined();
    expect(error).toBe(message);
  });
});

describe("handlePostModels", () => {
  test("401 on a wrong pipeline key, before any DB touch", async () => {
    const res = await handlePostModels(postReq(validBody(), { authorization: "Bearer <redacted>" }), deps);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
  });

  test("401 with no authorization header", async () => {
    const res = await handlePostModels(postReq(validBody(), {}), deps);
    expect(res.status).toBe(401);
  });

  test("422 on an invalid body, before any DB touch", async () => {
    const res = await handlePostModels(postReq({ ...validBody(), sha256: "nope" }), deps);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("sha256");
  });

  test("422 on a non-JSON body", async () => {
    const res = await handlePostModels(
      new Request("http://farm.test/api/models", {
        method: "POST",
        headers: { "content-type": "application/json", ...AUTH },
        body: "not json",
      }),
      deps,
    );
    expect(res.status).toBe(422);
  });
});

describe("handleGetModelsCurrent", () => {
  // Dispatches on the query text: the current-model lookup vs the
  // vocabulary lookup.
  const stubSql = (modelRow: Record<string, unknown> | null, taxRows: unknown[]) =>
    (async (strings: TemplateStringsArray) => {
      const q = String(strings[0]);
      if (q.includes("FROM models")) return modelRow ? [modelRow] : [];
      return taxRows;
    }) as unknown as SQL;

  const get = (headers: Record<string, string> = {}) =>
    new Request("http://farm.test/api/models/current", { headers });

  const MODEL_ROW = {
    version: "trick-v1.2",
    model_type: "trick-detection",
    taxonomy_version: 3,
    r2_key: "models/trick-v1.2.mlmodelc.zip",
    sha256: "a".repeat(64),
    byte_size: "48203110",
    min_client_version: "2.4.0",
    input_desc: { layout: "T×52" },
    output_desc: { segments: "source-frame coordinates" },
    holdout_report_r2_key: "reports/trick-v1.2-holdout.json",
    training_run_id: "run-20261006-01",
    val_metrics: { seg_map_05: 0.62 },
    name_metrics: { gainer: { precision: 0.9 } },
    promoted_at: new Date("2026-10-06T06:00:00Z"),
  };

  const TAX_ROWS = [
    { raw: "cork", canonical: "cork", taxonomy_version: 3 },
    { raw: "corkscrew", canonical: "cork", taxonomy_version: 2 },
    { raw: "gainer", canonical: "gainer", taxonomy_version: 1 },
  ];

  test("404 NO_MODEL before the first promotion", async () => {
    const res = await handleGetModelsCurrent(get(), { ...deps, sql: stubSql(null, []) });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NO_MODEL");
  });

  test("200 with the §7.3 manifest shape, ETag and Cache-Control", async () => {
    const res = await handleGetModelsCurrent(get(), { ...deps, sql: stubSql(MODEL_ROW, TAX_ROWS) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.version).toBe("trick-v1.2");
    expect(body.model_type).toBe("trick-detection");
    expect(body.taxonomy_version).toBe(3);
    expect(body.r2_key).toBe("models/trick-v1.2.mlmodelc.zip");
    expect(body.url).toBe("https://r2.test/models/trick-v1.2.mlmodelc.zip?sig=x");
    expect(body.sha256).toBe("a".repeat(64));
    expect(body.byte_size).toBe(48203110);
    expect(body.min_client_version).toBe("2.4.0");
    expect(body.input_desc).toEqual({ layout: "T×52" });
    expect(body.val_metrics).toEqual({ seg_map_05: 0.62 });
    expect(body.name_metrics).toEqual({ gainer: { precision: 0.9 } });
    expect(body.vocabulary).toEqual([
      { canonical: "cork", aliases: ["cork", "corkscrew"] },
      { canonical: "gainer", aliases: ["gainer"] },
    ]);
    expect(body.promoted_at).toBe("2026-10-06T06:00:00.000Z");
    expect(res.headers.get("ETag")).toBe('"trick-v1.2"');
    expect(res.headers.get("Cache-Control")).toBe("max-age=300");
  });

  test("public: a session-bearing request is served, not tied to an account", async () => {
    const res = await handleGetModelsCurrent(get({ authorization: "Bearer <redacted>" }), {
      ...deps,
      sql: stubSql(MODEL_ROW, TAX_ROWS),
    });
    expect(res.status).toBe(200);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("model registry, DB-backed", () => {
  const sql = new SQL(TEST_DATABASE_URL ?? "");
  afterAll(() => sql.close());

  const SOURCE_ID = "e".repeat(64);

  test("publish -> current reflects the new version; re-publish is 409", async () => {
    await inRollback(sql, async (tx) => {
      const d: ModelsDeps = { sql: tx, pipelineKey: PIPELINE_KEY, r2: stubR2 };
      // One source the pipeline trained on; the other id is deleted
      // between the run and the publish and must be skipped (§1.2.20).
      await tx`
        INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, r2_key)
        VALUES (${SOURCE_ID}, ${"f".repeat(64)}, 600, 30, ${`poses/${SOURCE_ID}.tkp1.gz`})`;

      const res = await handlePostModels(
        postReq({ ...validBody(), training_source_ids: [SOURCE_ID, "0".repeat(64)] }),
        d,
      );
      expect(res.status).toBe(201);
      const created = (await res.json()) as Record<string, unknown>;
      expect(created.version).toBe("trick-v1.2");
      expect(typeof created.id).toBe("string");
      expect(typeof created.promoted_at).toBe("string");
      expect(created.training_sources_recorded).toBe(1);

      // The membership row landed for the live source only.
      const membership = await tx`
        SELECT source_id FROM model_training_sources WHERE model_version = 'trick-v1.2'`;
      expect(membership.map((r: { source_id: string }) => r.source_id)).toEqual([SOURCE_ID]);

      // Re-publishing the same version records nothing: 409.
      const again = await handlePostModels(postReq(validBody()), d);
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: { code: string } }).error.code).toBe("VERSION_EXISTS");

      // The manifest serves the new champion with the model's vocabulary.
      const current = await handleGetModelsCurrent(
        new Request("http://farm.test/api/models/current"),
        d,
      );
      expect(current.status).toBe(200);
      const manifest = (await current.json()) as Record<string, unknown>;
      expect(manifest.version).toBe("trick-v1.2");
      expect(Array.isArray(manifest.vocabulary)).toBe(true);
      expect((manifest.vocabulary as unknown[]).length).toBeGreaterThan(0);
      expect(current.headers.get("ETag")).toBe('"trick-v1.2"');
    });
  });

  test("publish with no training_source_ids records no membership", async () => {
    await inRollback(sql, async (tx) => {
      const d: ModelsDeps = { sql: tx, pipelineKey: PIPELINE_KEY, r2: stubR2 };
      const res = await handlePostModels(
        postReq({ ...validBody(), version: "trick-v1.3", training_source_ids: [] }),
        d,
      );
      expect(res.status).toBe(201);
      expect(((await res.json()) as Record<string, unknown>).training_sources_recorded).toBe(0);
    });
  });
});
