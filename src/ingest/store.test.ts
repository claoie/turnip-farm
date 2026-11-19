// Pure unit tests (no DB): the fetch is stubbed and the clock is frozen,
// so the production SigV4 signer executes under test for the first time.
// The signer was previously untestable: it used the global fetch and
// `new Date()` directly, while the worker tests substitute a fake.
//
// The bounded-download tests below pin the cap on `get` (chunked bodies
// exceeding it, a declared content-length over it) against the same
// capturing fetch, with the cap set explicitly small.
//
// The expected signature below is recomputed in this file from the SigV4
// spec (canonical request + HMAC key chain via node:crypto), independently
// of the store's WebCrypto implementation — a canonicalization slip in
// either one fails the comparison. The golden value pins the result
// against regressions, following presign.test.ts.

import { createHash, createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { BlobTooLargeError } from "../r2/client";
import { R2BlobStore, R2Error } from "./store";

const CFG = {
  accountId: "123456789012",
  accessKeyId: "test-access-key-id",
  secretAccessKey: "test-secret-access-key",
  bucket: "turnip-farm",
};
// Synthetic credentials (never live).
const NOW = new Date("2026-10-28T12:00:00.000Z");
const HOST = `${CFG.accountId}.r2.cloudflarestorage.com`;

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function amzDateStrings(now: Date): { amzDate: string; dateStamp: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  const dateStamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  return {
    dateStamp,
    amzDate: `${dateStamp}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`,
  };
}

// Independent SigV4 header-signature computation, from the spec: build the
// canonical request, hash it, derive the signing key, sign the string to
// sign. Deliberately written without reusing any store helper.
function expectedAuthorization(
  method: string,
  path: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  payloadHash: string,
  now: Date,
): string {
  const { amzDate, dateStamp } = amzDateStrings(now);
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((n) => `${encodeURIComponent(n)}=${encodeURIComponent(query[n]!)}`)
    .join("&");
  const signedNames = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort();
  const canonicalHeaders = signedNames.map((n) => `${n}:${headers[n]!.trim()}\n`).join("");
  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedNames.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  let key: Buffer | string = `AWS4${CFG.secretAccessKey}`;
  for (const part of [dateStamp, "auto", "s3", "aws4_request"]) key = hmacSha256(key, part);
  const signature = hmacSha256(key, stringToSign).toString("hex");
  return `AWS4-HMAC-SHA256 Credential=${CFG.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;
}

interface CapturedCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: unknown };
}

function capturingFetch(
  respond: (call: CapturedCall, index: number) => Response,
): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchFn = (async (url: unknown, init?: Record<string, unknown>) => {
    const call: CapturedCall = { url: String(url), init: (init ?? {}) as CapturedCall["init"] };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

const EMPTY_HASH = sha256Hex(new Uint8Array(0));

const KEY = "staging/abcd.tkp1.gz";

function streamOf(chunks: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const n of chunks) controller.enqueue(new Uint8Array(n));
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function upload(payload: Uint8Array<ArrayBuffer>, chunks: Uint8Array<ArrayBuffer>[] = [payload]) {
  return {
    body: new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    size: payload.byteLength,
    sha256: new Uint8Array(createHash("sha256").update(payload).digest()),
  };
}

describe("R2BlobStore.get bounded download", () => {
  // The staged object is the uploader-controlled blob, so `get` must cap
  // the download like the canonical path's getStream: a declared
  // content-length over the cap rejects before reading, and a chunked
  // stream errors once the running total passes the cap. The cap is set
  // explicitly small here (10 bytes) so removing it from `get` fails
  // these tests instead of passing silently at the 64 MiB default.
  test("returns bytes and checksum when under the explicit cap", async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const { fetch } = capturingFetch(
      () =>
        new Response(data, {
          status: 200,
          headers: { "x-amz-checksum-sha256": "abc==" },
        }),
    );
    const store = new R2BlobStore(CFG, { fetch, now: () => NOW, maxBytes: 10 });
    const got = await store.get(KEY);
    expect(await readAll(got!.body)).toEqual(data);
    expect(got?.checksumSha256).toBe("abc==");
  });

  test("streams chunked bodies without a content-length", async () => {
    const { fetch } = capturingFetch(() => new Response(streamOf([3, 4]), { status: 200 }));
    const store = new R2BlobStore(CFG, { fetch, now: () => NOW, maxBytes: 10 });
    const got = await store.get(KEY);
    expect(await readAll(got!.body)).toEqual(new Uint8Array(7));
  });

  test("errors the stream once streamed chunks exceed the cap", async () => {
    // A fresh stub per call: a consumed stream cannot be re-read.
    const makeStore = () => {
      const { fetch } = capturingFetch(() => new Response(streamOf([6, 6]), { status: 200 }));
      return new R2BlobStore(CFG, { fetch, now: () => NOW, maxBytes: 10 });
    };
    await expect(readAll((await makeStore().get(KEY))!.body)).rejects.toBeInstanceOf(BlobTooLargeError);
    await expect(readAll((await makeStore().get(KEY))!.body)).rejects.toThrow(/exceeds 10 bytes/);
  });

  test("rejects on a declared content-length over the cap", async () => {
    const { fetch } = capturingFetch(
      () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-length": "999" },
        }),
    );
    const store = new R2BlobStore(CFG, { fetch, now: () => NOW, maxBytes: 10 });
    await expect(store.get(KEY)).rejects.toBeInstanceOf(BlobTooLargeError);
  });
});

describe("R2BlobStore signing", () => {
  test("GET signs the canonical request for a fixed date", async () => {
    const { fetch, calls } = capturingFetch(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "x-amz-checksum-sha256": "abc==" },
        }),
    );
    const store = new R2BlobStore(CFG, { fetch, now: () => NOW });
    const got = await store.get("poses/abcd.tkp1.gz");

    expect(await readAll(got!.body)).toEqual(new Uint8Array([1, 2, 3]));
    expect(got?.checksumSha256).toBe("abc==");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`https://${HOST}/turnip-farm/poses/abcd.tkp1.gz`);
    expect(call.init.method).toBe("GET");
    const headers = call.init.headers!;
    expect(headers["x-amz-date"]).toBe("20261028T120000Z");
    expect(headers["x-amz-content-sha256"]).toBe(EMPTY_HASH);
    const expected = expectedAuthorization(
      "GET",
      "/turnip-farm/poses/abcd.tkp1.gz",
      {},
      { host: HOST, "x-amz-content-sha256": EMPTY_HASH, "x-amz-date": "20261028T120000Z" },
      EMPTY_HASH,
      NOW,
    );
    expect(headers["authorization"]).toBe(expected);
  });

  test("signature is stable for fixed inputs (regression pin)", async () => {
    const { fetch, calls } = capturingFetch(() => new Response(null, { status: 404 }));
    const store = new R2BlobStore(CFG, { fetch, now: () => NOW });
    await expect(store.get("poses/abcd.tkp1.gz")).resolves.toBeNull();
    const auth = calls[0]!.init.headers!["authorization"]!;
    expect(auth).toMatch(/Signature=([0-9a-f]{64})$/);
    expect(auth.split("Signature=")[1]).toBe(
      "135b3f29ac31acdf20bf51b2a591b475ec95a61d83a623aaeab2632d38b81ba2",
    );
  });

  test("PUT signs content-type and the checksum header, and streams the body with its length", async () => {
    const payload = new TextEncoder().encode("hi");
    const { fetch, calls } = capturingFetch(() => new Response(null, { status: 200 }));
    const store = new R2BlobStore(CFG, { fetch, now: () => NOW });
    await store.put("staging/x.tkp1.gz", upload(payload, [payload.slice(0, 1), payload.slice(1)]), "application/octet-stream");

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.init.method).toBe("PUT");
    const headers = call.init.headers!;
    const checksum = Buffer.from(createHash("sha256").update(payload).digest()).toString("base64");
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers["x-amz-checksum-sha256"]).toBe(checksum);
    const payloadHash = sha256Hex(payload);
    expect(headers["x-amz-content-sha256"]).toBe(payloadHash);
    expect(headers["authorization"]).toBe(
      expectedAuthorization(
        "PUT",
        "/turnip-farm/staging/x.tkp1.gz",
        {},
        {
          host: HOST,
          "content-type": "application/octet-stream",
          "x-amz-content-sha256": payloadHash,
          "x-amz-checksum-sha256": checksum,
          "x-amz-date": "20261028T120000Z",
        },
        payloadHash,
        NOW,
      ),
    );
    expect(headers["content-length"]).toBe("2");
    expect(await readAll(call.init.body as ReadableStream<Uint8Array>)).toEqual(payload);
  });

  test("PUT refuses a body longer than its declared size", async () => {
    const { fetch, calls } = capturingFetch(() => new Response(null, { status: 200 }));
    const store = new R2BlobStore(CFG, { fetch, now: () => NOW });
    const payload = new TextEncoder().encode("hi");
    await store.put("staging/x.tkp1.gz", { ...upload(payload), size: 1 }, "application/gzip");
    await expect(readAll(calls[0]!.init.body as ReadableStream<Uint8Array>)).rejects.toThrow(/body exceeds 1 bytes/);
  });

  test("path segments are encoded and slashes stay separators", async () => {
    const { fetch, calls } = capturingFetch(() => new Response(null, { status: 404 }));
    const store = new R2BlobStore(CFG, { fetch, now: () => NOW });
    await store.get("sp ace/uni-é/file+name?.bin");
    await store.get("a~b/c.d");

    expect(calls[0]!.url).toBe(`https://${HOST}/turnip-farm/sp%20ace/uni-%C3%A9/file%2Bname%3F.bin`);
    expect(calls[1]!.url).toBe(`https://${HOST}/turnip-farm/a~b/c.d`);
  });

  test("DELETE resolves on 404 and throws R2Error on failure", async () => {
    const { fetch, calls } = capturingFetch((_, i) =>
      i === 0 ? new Response(null, { status: 404 }) : new Response("nope", { status: 500 }),
    );
    const store = new R2BlobStore(CFG, { fetch, now: () => NOW });
    await expect(store.delete("poses/gone.tkp1.gz")).resolves.toBeUndefined();
    await expect(store.delete("poses/bad.tkp1.gz")).rejects.toThrow(/R2 DELETE failed: HTTP 500/);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(calls[1]!.init.method).toBe("DELETE");
  });
});

