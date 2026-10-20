// Sets or clears users.is_blocked (BACKEND_DESIGN.md §1.2.16). A blocked
// account gets 403 ACCOUNT_BLOCKED on every endpoint except sign-out and
// account deletion; its sessions are kept so it can still use those two.
//
//   bun run moderation:block <account_id>
//   bun run moderation:block --clear <account_id>

import { blockAccountCli } from "../src/moderation";
import { runCli } from "./run";

await runCli(blockAccountCli);
