import { describe, expect, test } from "bun:test";
import { type ProxyRange, TokenBucket, clientAddress, parseProxyRange } from "./ratelimit";

describe("TokenBucket", () => {
  test("allows capacity requests, then refuses until refill", () => {
    let t = 0;
    const b = new TokenBucket(3, 60, () => t);
    expect(b.take("u")).toBe(true);
    expect(b.take("u")).toBe(true);
    expect(b.take("u")).toBe(true);
    expect(b.take("u")).toBe(false);
    // One minute later the bucket is full again (60/min).
    t += 60_000;
    expect(b.take("u")).toBe(true);
  });

  test("keys are independent", () => {
    let t = 0;
    const b = new TokenBucket(1, 60, () => t);
    expect(b.take("a")).toBe(true);
    expect(b.take("a")).toBe(false);
    expect(b.take("b")).toBe(true);
  });

  test("retryAfterSec estimates the wait for the next token", () => {
    let t = 0;
    const b = new TokenBucket(1, 60, () => t);
    expect(b.retryAfterSec("u")).toBe(0);
    expect(b.take("u")).toBe(true);
    expect(b.retryAfterSec("u")).toBe(1);
    t += 30_000;
    expect(b.retryAfterSec("u")).toBe(0);
  });

  test("partial refill accrues proportionally", () => {
    let t = 0;
    const b = new TokenBucket(2, 60, () => t);
    expect(b.take("u")).toBe(true);
    expect(b.take("u")).toBe(true);
    expect(b.take("u")).toBe(false);
    t += 30_000; // half a minute → 30 tokens at 60/min, capped at 2
    expect(b.take("u")).toBe(true);
    expect(b.take("u")).toBe(true);
    expect(b.take("u")).toBe(false);
  });
});

