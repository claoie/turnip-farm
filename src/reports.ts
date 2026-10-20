// Reports (BACKEND_DESIGN.md §7.3; issue #11).
// POST /api/reports — a signed-in user reports a bad source, clip, or
// label: {target_type, target_id, reason} → 201 {id}. Reports are a
// moderation queue; they change no training data by themselves. Only a
// source's key holder can see it, so the reporter is usually the target's
// own contributor, and a report is deleted 30 days after it is filed
// (§1.2.17; src/contrib/purge.ts). Blocked accounts get 403 like every
// other contribution endpoint (§1.2.16).
//
// The target is not looked up: reports.target_id has no foreign key, and
// an existence check would make source and clip ids an existence oracle
// (§7.2 ownership privacy). Nothing here is logged, since a log line would
// put a user id next to a target id (§8).

import type { SQL } from "bun";
import type { RateLimits } from "./app";
import { authenticateClient } from "./auth/sessions";
import { isUuid, isVideoId, readJsonObject } from "./contrib/validate";
import { errorResponse } from "./errors";

export interface ReportsDeps {
  sql: SQL;
  limits: RateLimits;
}

const MAX_REASON_LEN = 1000;

// target_id has the shape of the target's primary key (§3): sources.id is
// a video_id; clips.id and labels.id are UUIDs.
const TARGET_TYPES = ["source", "clip", "label"] as const;
type TargetType = (typeof TARGET_TYPES)[number];

const invalid = (message: string, details: Record<string, unknown> = {}) =>
  errorResponse(422, "VALIDATION_ERROR", message, { details });

interface ReportInput {
  targetType: TargetType;
  targetId: string;
  reason: string;
}

async function readReportInput(req: Request): Promise<{ input?: ReportInput; error?: Response }> {
  const body = await readJsonObject(req);
  if (!body) return { error: invalid("body must be a JSON object") };
  const { target_type, target_id, reason } = body;

  if (!TARGET_TYPES.includes(target_type as TargetType)) {
    return { error: invalid("target_type must be source, clip, or label", { allowed: TARGET_TYPES }) };
  }
  const targetType = target_type as TargetType;
  if (targetType === "source" && !isVideoId(target_id)) {
    return { error: invalid("target_id must be a 64-char lowercase hex video id for a source") };
  }
  if (targetType !== "source" && !isUuid(target_id)) {
    return { error: invalid(`target_id must be a UUID for a ${targetType}`) };
  }
  if (typeof reason !== "string" || reason.trim() === "" || reason.length > MAX_REASON_LEN) {
    return { error: invalid("reason must be a non-empty string", { maxLength: MAX_REASON_LEN }) };
  }
  return {
    input: {
      targetType,
      // UUIDs are matched case-insensitively; store them as Postgres prints them.
      targetId: (target_id as string).toLowerCase(),
      reason: reason.trim(),
    },
  };
}

export async function handlePostReport(req: Request, deps: ReportsDeps): Promise<Response> {
  const auth = await authenticateClient(req, deps);
  if (auth instanceof Response) return auth;
  // Per-user token bucket on POSTs (§7.2), shared with the contribution POSTs.
  if (!deps.limits.user.take(auth.userId)) {
    return errorResponse(429, "RATE_LIMITED", "Too many requests", {
      headers: { "Retry-After": String(deps.limits.user.retryAfterSec(auth.userId)) },
    });
  }
  const { input, error } = await readReportInput(req);
  if (error) return error;

  const [report] = await deps.sql`
    INSERT INTO reports (reporter_user_id, target_type, target_id, reason)
    VALUES (${auth.userId}, ${input!.targetType}, ${input!.targetId}, ${input!.reason})
    RETURNING id`;
  return Response.json({ id: report.id }, { status: 201 });
}
