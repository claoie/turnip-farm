// Maintainer moderation (BACKEND_DESIGN.md §1.2.16, §1.2.17, §8; master
// plan §6; issue #11). Run from the scripts in scripts/, against the
// database directly; nothing here is reachable over HTTP.
//
// During quarantine review the maintainer resolves a source to the account
// that last wrote it, then decides whether to block that account. Blocking
// stops future contributions (403 ACCOUNT_BLOCKED from authenticateClient);
// sources already contributed are removed by a quarantine purge (§1.2.3),
// since attribution expires. A blocked account keeps its sessions so it can
// still sign out and delete itself (§1.2.16).
//
// Attribution exists for 30 days only, and §8 forbids an account id from
// sitting next to anything that outlives it. So the lookup reads only
// inside the window, and the CLI prints the account id without the source
// id or anything else about the source.

import type { SQL } from "bun";
import { isVideoId } from "./contrib/validate";

export interface AttributedAccount {
  userId: string;
  isBlocked: boolean;
}

// The account that last wrote the source, or null when the source is
// unknown or its attribution is past the 30-day window. The window filter
// is here rather than trusted to the hourly purge, so a late purge never
// extends the link (§4).
export async function attributedAccount(sql: SQL, sourceId: string): Promise<AttributedAccount | null> {
  const [row] = await sql`
    SELECT a.user_id, u.is_blocked
    FROM source_attribution a
    JOIN users u ON u.id = a.user_id
    WHERE a.source_id = ${sourceId} AND a.attributed_at >= now() - interval '30 days'`;
  return row ? { userId: row.user_id as string, isBlocked: row.is_blocked as boolean } : null;
}

// Sets or clears users.is_blocked. "unchanged" when the account was already
// in that state; "unknown" when there is no such account.
export async function setBlocked(
  sql: SQL,
  userId: string,
  blocked: boolean,
): Promise<"changed" | "unchanged" | "unknown"> {
  const [updated] = await sql`
    UPDATE users SET is_blocked = ${blocked}, updated_at = now()
    WHERE id = ${userId} AND is_blocked <> ${blocked}
    RETURNING id`;
  if (updated) return "changed";
  const [existing] = await sql`SELECT id FROM users WHERE id = ${userId}`;
  return existing ? "unchanged" : "unknown";
}

export interface Output {
  out: (line: string) => void;
  err: (line: string) => void;
}

// scripts/source-account.ts <source_id>. Exit status: 0 found, 1 no
// account within the window, 2 usage.
export async function sourceAccountCli(args: string[], sql: SQL, io: Output): Promise<number> {
  const [sourceId] = args;
  if (args.length !== 1 || !isVideoId(sourceId)) {
    io.err("usage: bun run moderation:source-account <source_id>  (64-char lowercase hex)");
    return 2;
  }
  const account = await attributedAccount(sql, sourceId);
  if (account === null) {
    io.err("No account: the source is unknown or its attribution is past the 30-day window.");
    return 1;
  }
  // The account id alone, never next to the source id (§8).
  io.out(`account: ${account.userId}`);
  io.out(`blocked: ${account.isBlocked ? "yes" : "no"}`);
  return 0;
}

// scripts/block-account.ts [--clear] <account_id>. Exit status: 0 done
// (or already so), 1 no such account, 2 usage.
export async function blockAccountCli(args: string[], sql: SQL, io: Output): Promise<number> {
  const clear = args[0] === "--clear";
  const rest = clear ? args.slice(1) : args;
  const [userId] = rest;
  if (rest.length !== 1 || userId === undefined || userId === "" || userId.startsWith("-")) {
    io.err("usage: bun run moderation:block [--clear] <account_id>");
    return 2;
  }
  const result = await setBlocked(sql, userId, !clear);
  if (result === "unknown") {
    io.err(`No account ${userId}.`);
    return 1;
  }
  const state = clear ? "unblocked" : "blocked";
  io.out(result === "changed" ? `Account ${userId} is now ${state}.` : `Account ${userId} was already ${state}.`);
  return 0;
}
