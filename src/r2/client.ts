// Minimal R2 client for the contribution endpoints (BACKEND_DESIGN.md
// §7.3): presigned upload/download URLs plus the two farm-side object
// operations the endpoints need — blob fetch for the §1.2.10 digest
// re-verification on clip submission, and blob delete on source delete.
// Reads/writes on the contribution endpoints go through presigned URLs
// (presign.ts). The ingest worker signs header-authenticated requests
// separately, in ingest/store.ts — that is the second SigV4 path.

import { presignGet, presignPut, presignUrl, type PresignedUrl, type R2Config } from "./presign";

export type { PresignedUrl, R2Config };

export interface R2Client {
  presignPut(key: string): PresignedUrl;
  presignGet(key: string): PresignedUrl;
  /**
   * The object's bytes as a stream, or null when the key does not exist.
   * Hard-capped at `opts.maxBytes` (default MAX_CANONICAL_BLOB_BYTES): a
   * key-holding contributor can PUT an arbitrarily large blob to their
   * presigned staging URL (presigned PUTs cannot enforce content-length).
   * Rejects with BlobTooLargeError when the declared length is over the
   * cap, and errors the stream with it once the bytes read pass the cap.
   */
  getStream(key: string, opts?: { maxBytes?: number }): Promise<ReadableStream<Uint8Array<ArrayBuffer>> | null>;
  /** Deleting a missing key is a no-op. */
  deleteObject(key: string): Promise<void>;
}

/** Thrown, or raised by the stream, when a blob exceeds the reader's maxBytes. */
export class BlobTooLargeError extends Error {
  constructor(
    readonly key: string,
    readonly maxBytes: number,
  ) {
    super(`R2 GET ${key}: blob exceeds ${maxBytes} bytes`);
    this.name = "BlobTooLargeError";
  }
}

/**
 * Largest canonical blob the farm reads or stores. Judgment call, grounded
 * in POSE_FORMAT.md §8: a canonical blob is ~2,040 bytes/s at 10 Hz (≈122 KB
 * for a 60-second session, gzip shrinking a further 5–25%), so 64 MiB is
 * roughly ten hours of tricking footage — two orders of magnitude above any
 * legit session. Anything larger is never legit. Blobs are streamed, never
 * held whole, so the cap bounds bytes moved, not memory.
 */
export const MAX_CANONICAL_BLOB_BYTES = 64 * 1024 * 1024;

/**
 * A blob download's body, capped at `maxBytes` without buffering it.
 * The declared length is checked first; headers can lie, so the bytes
 * are still counted as they pass, and the stream errors past the cap.
 */
export function cappedBody(res: Response, key: string, maxBytes: number): ReadableStream<Uint8Array<ArrayBuffer>> {
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    void res.body?.cancel().catch(() => {});
    throw new BlobTooLargeError(key, maxBytes);
  }
  const body = res.body ?? new ReadableStream<Uint8Array<ArrayBuffer>>({ start: (controller) => controller.close() });
  return capStream(body, maxBytes, () => new BlobTooLargeError(key, maxBytes));
}

/** `body`, erroring with `tooLarge()` (and cancelling `body`) once more than `maxBytes` pass through. */
export function capStream(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  maxBytes: number,
  tooLarge: () => Error,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) controller.error(tooLarge());
        else controller.enqueue(chunk);
      },
    }),
  );
}

export function createR2Client(
  cfg: R2Config,
  opts: { now?: () => Date; fetch?: typeof fetch } = {},
): R2Client {
  const now = opts.now ?? (() => new Date());
  const doFetch = opts.fetch ?? fetch;
  return {
    presignPut: (key) => presignPut(cfg, key, now()),
    presignGet: (key) => presignGet(cfg, key, now()),
    getStream: async (key, opts = {}) => {
      const maxBytes = opts.maxBytes ?? MAX_CANONICAL_BLOB_BYTES;
      const { url } = presignUrl(cfg, "GET", key, 60, now());
      const res = await doFetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status}`);
      return cappedBody(res, key, maxBytes);
    },
    deleteObject: async (key) => {
      const { url } = presignUrl(cfg, "DELETE", key, 60, now());
      const res = await doFetch(url, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        throw new Error(`R2 DELETE ${key} failed: ${res.status}`);
      }
    },
  };
}
