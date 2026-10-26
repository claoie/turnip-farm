import { describe, expect, test } from "bun:test";
import {
  isSourceKey,
  isUuid,
  isVideoId,
  provenanceProblem,
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
