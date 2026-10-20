// HTTP surface. Routing lives here, apart from src/index.ts, so tests can
// build the handler with stand-in dependencies, or start a real server on an
// ephemeral port, without loading config.

import { type SignInDeps, handleSignIn, handleSignOut } from "./auth/sessions";
import { handleDeleteAccount } from "./auth/account";
import { handleAppleNotifications } from "./auth/notifications";
import {
  handleDeleteSource,
  handleGetSource,
  handleGetSourcePose,
  handleRegisterSource,
} from "./contrib/sources";
import { handlePostClipLabels, handlePostClips } from "./contrib/clips";
import { handleGetLabelsExport } from "./export";
import { handleGetTaxonomyCurrent } from "./taxonomy";
import { handleGetModelsCurrent, handlePostModels } from "./models";
import {
  handlePostQuarantine,
  handlePurgeQuarantine,
  handleReleaseQuarantine,
} from "./quarantine";
import { handlePostReport } from "./reports";
import { errorResponse } from "./errors";
import { isVideoId } from "./contrib/validate";
import type { R2Client } from "./r2/client";
import { TokenBucket } from "./ratelimit";

export interface RateLimits {
  /** Per-user token bucket for the contribution POSTs and POST /api/reports (§7.2). */
  user: TokenBucket;
  /** Per-IP token bucket for POST /api/auth/apple and POST /api/auth/apple/notifications (§7.2). */
  ip: TokenBucket;
  /** Per-IP token bucket for the public GET endpoints (§7.2). */
  publicIp: TokenBucket;
}

import { type RevokeRefreshToken, type VerifyAppleJwt } from "./auth/apple";

export type AppDeps = SignInDeps & {
  r2: R2Client;
  /** Pre-shared key for the pipeline endpoints (BACKEND_DESIGN.md §7.1). */
  pipelineKey: string;
  limits: RateLimits;
  /** Apple JWT verifier without the `exp` requirement, for server-to-server notifications (§7.1). */
  verifyNotificationPayload: VerifyAppleJwt;
  revokeRefreshToken: RevokeRefreshToken;
};

export function createHandler(deps: AppDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const seg = new URL(req.url).pathname.split("/").filter(Boolean);
    const method = req.method;

    if (method === "GET" && seg.length === 1 && seg[0] === "healthz") {
      return Response.json({ status: "ok" });
    }
    if (seg[0] === "api") {
      if (method === "POST" && seg.length === 3 && seg[1] === "auth") {
        if (seg[2] === "apple") return handleSignIn(req, deps);
        if (seg[2] === "signout") return handleSignOut(req, deps);
      }
      if (method === "POST" && seg.length === 4 && seg[1] === "auth" && seg[2] === "apple" && seg[3] === "notifications") {
        return handleAppleNotifications(req, deps);
      }
      if (method === "DELETE" && seg.length === 2 && seg[1] === "account") {
        return handleDeleteAccount(req, deps);
      }
      if (seg[1] === "sources") {
        if (method === "POST" && seg.length === 2) return handleRegisterSource(req, deps);
        if (seg.length === 3) {
          if (method === "GET") return handleGetSource(req, deps, seg[2]!);
          if (method === "DELETE") return handleDeleteSource(req, deps, seg[2]!);
        }
        if (method === "GET" && seg.length === 4 && seg[3] === "pose") {
          return handleGetSourcePose(req, deps, seg[2]!);
        }
      }
      if (seg[1] === "clips") {
        if (method === "POST" && seg.length === 2) return handlePostClips(req, deps);
        if (method === "POST" && seg.length === 4 && seg[3] === "labels") {
          return handlePostClipLabels(req, deps, seg[2]!);
        }
      }
      if (seg[1] === "labels") {
        if (method === "GET" && seg.length === 3 && seg[2] === "export") {
          return handleGetLabelsExport(req, deps);
        }
      }
      if (seg[1] === "taxonomy") {
        if (method === "GET" && seg.length === 3 && seg[2] === "current") {
          return handleGetTaxonomyCurrent(req, deps);
        }
      }
      if (seg[1] === "models") {
        if (method === "POST" && seg.length === 2) return handlePostModels(req, deps);
        if (method === "GET" && seg.length === 3 && seg[2] === "current") {
          return handleGetModelsCurrent(req, deps);
        }
      }
      if (seg[1] === "quarantine") {
        if (method === "POST" && seg.length === 2) return handlePostQuarantine(req, deps);
        if (method === "POST" && seg.length === 4 && isVideoId(seg[2])) {
          if (seg[3] === "release") return handleReleaseQuarantine(req, deps, seg[2]!);
          if (seg[3] === "purge") return handlePurgeQuarantine(req, deps, seg[2]!);
        }
      }
      if (method === "POST" && seg.length === 2 && seg[1] === "reports") {
        return handlePostReport(req, deps);
      }
    }
    return errorResponse(404, "NOT_FOUND", "Not found");
  };
}

export function startServer(port: number, deps: AppDeps) {
  const handle = createHandler(deps);
  return Bun.serve({
    port,
    fetch(req, server) {
      // Per-IP limit on sign-in and notification attempts (§7.2); there is
      // no user yet on either. The only legitimate notification sender is
      // Apple, but the URL is public and the bucket caps its abuse.
      const pathname = new URL(req.url).pathname;
      if (
        req.method === "POST" &&
        (pathname === "/api/auth/apple" || pathname === "/api/auth/apple/notifications")
      ) {
        const ip = server.requestIP(req)?.address ?? "unknown";
        if (!deps.limits.ip.take(ip)) {
          return errorResponse(429, "RATE_LIMITED", "Too many requests", {
            headers: { "Retry-After": String(deps.limits.ip.retryAfterSec(ip)) },
          });
        }
      }
      // Per-IP limit on the public GET endpoints (§7.2); they are
      // cacheable, so legitimate clients rarely touch the bucket.
      if (
        req.method === "GET" &&
        (pathname === "/api/taxonomy/current" || pathname === "/api/models/current")
      ) {
        const ip = server.requestIP(req)?.address ?? "unknown";
        if (!deps.limits.publicIp.take(ip)) {
          return errorResponse(429, "RATE_LIMITED", "Too many requests", {
            headers: { "Retry-After": String(deps.limits.publicIp.retryAfterSec(ip)) },
          });
        }
      }
      return handle(req);
    },
    error(err) {
      // Log the error, never the request: requests carry Apple tokens,
      // session tokens, and pose data (BACKEND_DESIGN.md §8).
      console.error(err);
      return errorResponse(500, "INTERNAL", "Internal server error");
    },
  });
}
