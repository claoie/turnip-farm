// Per-key token buckets (BACKEND_DESIGN.md §7.2): per-user on the
// contribution POSTs and POST /api/reports (suggested 60 requests/minute),
// per-IP on POST /api/auth/apple and POST /api/auth/apple/notifications
// (suggested 10/minute) and on the public GETs (suggested 30/minute).
// In-process and per-instance; the farm runs as one process. Answered 429
// carries Retry-After.

import { isIPv4, isIPv6 } from "node:net";

/**
 * The client address a per-IP bucket is keyed on (BACKEND_DESIGN.md §7.2).
 * Behind a reverse proxy the socket peer is the proxy, so when the peer is
 * trusted (loopback, or inside one of `trusted`) the client comes from
 * X-Forwarded-For instead. Each proxy appends the address it saw, so the
 * entries are read from the last one back, skipping trusted proxies; the
 * first other address is the client. Whatever a client sends itself sits
 * to the left of that, out of reach. A missing or malformed entry stops the
 * walk at the last trusted address. From any other peer the header is
 * ignored. A loopback entry is skipped like any trusted proxy: a proxy
 * appends it only for a host-local request, and a host-local process can
 * already set its own address by connecting to the farm directly.
 *
 * IPv4-mapped IPv6 addresses count as their IPv4 address, and other IPv6
 * addresses as their /64 prefix: one host commonly holds a whole /64 and
 * could otherwise take a fresh bucket per address.
 */
export function clientAddress(
  peer: string | undefined,
  forwardedFor: string | null,
  trusted: readonly ProxyRange[] = [],
): string {
  const p = peer === undefined ? null : parseIp(peer);
  if (p === null) return peer ?? "unknown";
  let client = p;
  if (forwardedFor !== null) {
    const entries = forwardedFor.split(",");
    for (let i = entries.length - 1; i >= 0 && isTrusted(client, trusted); i--) {
      const hop = parseIp(entries[i]!.trim());
      if (hop === null) break;
      client = hop;
    }
  }
  return bucketKey(client);
}

/** An address or CIDR range from TRUSTED_PROXIES. */
export interface ProxyRange {
  v6: boolean;
  bytes: number[];
  prefix: number;
}

/**
 * Parses one TRUSTED_PROXIES entry: an IPv4 or IPv6 address, optionally
 * with a /prefix. Null when it is neither. An IPv4-mapped IPv6 address
 * counts as IPv4, as everywhere else here.
 */
export function parseProxyRange(text: string): ProxyRange | null {
  const [addr, prefixText, ...rest] = text.trim().split("/");
  if (rest.length > 0) return null;
  const ip = parseIp(addr!);
  if (ip === null) return null;
  const v6 = "v6" in ip;
  const max = v6 ? 128 : 32;
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (prefix > max) return null;
  return { v6, bytes: ipBytes(ip), prefix };
}

function isTrusted(ip: Ip, trusted: readonly ProxyRange[]): boolean {
  return isLoopback(ip) || trusted.some((r) => inRange(ip, r));
}

function inRange(ip: Ip, r: ProxyRange): boolean {
  if (("v6" in ip) !== r.v6) return false;
  const b = ipBytes(ip);
  for (let i = 0, bits = r.prefix; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((b[i]! & mask) !== (r.bytes[i]! & mask)) return false;
  }
  return true;
}

function ipBytes(ip: Ip): number[] {
  if ("v4" in ip) return ip.v4.split(".").map(Number);
  return ip.v6.flatMap((g) => [g >> 8, g & 0xff]);
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
