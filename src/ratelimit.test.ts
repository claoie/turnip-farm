import { describe, expect, test } from "bun:test";
import { TokenBucket, clientAddress } from "./ratelimit";

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
    expect(clientAddress("::1", "2001:db8::7")).toBe("2001:db8::7");
  });

  test("takes the client from X-Forwarded-For when the peer is IPv4-mapped loopback", () => {
    expect(clientAddress("::ffff:127.0.0.1", "203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddress("::FFFF:127.0.0.1", "203.0.113.7")).toBe("203.0.113.7");
  });

  test("falls back to the loopback peer when X-Forwarded-For is missing or empty", () => {
    expect(clientAddress("127.0.0.1", null)).toBe("127.0.0.1");
    expect(clientAddress("::1", null)).toBe("::1");
    expect(clientAddress("::ffff:127.0.0.1", null)).toBe("::ffff:127.0.0.1");
    expect(clientAddress("127.0.0.1", "")).toBe("127.0.0.1");
    expect(clientAddress("127.0.0.1", "  ")).toBe("127.0.0.1");
    expect(clientAddress("127.0.0.1", " , 203.0.113.7")).toBe("127.0.0.1");
  });

  test("uses the first of several X-Forwarded-For entries, trimmed", () => {
    expect(clientAddress("127.0.0.1", " 203.0.113.7 , 198.51.100.2, 10.0.0.1")).toBe("203.0.113.7");
  });

  test("ignores X-Forwarded-For from a peer that isn't loopback", () => {
    expect(clientAddress("198.51.100.2", "203.0.113.7")).toBe("198.51.100.2");
    expect(clientAddress("2001:db8::2", "127.0.0.1")).toBe("2001:db8::2");
    // An IPv4-mapped address is loopback only when it maps 127.x.
    expect(clientAddress("::ffff:198.51.100.2", "203.0.113.7")).toBe("::ffff:198.51.100.2");
  });

  test("keys on the peer as before when there is no header", () => {
    expect(clientAddress("198.51.100.2", null)).toBe("198.51.100.2");
  });

  test("is \"unknown\" when there is no peer address", () => {
    expect(clientAddress(undefined, "203.0.113.7")).toBe("unknown");
  });
});
