// Account deletion (BACKEND_DESIGN.md §7.3 `DELETE /api/account`), and the
// idle-account job that runs the same steps (§1.2.17).
//
// App Review guideline 5.1.1(v): the endpoint revokes Apple's refresh
// token, deletes every source attributed to the account, and deletes the
// user row. Steps run in order so a retry after a partial failure finishes
// the job.

import type { SQL } from "bun";
import { transaction } from "../db";
import { errorResponse } from "../errors";
import type { R2Client } from "../r2/client";
import { stagingKeyFor } from "../r2/keys";
import { deleteSegmentBlobsAfterCommit } from "../contrib/sources";
import { deleteAccountCandidates } from "../labels";
import { AppleUnavailableError, type RevokeRefreshToken } from "./apple";
import { authenticateClient } from "./sessions";
import { decryptRefreshToken } from "./tokens";

export interface AccountDeps {
  sql: SQL;
  r2: R2Client;
  // AES-256-GCM key for users.apple_refresh_token.
  refreshTokenKey: CryptoKey;
  revokeRefreshToken: RevokeRefreshToken;
  /** HMAC key for label-candidate account hashes (§1.2.25). */
  candidateKey: CryptoKey;
}

/** What steps 2–3 of account deletion need. */
export type AccountDataDeps = Pick<AccountDeps, "sql" | "r2" | "candidateKey">;

export interface AccountDeletionOptions {
  /**
   * Also delete the training segments cut from the account's sources
   * (`?contributions=delete`). Otherwise they stay, de-linked (§1.2.24).
   */
  deleteSegments?: boolean;
}

// DELETE /api/account[?contributions=keep|delete]: session required; allowed
// for blocked users (§1.2.16). 204 once deleted. A retry after success gets
// 401 — the session is gone.
export async function handleDeleteAccount(req: Request, deps: AccountDeps): Promise<Response> {
  const auth = await authenticateClient(req, deps, { allowBlocked: true });
  if (auth instanceof Response) return auth;
  const contributions = new URL(req.url).searchParams.get("contributions");
  if (contributions !== null && contributions !== "keep" && contributions !== "delete") {
    return errorResponse(422, "VALIDATION_ERROR", "contributions must be keep or delete", {
      details: { field: "contributions" },
    });
  }
  switch (await deleteAccount(deps, auth.userId, { deleteSegments: contributions === "delete" })) {
    case "deleted":
      return new Response(null, { status: 204 });
    case "apple-unavailable":
      return errorResponse(503, "APPLE_UNAVAILABLE", "Apple is unreachable; retry later");
    case "blob-delete-failed":
      return errorResponse(500, "INTERNAL", "Could not delete the stored blobs; retry later");
  }
}

export type AccountDeletion = "deleted" | "apple-unavailable" | "blob-delete-failed";

// Every step of `DELETE /api/account` after authentication, shared with the
// idle-account job (§1.2.17). Step 1 revokes Apple's refresh token, if the
// farm holds one: Apple answers 200 both when it revokes and when the token
// was already invalid, and any other answer means the farm is misconfigured
// and must not block the deletion. Apple unreachable → "apple-unavailable"
// with nothing deleted, so the retry revokes before it deletes.
export async function deleteAccount(
  deps: AccountDeps,
  userId: string,
  opts: AccountDeletionOptions = {},
): Promise<AccountDeletion> {
  const [user] = await deps.sql`SELECT apple_refresh_token FROM users WHERE id = ${userId}`;
  const sealed = user?.apple_refresh_token as Uint8Array<ArrayBuffer> | null | undefined;
  if (sealed != null) {
    let refreshToken = "";
    try {
      refreshToken = await decryptRefreshToken(deps.refreshTokenKey, userId, sealed);
    } catch (err) {
      // Corrupt ciphertext: there is no usable token to revoke.
      console.error("decrypting the Apple refresh token failed; deleting the account anyway", err);
    }
    if (refreshToken !== "") {
      try {
        await deps.revokeRefreshToken(refreshToken);
      } catch (err) {
        if (err instanceof AppleUnavailableError) return "apple-unavailable";
        console.error("revoking the Apple refresh token failed; deleting the account anyway", err);
      }
    }
  }

  try {
    await deleteAccountData(deps, userId, opts);
  } catch {
    return "blob-delete-failed";
  }
  return "deleted";
}