describe("clientAddress", () => {
  test("takes the client from X-Forwarded-For when the peer is IPv4 loopback", () => {
    expect(clientAddress("127.0.0.1", "203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddress("127.1.2.3", "203.0.113.7")).toBe("203.0.113.7");
  });

  test("takes the client from X-Forwarded-For when the peer is IPv6 loopback", () => {
    expect(clientAddress("::1", "203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddress("0:0:0:0:0:0:0:1", "203.0.113.7")).toBe("203.0.113.7");
  });

  test("takes the client from X-Forwarded-For when the peer is IPv4-mapped loopback", () => {
    // What Bun's default dual-stack socket reports when Caddy dials 127.0.0.1.
    expect(clientAddress("::ffff:127.0.0.1", "203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddress("::FFFF:127.0.0.1", "203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddress("::ffff:7f00:1", "203.0.113.7")).toBe("203.0.113.7");
  });

  test("falls back to the loopback peer when X-Forwarded-For is missing or empty", () => {
    expect(clientAddress("127.0.0.1", null)).toBe("127.0.0.1");
    expect(clientAddress("::ffff:127.0.0.1", null)).toBe("127.0.0.1");
    expect(clientAddress("127.0.0.1", "")).toBe("127.0.0.1");
    expect(clientAddress("127.0.0.1", "  ")).toBe("127.0.0.1");
    expect(clientAddress("127.0.0.1", "203.0.113.7, ")).toBe("127.0.0.1");
  });

  test("falls back to the loopback peer when the entry isn't an IP address", () => {
    expect(clientAddress("127.0.0.1", "unknown")).toBe("127.0.0.1");
    expect(clientAddress("127.0.0.1", "203.0.113.7:443")).toBe("127.0.0.1");
    expect(clientAddress("127.0.0.1", "[2001:db8::7]")).toBe("127.0.0.1");
    expect(clientAddress("127.0.0.1", "x".repeat(10_000))).toBe("127.0.0.1");
  });

  test("uses the last of several X-Forwarded-For entries, the one the proxy appended", () => {
    expect(clientAddress("127.0.0.1", "198.51.100.66, 10.0.0.1 , 203.0.113.7 ")).toBe("203.0.113.7");
  });

  test("ignores X-Forwarded-For from a peer that isn't loopback", () => {
    expect(clientAddress("198.51.100.2", "203.0.113.7")).toBe("198.51.100.2");
    expect(clientAddress("2001:db8::2", "203.0.113.7")).toBe("2001:db8:0:0::/64");
    // An IPv4-mapped address is loopback only when it maps 127.x.
    expect(clientAddress("::ffff:198.51.100.2", "203.0.113.7")).toBe("198.51.100.2");
  });

  test("keys IPv6 clients on their /64 prefix", () => {
    const a = clientAddress("2001:db8:1:2::7", null);
    expect(a).toBe("2001:db8:1:2::/64");
    expect(clientAddress("2001:0db8:0001:0002:ffff:ffff:ffff:ffff", null)).toBe(a);
    expect(clientAddress("2001:db8:1:3::7", null)).not.toBe(a);
    // The same through the proxy.
    expect(clientAddress("127.0.0.1", "2001:db8:1:2::8")).toBe(a);
    expect(clientAddress("2001:db8::1%en0", null)).toBe("2001:db8:0:0::/64");
  });

  test("keys IPv4-mapped clients on their IPv4 address", () => {
    expect(clientAddress("::ffff:198.51.100.2", null)).toBe("198.51.100.2");
    expect(clientAddress("127.0.0.1", "::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  test("is \"unknown\" when there is no peer address", () => {
    expect(clientAddress(undefined, "203.0.113.7")).toBe("unknown");
  });
});

describe("clientAddress with trusted proxies", () => {
  const ranges = (...entries: string[]): ProxyRange[] => entries.map((e) => parseProxyRange(e)!);
  const docker = ranges("172.16.0.0/12");

  test("reads through a trusted proxy that isn't loopback", () => {
    expect(clientAddress("172.18.0.2", "203.0.113.7", docker)).toBe("203.0.113.7");
    expect(clientAddress("::ffff:172.18.0.2", "203.0.113.7", docker)).toBe("203.0.113.7");
    // Loopback stays trusted alongside the ranges.
    expect(clientAddress("127.0.0.1", "203.0.113.7", docker)).toBe("203.0.113.7");
  });

  test("ignores X-Forwarded-For from a peer outside every range", () => {
    expect(clientAddress("172.32.0.2", "203.0.113.7", docker)).toBe("172.32.0.2");
    expect(clientAddress("198.51.100.2", "203.0.113.7", docker)).toBe("198.51.100.2");
  });

  test("skips trusted hops, last entry first, and never reaches what the client sent", () => {
    // Client → CDN edge (trusted) → container proxy (trusted) → farm. The
    // client forged the first entry; the proxies appended the other two.
    const trusted = ranges("172.16.0.0/12", "104.16.0.0/13");
    expect(clientAddress("172.18.0.2", "198.51.100.66, 203.0.113.7, 104.16.0.5", trusted)).toBe("203.0.113.7");
    // Without the CDN's ranges, the edge is the client.
    expect(clientAddress("172.18.0.2", "198.51.100.66, 203.0.113.7, 104.16.0.5", docker)).toBe("104.16.0.5");
  });

  test("stops at a malformed entry, keeping the last trusted address", () => {
    const trusted = ranges("172.16.0.0/12", "104.16.0.0/13");
    expect(clientAddress("172.18.0.2", "203.0.113.7, unknown, 104.16.0.5", trusted)).toBe("104.16.0.5");
    expect(clientAddress("172.18.0.2", "unknown", trusted)).toBe("172.18.0.2");
    expect(clientAddress("172.18.0.2", "203.0.113.7, ", trusted)).toBe("172.18.0.2");
    expect(clientAddress("172.18.0.2", null, trusted)).toBe("172.18.0.2");
  });

  test("skips a loopback entry like any trusted proxy", () => {
    // nginx → Caddy on one host: Caddy appends nginx's loopback address.
    expect(clientAddress("127.0.0.1", "203.0.113.7, 127.0.0.1")).toBe("203.0.113.7");
  });

  test("ends at the first entry when every hop is trusted", () => {
    expect(clientAddress("127.0.0.1", "172.18.0.5", docker)).toBe("172.18.0.5");
    expect(clientAddress("172.18.0.2", "127.0.0.1, 172.18.0.5", docker)).toBe("127.0.0.1");
  });

  test("matches IPv6 ranges, and keys the client on its /64", () => {
    const trusted = ranges("fd00::/8");
    expect(clientAddress("fd12::2", "2001:db8:1:2::8", trusted)).toBe("2001:db8:1:2::/64");
    expect(clientAddress("fe00::2", "2001:db8:1:2::8", trusted)).toBe("fe00:0:0:0::/64");
  });

  test("never matches across address families", () => {
    expect(clientAddress("2001:db8::2", "203.0.113.7", ranges("0.0.0.0/0"))).toBe("2001:db8:0:0::/64");
    expect(clientAddress("198.51.100.2", "203.0.113.7", ranges("::/0"))).toBe("198.51.100.2");
  });

  test("an address without a prefix trusts only itself", () => {
    const trusted = ranges("172.18.0.2");
    expect(clientAddress("172.18.0.2", "203.0.113.7", trusted)).toBe("203.0.113.7");
    expect(clientAddress("172.18.0.3", "203.0.113.7", trusted)).toBe("172.18.0.3");
  });

  test("compares prefixes that don't end on a byte", () => {
    expect(clientAddress("172.31.255.255", "203.0.113.7", docker)).toBe("203.0.113.7");
    expect(clientAddress("172.15.255.255", "203.0.113.7", docker)).toBe("172.15.255.255");
  });
});

describe("parseProxyRange", () => {
  test.each(["10.0.0.0/8", "10.0.0.1", " 172.16.0.0/12 ", "0.0.0.0/0", "fd00::/8", "::1", "2001:db8::/32", "::ffff:10.0.0.1"])(
    "accepts %p",
    (entry) => {
      expect(parseProxyRange(entry)).not.toBeNull();
    },
  );

  test.each(["", "10.0.0.0/", "10.0.0.0/33", "10.0.0.0/-1", "10.0.0.0/a", "10.0.0.0/8/1", "fd00::/129", "example.com", "10.0.0", "::ffff:10.0.0.0/104"])(
    "rejects %p",
    (entry) => {
      expect(parseProxyRange(entry)).toBeNull();
    },
  );

  test("reads the address and prefix", () => {
    expect(parseProxyRange("172.16.0.0/12")).toEqual({ v6: false, bytes: [172, 16, 0, 0], prefix: 12 });
    expect(parseProxyRange("::1")).toEqual({ v6: true, bytes: [...new Array<number>(15).fill(0), 1], prefix: 128 });
    // An IPv4-mapped address counts as IPv4.
    expect(parseProxyRange("::ffff:10.0.0.1")).toEqual({ v6: false, bytes: [10, 0, 0, 1], prefix: 32 });
  });
});
