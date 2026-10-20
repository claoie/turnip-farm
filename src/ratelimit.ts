// Per-key token buckets (BACKEND_DESIGN.md §7.2): per-user on the
// contribution POSTs and POST /api/reports (suggested 60 requests/minute),
// per-IP on POST /api/auth/apple and POST /api/auth/apple/notifications
// (suggested 10/minute) and on the public GETs (suggested 30/minute).
// In-process and per-instance; the farm runs as one process. Answered 429
// carries Retry-After.

import { isIPv4, isIPv6 } from "node:net";

/**
 * The client address a per-IP bucket is keyed on. Behind a reverse proxy
 * on the same host (docs/DEPLOYMENT.md §4.9) the socket peer is loopback
 * for every request, so the client comes from the last X-Forwarded-For
 * entry instead: the address the proxy itself saw and appended, which a
 * client can't forge. (Caddy discards client-supplied values by default,
 * so it is usually the only entry. Behind a proxying CDN it is the CDN's
 * edge, and clients behind one edge share a bucket.) From any other peer,
 * or when that entry isn't an IP address, the header is ignored.
 *
 * IPv4-mapped IPv6 addresses count as their IPv4 address, and other IPv6
 * addresses as their /64 prefix: one host commonly holds a whole /64 and
 * could otherwise take a fresh bucket per address.
 */
export function clientAddress(peer: string | undefined, forwardedFor: string | null): string {
  const p = peer === undefined ? null : parseIp(peer);
  if (p === null) return peer ?? "unknown";
  if (forwardedFor !== null && isLoopback(p)) {
    const forwarded = parseIp(forwardedFor.split(",").at(-1)!.trim());
    if (forwarded !== null) return bucketKey(forwarded);
  }
  return bucketKey(p);
}

type Ip = { v4: string } | { v6: number[] };

function parseIp(addr: string): Ip | null {
  if (isIPv4(addr)) return { v4: addr };
  if (!isIPv6(addr)) return null;
  const g = ipv6Groups(addr.split("%")[0]!);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return { v4: `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}` };
  }
  return { v6: g };
}

// The eight 16-bit groups of a valid IPv6 address, "::" expanded.
function ipv6Groups(addr: string): number[] {
  const groups = (part: string): number[] =>
    part === ""
      ? []
      : part.split(":").flatMap((w) => {
          if (!w.includes(".")) return [parseInt(w, 16)];
          const [a, b, c, d] = w.split(".").map(Number) as [number, number, number, number];
          return [(a << 8) | b, (c << 8) | d];
        });
  const [head, tail] = addr.split("::");
  const h = groups(head!);
  if (tail === undefined) return h;
  const t = groups(tail);
  return [...h, ...new Array<number>(8 - h.length - t.length).fill(0), ...t];
}

function isLoopback(ip: Ip): boolean {
  if ("v4" in ip) return ip.v4.startsWith("127.");
  return ip.v6.every((x, i) => x === (i === 7 ? 1 : 0));
}

function bucketKey(ip: Ip): string {
  if ("v4" in ip) return ip.v4;
  return `${ip.v6.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
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
