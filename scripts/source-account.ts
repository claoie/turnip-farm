// Resolves a source to the account that last wrote it, within the 30-day
// attribution window only (BACKEND_DESIGN.md §1.2.17). For quarantine
// review: decide whether to block the account with block-account.ts.
//
//   bun run moderation:source-account <source_id>
//
// Prints the account id without the source id (§8). Don't paste it next
// to source ids either: not into alerts, issues, or notes that outlive the
// window.

import { sourceAccountCli } from "../src/moderation";
import { runCli } from "./run";

await runCli(sourceAccountCli);
