import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import type { BlobStore } from "./ingest/store";
import { canonicalKeyFor, ingestStagedSource, type SourceStore } from "./ingest/worker";
import { handlePostModels } from "./models";
import type { R2Client } from "./r2/client";

// Test-only stand-in, not a secret.
const PIPELINE_KEY = ["pipeline", "key", "for", "tests"].join("-");
const ID = "a".repeat(64);

describe("heavyJobs", () => {
  test("a model publish waits while an ingest runs, then proceeds", async () => {
    let release!: () => void;
    const staged = new Promise<void>((resolve) => (release = resolve));
    const store: BlobStore = {
      async get() {
        await staged;
        return null;
      },
      async put() {},
      async delete() {},
      async *listPages() {},
    };
    const sources: SourceStore = {
      async get(id) {
        return { id, r2_key: canonicalKeyFor(id) };
      },
      async setSha256() {},
    };
    const ingesting = ingestStagedSource({ store, sources }, ID);

    let answered = false;
    const publishing = handlePostModels(
      new Request("http://farm.test/api/models", {
        method: "POST",
        headers: { authorization: `Bearer ${PIPELINE_KEY}` },
        body: "{}",
      }),
      { sql: undefined as unknown as SQL, pipelineKey: PIPELINE_KEY, r2: undefined as unknown as R2Client },
    ).finally(() => (answered = true));
    await Bun.sleep(30);
    expect(answered).toBe(false);

    release();
    expect(await ingesting).toEqual({ status: "nothing-staged" });
    // The body is read only once the slot is free; an empty one is refused.
    expect((await publishing).status).toBe(422);
  });
});