describe("R2BlobStore.listPages", () => {
  const pageXml = (keys: string[], truncated: boolean, token?: string): string =>
    `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}` +
    `<IsTruncated>${truncated}</IsTruncated>` +
    (token ? `<NextContinuationToken>${token}</NextContinuationToken>` : "") +
    `</ListBucketResult>`;

  test("yields one page at a time and follows the continuation token", async () => {
    const urls: string[] = [];
    const fetchStub = (async (url: unknown) => {
      urls.push(String(url));
      const second = String(url).includes("continuation-token");
      return new Response(
        second
          ? pageXml(["staging/c"], false)
          : pageXml(["staging/a", "staging/b"], true, "tok-2"),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const store = new R2BlobStore(CFG, { fetch: fetchStub });

    const pages: string[][] = [];
    for await (const page of store.listPages("staging/")) pages.push(page);

    expect(pages).toEqual([["staging/a", "staging/b"], ["staging/c"]]);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("continuation-token=tok-2");
  });

  test("stops fetching once the consumer stops iterating", async () => {
    let calls = 0;
    const fetchStub = (async () => {
      calls++;
      return new Response(pageXml(["staging/a"], true, "tok-2"), { status: 200 });
    }) as unknown as typeof fetch;
    const store = new R2BlobStore(CFG, { fetch: fetchStub });

    for await (const _page of store.listPages("staging/")) break;

    expect(calls).toBe(1);
  });

  test("a failed listing page throws R2Error", async () => {
    const { fetch } = capturingFetch(() => new Response(null, { status: 500 }));
    const store = new R2BlobStore(CFG, { fetch });
    await expect(
      (async () => {
        for await (const _page of store.listPages("staging/")) {
          // consume
        }
      })(),
    ).rejects.toThrow(/R2 LIST failed: HTTP 500/);
  });
});
