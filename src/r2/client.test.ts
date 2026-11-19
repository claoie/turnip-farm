// Bounded getStream for the contribution endpoints.
// Pure unit tests (no DB): the fetch is stubbed, the SigV4 URL is real but
// never leaves the process.

import { describe, expect, test } from "bun:test";
import {
  BlobTooLargeError,
  MAX_CANONICAL_BLOB_BYTES,
  createR2Client,
} from "./client";

const CFG = {
  accountId: "123456789012",
  accessKeyId: "test-access-key-id",
  secretAccessKey: "test-secret-access-key",
  bucket: "turnip-farm",
};
// Synthetic credentials (never live); SigV4 output is pinned in
// presign.test.ts.

const KEY = "poses/abcd.tkp1.gz";

type RespBody = ConstructorParameters<typeof Response>[0];

type FakeFetch = (
  body: RespBody,
  init?: { status?: number; headers?: Record<string, string> },
) => typeof fetch;

function stubFetch(
  body: RespBody,
  init: { status?: number; headers?: Record<string, string> } = {},
): ReturnType<FakeFetch> {
  return (async (_url: unknown) =>
    new Response(body, {
      status: init.status ?? 200,
      headers: init.headers,
    })) as unknown as ReturnType<FakeFetch>;
}

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

describe("getStream", () => {
  test("streams the bytes when under the cap", async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const r2 = createR2Client(CFG, { fetch: stubFetch(data) });
    const got = await r2.getStream(KEY, { maxBytes: 10 });
    expect(await readAll(got!)).toEqual(data);
  });

  test("streams chunked bodies without a content-length", async () => {
    const r2 = createR2Client(CFG, { fetch: stubFetch(streamOf([3, 4])) });
    const got = await r2.getStream(KEY, { maxBytes: 10 });
    expect(await readAll(got!)).toEqual(new Uint8Array(7));
  });

  test("fast-rejects when content-length already exceeds the cap", async () => {
    const r2 = createR2Client(CFG, {
      fetch: stubFetch(new Uint8Array(0), {
        headers: { "content-length": "100" },
      }),
    });
    const err = await r2.getStream(KEY, { maxBytes: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(BlobTooLargeError);
    expect((err as BlobTooLargeError).key).toBe(KEY);
    expect((err as BlobTooLargeError).maxBytes).toBe(10);
  });

  test("errors the stream when the declared length lies", async () => {
    const r2 = createR2Client(CFG, {
      fetch: stubFetch(streamOf([8, 8]), {
        headers: { "content-length": "4" },
      }),
    });
    const got = await r2.getStream(KEY, { maxBytes: 10 });
    await expect(readAll(got!)).rejects.toBeInstanceOf(BlobTooLargeError);
  });

  test("stops reading the body once the cap is passed", async () => {
    let pulled = 0;
    let cancelled = false;
    const long = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++pulled > 1000) controller.close();
        else controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });
    const r2 = createR2Client(CFG, { fetch: stubFetch(long) });
    const got = await r2.getStream(KEY, { maxBytes: 10 });
    await expect(readAll(got!)).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  test("accepts a blob exactly at the cap", async () => {
    const r2 = createR2Client(CFG, { fetch: stubFetch(new Uint8Array(10)) });
    const got = await r2.getStream(KEY, { maxBytes: 10 });
    expect(await readAll(got!)).toEqual(new Uint8Array(10));
  });

  test("defaults to MAX_CANONICAL_BLOB_BYTES", async () => {
    expect(MAX_CANONICAL_BLOB_BYTES).toBe(64 * 1024 * 1024);
    const declaring = (n: number) =>
      createR2Client(CFG, {
        fetch: stubFetch(new Uint8Array(0), { headers: { "content-length": String(n) } }),
      });
    await expect(declaring(MAX_CANONICAL_BLOB_BYTES + 1).getStream(KEY)).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(await declaring(MAX_CANONICAL_BLOB_BYTES).getStream(KEY)).not.toBeNull();
  });

  test("returns null on 404", async () => {
    const r2 = createR2Client(CFG, { fetch: stubFetch(null, { status: 404 }) });
    expect(await r2.getStream(KEY)).toBeNull();
  });

  test("throws on non-404 error statuses", async () => {
    const r2 = createR2Client(CFG, { fetch: stubFetch(null, { status: 500 }) });
    await expect(r2.getStream(KEY)).rejects.toThrow(/R2 GET .* failed: 500/);
  });
});
