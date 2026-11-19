import { describe, expect, test } from "bun:test";
import {
  BodyTooLargeError,
  isSourceKey,
  isUuid,
  isVideoId,
  provenanceProblem,
  MAX_JSON_BODY_BYTES,
  readJsonObject,
  readLabels,
  readProvenance,
} from "./validate";

describe("request validators", () => {
  test("video ids are 64-char lowercase hex", () => {
    expect(isVideoId("a".repeat(64))).toBe(true);
    expect(isVideoId("A".repeat(64))).toBe(false);
    expect(isVideoId("a".repeat(63))).toBe(false);
    expect(isVideoId("g".repeat(64))).toBe(false);
    expect(isVideoId(42)).toBe(false);
  });

  test("source keys are 43-char base64url without padding", () => {
    expect(isSourceKey("a".repeat(43))).toBe(true);
    expect(isSourceKey("A-_".repeat(14) + "A")).toBe(true);
    expect(isSourceKey("a".repeat(44))).toBe(false);
    expect(isSourceKey("a".repeat(42) + "=")).toBe(false);
    expect(isSourceKey("a".repeat(42) + "+")).toBe(false);
  });

  test("clip ids are uuids", () => {
    expect(isUuid("123e4567-e89b-42d3-a456-426614174000")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
  });
});

const typed = (name: string) => ({ name, origin: "typed" as const });

describe("readLabels", () => {
  test("trims, drops blanks, collapses case-insensitive dupes", () => {
    expect(readLabels([typed(" cork "), typed("CORK"), typed(""), typed("   "), typed("gainer")])).toEqual({
      labels: [typed("CORK"), typed("gainer")],
    });
  });

  test("keeps the alphabetically-first casing per group, and its alphabetically-first origin", () => {
    // Mirrors DISTINCT ON (lower(trim(name))) ORDER BY lower(trim(name)),
    // trim(name), origin: "Cork" < "cork" in both C collation and UTF-16 order.
    expect(readLabels([typed("cork"), typed("Cork")])).toEqual({ labels: [typed("Cork")] });
    expect(
      readLabels([
        { name: "hook", origin: "vocabulary" },
        { name: "hook", origin: "model" },
        { name: "hook", origin: "typed" },
      ]),
    ).toEqual({ labels: [{ name: "hook", origin: "model" }] });
  });

  test("preserves first-seen order and each name's origin", () => {
    expect(
      readLabels([
        { name: "hook", origin: "vocabulary" },
        { name: "scoot", origin: "typed" },
        { name: "gainer", origin: "model" },
      ]),
    ).toEqual({
      labels: [
        { name: "hook", origin: "vocabulary" },
        { name: "scoot", origin: "typed" },
        { name: "gainer", origin: "model" },
      ],
    });
  });

  test("rejects what it can't read rather than dropping it", () => {
    expect(readLabels(["cork"])).toEqual({ path: "[0]", error: "must be an object with a string name" });
    expect(readLabels([typed("cork"), { name: "hook" }])).toEqual({
      path: "[1].origin",
      error: "must be one of typed, vocabulary, model",
    });
    expect(readLabels([{ name: "hook", origin: "guessed" }])).toMatchObject({ path: "[0].origin" });
    expect(readLabels("cork")).toMatchObject({ path: "" });
    expect(readLabels([])).toEqual({ labels: [] });
  });
});

describe("readProvenance", () => {
  test("defaults a heuristic or hand-made clip", () => {
    expect(readProvenance({})).toEqual({
      provenance: { proposal_model_version: null, suggested_names: [], suggestions_withheld: false },
    });
  });

  test("reads a model-proposed clip, trimming suggested names", () => {
    expect(
      readProvenance({
        proposal_model_version: "trick-v1.3",
        suggested_names: [" cork ", "", "gainer"],
        suggestions_withheld: true,
      }),
    ).toEqual({
      provenance: { proposal_model_version: "trick-v1.3", suggested_names: ["cork", "gainer"], suggestions_withheld: true },
    });
  });

  test("rejects malformed fields", () => {
    expect(readProvenance({ proposal_model_version: "" })).toMatchObject({ field: "proposal_model_version" });
    expect(readProvenance({ suggested_names: "cork" })).toMatchObject({ field: "suggested_names" });
    expect(readProvenance({ suggested_names: [1] })).toMatchObject({ field: "suggested_names" });
    expect(readProvenance({ suggestions_withheld: "no" })).toMatchObject({ field: "suggestions_withheld" });
  });
});

describe("provenanceProblem", () => {
  const none = { proposal_model_version: null, suggested_names: [], suggestions_withheld: false };
  const model = { proposal_model_version: "trick-v1.3", suggested_names: ["cork"], suggestions_withheld: false };
  const kept = [{ name: "cork", origin: "model" as const }];

  test("a heuristic clip may carry typed and vocabulary names", () => {
    expect(provenanceProblem(none, [{ name: "cork", origin: "vocabulary" }])).toBeNull();
  });

  test("suggestions, a blind sample, or a kept suggestion need the proposing model", () => {
    expect(provenanceProblem({ ...none, suggested_names: ["cork"] }, [])).toMatchObject({ field: "suggested_names" });
    expect(provenanceProblem({ ...none, suggestions_withheld: true }, [])).toMatchObject({
      field: "suggestions_withheld",
    });
    expect(provenanceProblem(none, kept)).toMatchObject({ field: "labels" });
    expect(provenanceProblem(model, kept)).toBeNull();
  });

  test("a blind sample showed nothing to keep", () => {
    expect(provenanceProblem({ ...model, suggestions_withheld: true }, kept)).toMatchObject({ field: "labels" });
  });
});

describe("readJsonObject", () => {
  const post = (body?: string) =>
    new Request("http://localhost/contrib", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  test("valid JSON object passes through", async () => {
    expect(await readJsonObject(post(JSON.stringify({ video_id: "a".repeat(64), n: 1 })))).toEqual({
      video_id: "a".repeat(64),
      n: 1,
    });
  });

  test("non-JSON body returns null", async () => {
    expect(await readJsonObject(post("not json {"))).toBeNull();
  });

  test("JSON array returns null", async () => {
    expect(await readJsonObject(post(JSON.stringify([1, 2])))).toBeNull();
  });

  test("JSON scalars return null", async () => {
    expect(await readJsonObject(post("42"))).toBeNull();
    expect(await readJsonObject(post(JSON.stringify("cork")))).toBeNull();
    expect(await readJsonObject(post("true"))).toBeNull();
    expect(await readJsonObject(post("null"))).toBeNull();
  });

  test("empty body returns null", async () => {
    expect(await readJsonObject(post())).toBeNull();
  });

  // A streamed body carries no content-length, so only the running count can stop it.
  const streamed = (chunks: string[], onPull: () => void = () => {}) => {
    let i = 0;
    return new Request("http://localhost/contrib", {
      method: "POST",
      body: new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
          onPull();
          if (i < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[i++]!));
          else controller.close();
        },
      }),
    });
  };

  test("a declared length over the cap throws before reading", async () => {
    const req = new Request("http://localhost/contrib", {
      method: "POST",
      headers: { "content-length": "11" },
      body: "{}",
    });
    const err = await readJsonObject(req, 10).catch((e) => e);
    expect(err).toBeInstanceOf(BodyTooLargeError);
    expect((err as BodyTooLargeError).maxBytes).toBe(10);
    expect(req.bodyUsed).toBe(false);
  });

  test("a streamed body throws once the bytes read pass the cap, and is read no further", async () => {
    let pulls = 0;
    const chunks = ['{"a":"', "x".repeat(8), "x".repeat(8), "x".repeat(8), '"}'];
    await expect(readJsonObject(streamed(chunks, () => pulls++), 16)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulls).toBeLessThan(chunks.length);
  });

  test("a body of exactly the cap is read", async () => {
    const body = JSON.stringify({ a: "x".repeat(10) });
    expect(await readJsonObject(post(body), body.length)).toEqual({ a: "x".repeat(10) });
  });

  test("defaults to MAX_JSON_BODY_BYTES", async () => {
    const at = JSON.stringify({ a: "x".repeat(MAX_JSON_BODY_BYTES - 8) });
    expect(at.length).toBe(MAX_JSON_BODY_BYTES);
    expect(await readJsonObject(post(at))).not.toBeNull();
    await expect(readJsonObject(post(`${at} `))).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  test("UTF-8 split across chunks decodes intact", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ name: "ñandú" }));
    const split = bytes.indexOf(0xc3) + 1; // inside the two-byte ñ
    let sent = 0;
    const req = new Request("http://localhost/contrib", {
      method: "POST",
      body: new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
          if (sent === 0) controller.enqueue(bytes.slice(0, split));
          else if (sent === 1) controller.enqueue(bytes.slice(split));
          else controller.close();
          sent++;
        },
      }),
    });
    expect(await readJsonObject(req)).toEqual({ name: "ñandú" });
  });
});
