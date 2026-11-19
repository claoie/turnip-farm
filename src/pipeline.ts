// Pipeline service-key auth (BACKEND_DESIGN.md §7.1): the training
// pipeline's endpoints (`GET /api/labels/export`, `POST /api/models*`,
// `POST /api/quarantine*`) authenticate with the pre-shared
// TURNIP_PIPELINE_KEY as `Authorization: Bearer <key>` — never a Sign in
// with Apple session (§1.2.7).

import type { SQL } from "bun";
import { timingSafeEqual } from "node:crypto";
import { errorResponse } from "./errors";

export interface PipelineDeps {
  sql: SQL;
  pipelineKey: string;
}

// Null when the request may proceed. A 401 here means "fix the pipeline
// key", never "sign in again" — this surface has no users.
export function authenticatePipeline(req: Request, pipelineKey: string): Response | null {
  const header = req.headers.get("authorization")?.trim() ?? "";
  const token = /^Bearer (\S+)$/i.exec(header)?.[1] ?? "";
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(pipelineKey, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return errorResponse(401, "UNAUTHENTICATED", "Invalid pipeline key", {
      headers: { "WWW-Authenticate": "Bearer" },
    });
  }
  return null;
}