// Steps 2–3 of `DELETE /api/account`, shared with the `account-deleted`
// server-to-server notification (which has no session and no token left to
// revoke): delete every source attributed to the user, then the user row.
// R2 blobs go before the rows, mirroring `DELETE /api/sources/:id`: if a
// blob delete throws, the rows survive and the retry finishes the job.
// Attribution is kept until deletion (§1.2.17), so this reaches every
// source the account last wrote. Deleting a source cascades its
// segment_sources links, so its training segments stay de-linked unless
// opts.deleteSegments asks for them too (§1.2.24). Deleting the user row
// cascades sessions, consents and reports (§3).
export async function deleteAccountData(
  { sql, r2, candidateKey }: AccountDataDeps,
  userId: string,
  opts: AccountDeletionOptions = {},
): Promise<void> {
  const attributed = await sql`
    SELECT s.id, s.r2_key
    FROM source_attribution a
    JOIN sources s ON s.id = a.source_id
    WHERE a.user_id = ${userId}`;
  const segmentKeys = opts.deleteSegments
    ? ((await sql`
        SELECT t.r2_key
        FROM source_attribution a
        JOIN segment_sources ss ON ss.source_id = a.source_id
        JOIN training_segments t ON t.id = ss.segment_id
        WHERE a.user_id = ${userId}`) as { r2_key: string }[]).map((r) => r.r2_key)
    : [];
  for (const row of attributed as { id: string; r2_key: string }[]) {
    await r2.deleteObject(row.r2_key);
    await r2.deleteObject(stagingKeyFor(row.id));
  }
  for (const key of segmentKeys) await r2.deleteObject(key);
  const lateKeys = await transaction(sql, async (tx) => {
    let late: string[] = [];
    if (opts.deleteSegments) {
      const deleted = (await tx`
        DELETE FROM training_segments
        WHERE id IN (
          SELECT ss.segment_id FROM segment_sources ss
          JOIN source_attribution a ON a.source_id = ss.source_id
          WHERE a.user_id = ${userId}
        )
        RETURNING r2_key`) as { r2_key: string }[];
      late = deleted.map((d) => d.r2_key).filter((k) => !segmentKeys.includes(k));
    }
    await tx`
      DELETE FROM sources
      WHERE id IN (SELECT source_id FROM source_attribution WHERE user_id = ${userId})`;
    await deleteAccountCandidates(tx, candidateKey, userId);
    await tx`DELETE FROM users WHERE id = ${userId}`;
    return late;
  });
  // Segments the segmenter committed between the key read and the delete.
  await deleteSegmentBlobsAfterCommit(r2, lateKeys);
}

/** Accounts with no authenticated request or sign-in for this long are deleted (§1.2.17). */
export const IDLE_ACCOUNT_MONTHS = 24;

/** Most idle accounts one run deletes; the hourly schedule picks up the rest. */
export const IDLE_ACCOUNT_BATCH = 100;

// The hourly idle-account job (§1.2.17): deletes accounts idle for
// IDLE_ACCOUNT_MONTHS through the same steps as DELETE /api/account. An
// account that fails (Apple unreachable, R2 down) stays and is retried on
// the next run. Logs carry counts only, never account ids (§8).
export async function deleteIdleAccounts(deps: AccountDeps): Promise<{ deleted: number; failed: number }> {
  const idle = await deps.sql`
    SELECT id FROM users
    WHERE last_active_at < now() - make_interval(months => ${IDLE_ACCOUNT_MONTHS})
    ORDER BY last_active_at, id
    LIMIT ${IDLE_ACCOUNT_BATCH}`;
  let deleted = 0;
  let failed = 0;
  for (const { id } of idle as { id: string }[]) {
    if ((await deleteAccount(deps, id)) === "deleted") deleted++;
    else failed++;
  }
  return { deleted, failed };
}
