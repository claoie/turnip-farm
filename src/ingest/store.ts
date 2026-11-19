// Blob storage behind an interface, with the R2 (S3-compatible) production
// implementation. The ingest worker only depends on BlobStore, so tests
// substitute an in-memory fake.

import { cappedBody, capStream, MAX_CANONICAL_BLOB_BYTES } from "../r2/client";

export interface StoredObject {
  /**
   * The object's bytes, capped at the store's maxBytes: past it the
   * stream errors with BlobTooLargeError (get rejects with it outright
   * when the declared length is already over).
   */
  body: ReadableStream<Uint8Array<ArrayBuffer>>;
  // Base64 SHA-256 the object was stored with (x-amz-checksum-sha256),
  // when the object carries one.
  checksumSha256: string | null;
}

export interface BlobUpload {
  body: ReadableStream<Uint8Array<ArrayBuffer>>;
  /** Exact byte length of `body`. */
  size: number;
  /** SHA-256 of `body`; the store refuses the write when the bytes differ. */
  sha256: Uint8Array<ArrayBuffer>;
}

export interface BlobStore {
  get(key: string): Promise<StoredObject | null>;
  put(key: string, upload: BlobUpload, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * List keys under `prefix`, one listing page at a time. Callers must
   * process each page as it arrives and must not accumulate pages: the
   * staging prefix is unbounded, so holding the whole listing in memory
   * grows with every object no poll will ever touch. A page holds at
   * most 1000 keys (the listing's `max-keys`).
   */
  listPages(prefix: string): AsyncIterable<string[]>;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export class R2Error extends Error {
  constructor(readonly status: number, readonly operation: string, message: string) {
    super(`R2 ${operation} failed: HTTP ${status}: ${message}`);
    this.name = "R2Error";
  }
}

const SERVICE = "s3";
const REGION = "auto"; // R2's SigV4 region
const TERMINATOR = "aws4_request";

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  const dateStamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const amzDate =
    `${dateStamp}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  return { amzDate, dateStamp };
}

async function hmac(key: Uint8Array<ArrayBuffer> | string, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const raw: Uint8Array<ArrayBuffer> = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)));
}

async function sha256HexBytes(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest).toString("hex");
}

const EMPTY_PAYLOAD_SHA256 = new Bun.CryptoHasher("sha256").digest("hex");

function encodePathSegment(s: string): string {
  return encodeURIComponent(s).replaceAll("%7E", "~");
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

// Minimal SigV4 signer for R2's S3-compatible API. `now` is injected so
// tests can pin the signature against a fixed date; production passes the
// current time (see R2BlobStore).
async function signRequest(
  cfg: R2Config,
  method: string,
  key: string | null, // null for bucket-level (list) operations
  query: Record<string, string>,
  extraHeaders: Record<string, string>,
  payloadHash: string,
  now: Date,
): Promise<SignedRequest> {
  const { amzDate, dateStamp } = amzDates(now);
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;

  const path = key === null ? `/${cfg.bucket}` : `/${cfg.bucket}/${key.split("/").map(encodePathSegment).join("/")}`;
  const queryNames = Object.keys(query).sort();
  const canonicalQuery = queryNames
    .map((n) => `${encodeURIComponent(n)}=${encodeURIComponent(query[n]!)}`)
    .join("&");

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders,
  };
  const signedNames = Object.keys(headers).map((n) => n.toLowerCase()).sort();
  const canonicalHeaders = signedNames.map((n) => `${n}:${headers[n]!.trim()}\n`).join("");

  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedNames.join(";"),
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/${SERVICE}/${TERMINATOR}`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256HexBytes(new TextEncoder().encode(canonicalRequest))].join("\n");

  const kDate = await hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, SERVICE);
  const kSigning = await hmac(kService, TERMINATOR);
  const signature = Buffer.from(await hmac(kSigning, stringToSign)).toString("hex");

  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;

  const url = `https://${host}${path}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  return { url, headers };
}

export class R2BlobStore implements BlobStore {
  private readonly doFetch: typeof fetch;
  private readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(
    private readonly cfg: R2Config,
    opts: { fetch?: typeof fetch; maxBytes?: number; now?: () => Date } = {},
  ) {
    this.doFetch = opts.fetch ?? fetch;
    this.maxBytes = opts.maxBytes ?? MAX_CANONICAL_BLOB_BYTES;
    this.now = opts.now ?? (() => new Date());
  }

  async get(key: string): Promise<StoredObject | null> {
    const { url, headers } = await signRequest(this.cfg, "GET", key, {}, {}, EMPTY_PAYLOAD_SHA256, this.now());
    const res = await this.doFetch(url, { method: "GET", headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new R2Error(res.status, "GET", await res.text());
    // The staged object is the uploader-controlled blob the threat model
    // names (presigned PUTs cannot enforce content-length). The cap reuses
    // MAX_CANONICAL_BLOB_BYTES — a staged upload is at most 3x the
    // canonical rate, so 64 MiB still covers ~3 hours of footage.
    return {
      body: cappedBody(res, key, this.maxBytes),
      checksumSha256: res.headers.get("x-amz-checksum-sha256"),
    };
  }

  // The declared length and digest let R2 verify the streamed body: the
  // SigV4 payload hash and the stored checksum are both the body's SHA-256.
  async put(key: string, upload: BlobUpload, contentType: string): Promise<void> {
    const payloadHash = Buffer.from(upload.sha256).toString("hex");
    const { url, headers } = await signRequest(this.cfg, "PUT", key, {}, {
      "content-type": contentType,
      "x-amz-checksum-sha256": Buffer.from(upload.sha256).toString("base64"),
    }, payloadHash, this.now());
    const body = capStream(upload.body, upload.size, () => new Error(`R2 PUT ${key}: body exceeds ${upload.size} bytes`));
    const res = await this.doFetch(url, {
      method: "PUT",
      headers: { ...headers, "content-length": String(upload.size) },
      body,
    });
    if (!res.ok) throw new R2Error(res.status, "PUT", await res.text());
  }

  async delete(key: string): Promise<void> {
    const { url, headers } = await signRequest(this.cfg, "DELETE", key, {}, {}, EMPTY_PAYLOAD_SHA256, this.now());
    const res = await this.doFetch(url, { method: "DELETE", headers });
    if (res.status !== 404 && !res.ok) throw new R2Error(res.status, "DELETE", await res.text());
  }

  /**
   * Yield one listing page at a time instead of accumulating the whole
   * prefix: each page is fetched, yielded, and released before the next
   * is requested, so a poll holds at most one page (1000 keys) in
   * memory no matter how many objects sit under the prefix.
   */
  async *listPages(prefix: string): AsyncIterable<string[]> {
    let continuation: string | undefined;
    for (;;) {
      const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": "1000" };
      if (continuation !== undefined) query["continuation-token"] = continuation;
      const { url, headers } = await signRequest(this.cfg, "GET", null, query, {}, EMPTY_PAYLOAD_SHA256, this.now());
      const res = await this.doFetch(url, { method: "GET", headers });
      if (!res.ok) throw new R2Error(res.status, "LIST", await res.text());
      const xml = await res.text();
      yield [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]!);
      if (/<IsTruncated>true<\/IsTruncated>/.test(xml)) {
        const token = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
        if (!token) break;
        continuation = token[1];
      } else break;
    }
  }
}
