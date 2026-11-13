// Lists the open label candidates (BACKEND_DESIGN.md §1.2.25): names the
// vocabulary lacks, with how many accounts submitted each, most first.
// Candidates expire 30 days after submission.
//
//   bun run labels:candidates [--min N]

import { labelCandidatesCli } from "../src/labels";
import { runCli } from "./run";

await runCli(labelCandidatesCli);
