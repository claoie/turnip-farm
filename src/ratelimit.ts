// Per-key token buckets (BACKEND_DESIGN.md §7.2): per-user on the
// contribution POSTs and POST /api/reports (suggested 60 requests/minute),
// per-IP on POST /api/auth/apple and POST /api/auth/apple/notifications
// (suggested 10/minute) and on the public GETs (suggested 30/minute).
// In-process and per-instance; the farm runs as one process. Answered 429
// carries Retry-After.

/**
 * The client address a per-IP bucket is keyed on. Behind a reverse proxy
 * on the same host (docs/DEPLOYMENT.md §4.9) the socket peer is loopback
 * for every request, so the client comes from the first X-Forwarded-For
 * entry instead. That is sound only because Caddy, by default, replaces
 * any client-supplied X-Forwarded-For with the one address it saw: adding
 * `trusted_proxies` or a proxying CDN in front makes the first entry
 * client-controlled. From any other peer the header is ignored, so a
 * direct client can't pick its own bucket.
 */
export function clientAddress(peer: string | undefined, forwardedFor: string | null): string {
  if (peer === undefined) return "unknown";
  if (!isLoopback(peer) || forwardedFor === null) return peer;
  return forwardedFor.split(",")[0]!.trim() || peer;
}

function isLoopback(addr: string): boolean {
  const a = addr.toLowerCase();
  return a.startsWith("127.") || a === "::1" || a.startsWith("::ffff:127.");
}

export class TokenBucket {
  private state = new Map<string, { tokens: number; updatedAtMs: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Consumes one token for key; false when the bucket is empty. */
  take(key: string): boolean {
    const t = this.now();
    let s = this.state.get(key);
    if (s === undefined) {
      s = { tokens: this.capacity, updatedAtMs: t };
      this.state.set(key, s);
    } else {
      s.tokens = Math.min(
        this.capacity,
        s.tokens + ((t - s.updatedAtMs) * this.refillPerMinute) / 60000,
      );
      s.updatedAtMs = t;
    }
    if (s.tokens < 1) return false;
    s.tokens -= 1;
    this.prune(t);
    return true;
  }

  /** Seconds until one token is available; 0 when take() would succeed. */
  retryAfterSec(key: string): number {
    const s = this.state.get(key);
    if (s === undefined) return 0;
    const t = this.now();
    const tokens = Math.min(
      this.capacity,
      s.tokens + ((t - s.updatedAtMs) * this.refillPerMinute) / 60000,
    );
    if (tokens >= 1) return 0;
    return Math.max(
      1,
      Math.ceil(((1 - tokens) / this.refillPerMinute) * 60),
    );
  }

  // The map grows with distinct keys; drop buckets idle long enough to be
  // full again, so a long-lived process doesn't leak memory.
  private prune(t: number): void {
    if (this.state.size < 100_000) return;
    const fullAfterMs = (this.capacity / this.refillPerMinute) * 60000;
    for (const [k, s] of this.state) {
      if (t - s.updatedAtMs > fullAfterMs) this.state.delete(k);
    }
  }
}
