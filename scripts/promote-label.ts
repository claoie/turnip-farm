// Promotes a label candidate into the vocabulary (BACKEND_DESIGN.md
// §1.2.25): adds it to label_taxonomy at a new taxonomy version, mapped to
// <canonical> (default: itself), and drops its candidates. The app picks
// the name up from GET /api/taxonomy/current.
//
//   bun run labels:promote <name> [<canonical>]

import { promoteLabelCli } from "../src/labels";
import { runCli } from "./run";

await runCli(promoteLabelCli);
