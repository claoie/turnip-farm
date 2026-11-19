// Request validation for the contribution endpoints (BACKEND_DESIGN.md
// §7.2, §7.3). Pure functions, unit-tested; handlers map `null` results to
// 422 VALIDATION_ERROR (or 404 for key-shaped-but-wrong ownership proofs,
// per the §7.2 ownership-privacy rule).

// Deterministic video_id: 64-char lowercase hex (master plan §1).
export const VIDEO_ID_RE = /^[0-9a-f]{64}$/;
// Source key: 32 random bytes, base64url without padding (§7.2).
export const SOURCE_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isVideoId = (s: unknown): s is string =>
  typeof s === "string" && VIDEO_ID_RE.test(s);

export const isSourceKey = (s: unknown): s is string =>
  typeof s === "string" && SOURCE_KEY_RE.test(s);

export const isUuid = (s: unknown): s is string =>
  typeof s === "string" && UUID_RE.test(s);

/**
 * The largest request body a route reads unless it names its own cap. A
 * parsed body costs many times its size (each 3-byte `{},` is a whole
 * object), so a cap follows what clients send, not the memory left over.
 */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

/** Thrown by readJsonObject past the route's cap; the app answers 422 VALIDATION_ERROR. */
export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Parses a JSON object body of at most `maxBytes`; null when the body is
 * not a JSON object. The body is read as it arrives and abandoned at the
 * cap, so an oversized one is never held whole.
 */
export async function readJsonObject(
  req: Request,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown> | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) throw new BodyTooLargeError(maxBytes);
  let body: unknown;
  try {
    let text = "";
    if (req.body) {
      const decoder = new TextDecoder();
      let total = 0;
      for await (const chunk of req.body) {
        total += chunk.byteLength;
        if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
        text += decoder.decode(chunk, { stream: true });
      }
      text += decoder.decode();
    }
    body = JSON.parse(text);
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw err;
    return null;
  }
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/**
 * Label-name whitespace, shared with the app and the export SQL
 * (BACKEND_DESIGN.md §1.2.25): ASCII only, space plus \t \n \v \f \r.
 * Any other character, a no-break space included, is part of the name.
 */
export const ASCII_WHITESPACE_RUN = /[ \t\n\v\f\r]+/g;

/** Trims ASCII whitespace only (String.prototype.trim also strips Unicode spaces). */
export function trimAsciiWhitespace(s: string): string {
  return s.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");
}

// How a name was given (§1.2.18): typed by hand, picked from the vocabulary, or
// kept from the trick model's pre-fill.
export const LABEL_ORIGINS = ["typed", "vocabulary", "model"] as const;
export type LabelOrigin = (typeof LABEL_ORIGINS)[number];

export interface Label {
  name: string;
  origin: LabelOrigin;
}

const isOrigin = (s: unknown): s is LabelOrigin =>
  typeof s === "string" && (LABEL_ORIGINS as readonly string[]).includes(s);

/**
 * Reads a label set as §7.3 sends it — `[{"name": "cork", "origin": "vocabulary"}]` —
 * and dedupes it per §5: trim, drop blanks, collapse case-insensitive duplicates
 * keeping the alphabetically-first casing per group and, for that casing, the
 * alphabetically-first origin (mirrors DISTINCT ON (lower(trim(name))) ... ORDER BY
 * lower(trim(name)), trim(name), origin). Order is first-seen, so the response
 * echoes the client's submission order. An entry that isn't a `{name, origin}`
 * object is an error, never skipped: dropping it would answer 200 for a label the
 * farm didn't keep.
 */
export function readLabels(raw: unknown): { labels: Label[] } | { path: string; error: string } {
  if (!Array.isArray(raw)) return { path: "", error: "must be an array of {name, origin} objects" };
  const groups = new Map<string, Label & { order: number }>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as Record<string, unknown> | null;
    if (typeof entry !== "object" || entry === null || typeof entry.name !== "string") {
      return { path: `[${i}]`, error: "must be an object with a string name" };
    }
    if (!isOrigin(entry.origin)) return { path: `[${i}].origin`, error: `must be one of ${LABEL_ORIGINS.join(", ")}` };
    const name = trimAsciiWhitespace(entry.name);
    if (name === "") continue;
    const key = name.toLowerCase();
    const cur = groups.get(key);
    const candidate = { name, origin: entry.origin, order: cur?.order ?? groups.size };
    if (
      cur === undefined ||
      name < cur.name ||
      (name === cur.name && entry.origin < cur.origin)
    ) {
      groups.set(key, candidate);
    }
  }
  return {
    labels: [...groups.values()]
      .sort((a, b) => a.order - b.order)
      .map(({ name, origin }) => ({ name, origin })),
  };
}

// A clip's provenance (§1.2.18), with the §7.3 defaults for a heuristic or hand-made clip.
export interface Provenance {
  proposal_model_version: string | null;
  suggested_names: string[];
  suggestions_withheld: boolean;
}

/** Reads the provenance fields of a §7.3 clip; each is optional and defaults as documented. */
export function readProvenance(c: Record<string, unknown>): { provenance: Provenance } | { field: string; error: string } {
  const version = c.proposal_model_version ?? null;
  if (version !== null && (typeof version !== "string" || version.trim() === "")) {
    return { field: "proposal_model_version", error: "must be a non-empty string or null" };
  }
  const names = c.suggested_names ?? [];
  if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) {
    return { field: "suggested_names", error: "must be an array of strings" };
  }
  const withheld = c.suggestions_withheld ?? false;
  if (typeof withheld !== "boolean") return { field: "suggestions_withheld", error: "must be a boolean" };
  return {
    provenance: {
      proposal_model_version: version,
      suggested_names: (names as string[]).map((n) => n.trim()).filter((n) => n !== ""),
      suggestions_withheld: withheld,
    },
  };
}

/**
 * The §7.3 consistency rules between a clip's provenance and its labels: suggested
 * names, a blind sample, or a label kept from the model all need the model that
 * proposed the clip, and a blind sample showed no names to keep. Null when consistent.
 */
export function provenanceProblem(p: Provenance, labels: Label[]): { field: string; error: string } | null {
  const fromModel = labels.some((l) => l.origin === "model");
  if (p.proposal_model_version === null) {
    if (p.suggested_names.length > 0) return { field: "suggested_names", error: "needs a proposal_model_version" };
    if (p.suggestions_withheld) return { field: "suggestions_withheld", error: "needs a proposal_model_version" };
    if (fromModel) return { field: "labels", error: "origin \"model\" needs a proposal_model_version" };
  }
  if (p.suggestions_withheld && fromModel) {
    return { field: "labels", error: "origin \"model\" is impossible on a clip whose suggestions were withheld" };
  }
  return null;
}
