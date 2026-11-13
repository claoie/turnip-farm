// Resolves a source to the account that last wrote it, while the source is
// attributed (BACKEND_DESIGN.md §1.2.17). For quarantine review: decide
// whether to block the account with block-account.ts.
//
//   bun run moderation:source-account <source_id>
//
// Prints the account id without the source id (§8). Don't paste it next
// to source ids either: not into alerts, issues, or notes that outlive the
// attribution.

import { sourceAccountCli } from "../src/moderation";
import { runCli } from "./run";

await runCli(sourceAccountCli);
