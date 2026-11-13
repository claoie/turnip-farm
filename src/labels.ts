// Vocabulary-only labels (BACKEND_DESIGN.md §1.2.25, §7.3).
// Clip writes accept only names in label_taxonomy (422 UNKNOWN_LABEL), so
// no free text reaches `labels`. A name the vocabulary lacks goes to
// POST /api/labels/candidates instead: kept for LABEL_CANDIDATE_TTL_DAYS,
// counted per account by an HMAC of the account id under a server key, and
// promoted into the taxonomy by the maintainer (scripts/promote-label.ts).

import type { SQL } from "bun";
import type { RateLimits } from "./app";
import { transaction } from "./db";
import { authenticateClient } from "./auth/sessions";
import { readJsonObject } from "./contrib/validate";
import { errorResponse } from "./errors";
import type { Output } from "./moderation";

/** Candidate names expire this long after an account first submits them (judgment call). */
export const LABEL_CANDIDATE_TTL_DAYS = 30;
/** Most names one POST /api/labels/candidates may carry. */
export const MAX_CANDIDATES_PER_REQUEST = 20;
/** Longest candidate name, in characters after trimming. */
export const MAX_CANDIDATE_LENGTH = 64;

/** The lowercase vocabulary: every raw string in label_taxonomy, at any version. */
export async function vocabulary(sql: SQL): Promise<Set<string>> {
  const rows = (await sql`SELECT DISTINCT lower(raw) AS raw FROM label_taxonomy`) as { raw: string }[];
  return new Set(rows.map((r) => r.raw));
}

/** The names, in order and without duplicates, that the vocabulary lacks (case-insensitive). */
export function unknownNames(vocab: Set<string>, names: readonly string[]): string[] {
  return [...new Set(names.filter((n) => !vocab.has(n.toLowerCase())))];
}

export function unknownLabelResponse(names: string[], details: Record<string, unknown> = {}): Response {
  return errorResponse(422, "UNKNOWN_LABEL", `Not in the vocabulary: ${names.join(", ")}`, {
    details: { ...details, field: "labels", names },
  });
}

/**
 * The HMAC key for candidate counts, derived from the 32-byte
 * APPLE_REFRESH_TOKEN_KEY with HKDF-SHA-256 under its own label, so the farm
 * needs no second secret and the two uses never share a key.
 */
export async function deriveCandidateKey(secret: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("turnip-farm label candidates v1"),
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

/** Lowercase hex HMAC-SHA-256 of the account id: the only account trace on a candidate. */
export async function candidateAccountHash(key: CryptoKey, userId: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(userId));
  return Buffer.from(mac).toString("hex");
}

export interface CandidatesDeps {
  sql: SQL;
  limits: RateLimits;
  candidateKey: CryptoKey;
}

// POST /api/labels/candidates {"names": [string]} → 202.
export async function handlePostLabelCandidates(req: Request, deps: CandidatesDeps): Promise<Response> {
  const auth = await authenticateClient(req, deps);
  if (auth instanceof Response) return auth;
  if (!deps.limits.user.take(auth.userId)) {
    return errorResponse(429, "RATE_LIMITED", "Too many requests", {
      headers: { "Retry-After": String(deps.limits.user.retryAfterSec(auth.userId)) },
    });
  }

  const body = await readJsonObject(req);
  const raw = body?.names;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_CANDIDATES_PER_REQUEST) {
    return errorResponse(422, "VALIDATION_ERROR", `names must be an array of 1 to ${MAX_CANDIDATES_PER_REQUEST} strings`, {
      details: { field: "names" },
    });
  }
  const names: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const name = typeof raw[i] === "string" ? (raw[i] as string).trim() : "";
    if (name === "" || name.length > MAX_CANDIDATE_LENGTH) {
      return errorResponse(422, "VALIDATION_ERROR", `names[${i}] must be a non-empty string of at most ${MAX_CANDIDATE_LENGTH} characters`, {
        details: { field: "names", index: i },
      });
    }
    names.push(name);
  }

  // A name already in the vocabulary needs no candidate.
  const fresh = unknownNames(await vocabulary(deps.sql), names);
  const accountHash = await candidateAccountHash(deps.candidateKey, auth.userId);
  for (const name of fresh) {
    await deps.sql`
      INSERT INTO label_candidates (name, account_hash)
      VALUES (${name}, ${accountHash})
      ON CONFLICT (lower(name), account_hash) DO NOTHING`;
  }
  return new Response(null, { status: 202 });
}

/** Deletes an account's candidate submissions (account deletion, §7.3). */
export async function deleteAccountCandidates(sql: SQL, key: CryptoKey, userId: string): Promise<void> {
  await sql`DELETE FROM label_candidates WHERE account_hash = ${await candidateAccountHash(key, userId)}`;
}

// scripts/label-candidates.ts [--min N]: the open candidates, most-submitted
// first, as "<accounts>  <name>". Exit status: 0, or 2 for usage.
export async function labelCandidatesCli(args: string[], sql: SQL, io: Output): Promise<number> {
  let min = 1;
  if (args.length === 2 && args[0] === "--min" && /^\d+$/.test(args[1]!)) min = Number(args[1]);
  else if (args.length !== 0) {
    io.err("usage: bun run labels:candidates [--min N]");
    return 2;
  }
  const rows = (await sql`
    SELECT min(name) AS name, count(DISTINCT account_hash)::int AS accounts
    FROM label_candidates
    GROUP BY lower(name)
    HAVING count(DISTINCT account_hash) >= ${min}
    ORDER BY accounts DESC, lower(name)`) as { name: string; accounts: number }[];
  for (const r of rows) io.out(`${String(r.accounts).padStart(5)}  ${r.name}`);
  if (rows.length === 0) io.err("No candidates.");
  return 0;
}

// scripts/promote-label.ts <name> [<canonical>]: adds the name to the
// taxonomy at a new version (canonical defaults to the name itself) and
// drops its candidates. Exit status: 0 promoted, 1 already in the
// vocabulary, 2 usage.
export async function promoteLabelCli(args: string[], sql: SQL, io: Output): Promise<number> {
  const [rawArg, canonicalArg] = args;
  const raw = rawArg?.trim().toLowerCase() ?? "";
  const canonical = (canonicalArg ?? rawArg ?? "").trim().toLowerCase();
  if (args.length < 1 || args.length > 2 || raw === "" || canonical === "" || raw.length > MAX_CANDIDATE_LENGTH) {
    io.err("usage: bun run labels:promote <name> [<canonical>]");
    return 2;
  }
  return transaction(sql, async (tx) => {
    if ((await vocabulary(tx)).has(raw)) {
      io.err(`"${raw}" is already in the vocabulary.`);
      return 1;
    }
    // Serialize version bumps: two promotions must not both claim max + 1.
    await tx`LOCK TABLE label_taxonomy IN SHARE ROW EXCLUSIVE MODE`;
    const [{ version }] = await tx`SELECT max(taxonomy_version) + 1 AS version FROM label_taxonomy`;
    await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES (${raw}, ${canonical}, ${version})`;
    const dropped = await tx`DELETE FROM label_candidates WHERE lower(name) = ${raw} RETURNING 1`;
    io.out(`Promoted "${raw}" → "${canonical}" at taxonomy version ${version}; ${dropped.length} candidate rows dropped.`);
    return 0;
  });
}
