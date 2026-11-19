import { constants, crc32, deflateRawSync } from "node:zlib";
import { MAX_CANONICAL_BLOB_BYTES } from "../r2/client";
import {
  CANONICAL_HZ,
  type DecodedTkp1,
  decodeTkp1Header,
  MAX_SOURCE_HZ,
  MIN_SOURCE_HZ,
  TKP1_FRAME_BYTES,
  TKP1_HEADER_BYTES,
  TKP1_KEYPOINT_COUNT,
  TKP1_VERSION,
  Tkp1Error,
  isGapFrame,
} from "./tkp1-codec";

// TKP1 pose-blob codec and canonical 10 Hz resampling (POSE_FORMAT.md).
// Decoding lives in tkp1-codec.ts, which the web client shares, and is
// re-exported here. canonicalizeStaged runs the whole ingest transform as a
// stream, so a staged upload is never held whole; the batch functions are
// its reference form. The ingest worker (worker.ts) wires these to R2 and
// Postgres.

export * from "./tkp1-codec";

function encodeTkp1Header(frameCount: number, sourceSampleRateHz: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(TKP1_HEADER_BYTES);
  const view = new DataView(out.buffer);
  out[0] = 0x54; out[1] = 0x4b; out[2] = 0x50; out[3] = 0x31; // "TKP1"
  view.setUint16(4, TKP1_VERSION, true);
  view.setUint16(6, TKP1_KEYPOINT_COUNT, true);
  view.setUint32(8, frameCount, true);
  view.setFloat32(12, CANONICAL_HZ, true);
  view.setFloat32(16, sourceSampleRateHz, true);
  view.setUint32(20, 0, true);
  return out;
}

export function encodeTkp1(decoded: DecodedTkp1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(TKP1_HEADER_BYTES + TKP1_FRAME_BYTES * decoded.frameCount);
  out.set(encodeTkp1Header(decoded.frameCount, decoded.sourceSampleRateHz));
  for (let i = 0; i < decoded.frameCount; i++) {
    out.set(decoded.frames[i]!, TKP1_HEADER_BYTES + i * TKP1_FRAME_BYTES);
  }
  return out;
}

/**
 * Resamples to the canonical 10 Hz grid (POSE_FORMAT.md §6) one source
 * frame at a time, holding only the previous frame. The output header
 * carries sample_rate_hz = 10 and preserves the as-sent rate in
 * source_sample_rate_hz. Gaps break interpolation: a canonical frame
 * touching a gap frame on either side is itself a gap.
 */
export class CanonicalResampler {
  /** How many canonical frames the whole source yields. */
  readonly outCount: number;
  private emitted = 0;
  private pushed = 0;
  private previous: Uint8Array<ArrayBuffer> | null = null;

  constructor(
    private readonly rateHz: number,
    frameCount: number,
  ) {
    if (!(rateHz >= MIN_SOURCE_HZ && rateHz <= MAX_SOURCE_HZ)) {
      throw new Tkp1Error(`source_sample_rate_hz ${rateHz} outside ${MIN_SOURCE_HZ}..${MAX_SOURCE_HZ}`);
    }
    // Exactly 10 Hz: the grid coincides with the source frames, so this is
    // a byte-identical passthrough (no float rounding through interpolation).
    this.outCount = rateHz === CANONICAL_HZ
      ? frameCount
      : Math.floor(((frameCount - 1) / rateHz) * CANONICAL_HZ) + 1;
  }

  /** The canonical frames that `frame`, the next source frame in order, completes. */
  push(frame: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[] {
    const j = this.pushed++;
    const out: Uint8Array<ArrayBuffer>[] = [];
    while (this.emitted < this.outCount) {
      const p = this.position(this.emitted);
      if (p > j) break;
      // Every earlier position was emitted with an earlier frame, so
      // j - 1 < p <= j: p lands on this frame or between it and the last.
      const frac = p - Math.floor(p);
      if (frac === 0) {
        out.push(frame.slice());
      } else if (isGapFrame(this.previous!) || isGapFrame(frame)) {
        out.push(new Uint8Array(TKP1_FRAME_BYTES));
      } else {
        out.push(interpolateFrame(this.previous!, frame, frac));
      }
      this.emitted++;
    }
    this.previous = frame;
    return out;
  }

  /** Throws unless every canonical frame was emitted. */
  finish(): void {
    if (this.emitted !== this.outCount) {
      throw new Tkp1Error(`resampled ${this.emitted} of ${this.outCount} canonical frames`);
    }
  }

  // p = t * r with t = k/10; computed as (k*r)/10 so integer rates hit
  // exact integers, then snapped to kill float dust near integers.
  private position(k: number): number {
    if (this.rateHz === CANONICAL_HZ) return k;
    const p = (k * this.rateHz) / CANONICAL_HZ;
    const nearest = Math.round(p);
    return Math.abs(p - nearest) <= 1e-9 * Math.max(1, Math.abs(p)) ? nearest : p;
  }
}

export function resampleToCanonical10Hz(decoded: DecodedTkp1): DecodedTkp1 {
  const resampler = new CanonicalResampler(decoded.sourceSampleRateHz, decoded.frameCount);
  const frames: Uint8Array<ArrayBuffer>[] = [];
  for (const frame of decoded.frames) {
    for (const out of resampler.push(frame)) frames.push(out);
  }
  resampler.finish();
  return { frameCount: resampler.outCount, sourceSampleRateHz: decoded.sourceSampleRateHz, frames };
}

const CANONICAL_NAN_BITS = 0x7fc00000;

function interpolateFrame(
  a: Uint8Array<ArrayBuffer>,
  b: Uint8Array<ArrayBuffer>,
  frac: number,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(TKP1_FRAME_BYTES);
  const va = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const vb = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const vo = new DataView(out.buffer);
  for (let c = 0; c < TKP1_KEYPOINT_COUNT * 3; c++) {
    const v = (1 - frac) * va.getFloat32(c * 4, true) + frac * vb.getFloat32(c * 4, true);
    // setFloat32 may write any NaN encoding, and two reads of one upload got
    // different ones; one fixed NaN keeps the canonical bytes reproducible.
    if (Number.isNaN(v)) vo.setUint32(c * 4, CANONICAL_NAN_BITS, true);
    else vo.setFloat32(c * 4, v, true);
  }
  return out;
}

// The canonical blob is deflated in blocks of this size, each on its own, so
// its bytes depend on the blob alone: every read of an upload yields the same
// bytes, whatever the staged stream's chunking or timing. A streaming
// compressor doesn't promise that: CompressionStream's output shifts with
// how fast blocks reach it.
const GZIP_BLOCK_BYTES = 64 * 1024;

// RFC 1952 member header: deflate, no flags, mtime 0, OS unknown.
const GZIP_HEADER = [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff];

/**
 * The canonical `.tkp1.gz` for a staged upload, produced as it is read:
 * gunzip under a hard output cap (a zip bomb fails at the cap, not after
 * expanding), decode fail-closed, resample to 10 Hz, encode, gzip
 * (mtime = 0). Memory stays at a few blocks whatever the upload's size.
 * Reading it fails with Tkp1Error for an invalid upload, or with the
 * staged stream's own error when that fails.
 */
export function canonicalizeStaged(
  staged: ReadableStream<Uint8Array<ArrayBuffer>>,
  opts: { maxBytes?: number } = {},
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const chunks = gzipBlocks(canonicalBlocks(gunzipCapped(staged, opts.maxBytes ?? MAX_CANONICAL_BLOB_BYTES)));
  return new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      async pull(controller) {
        const { done, value } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      async cancel() {
        await chunks.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

// One gzip member around the blocks' deflate output. Each block is
// sync-flushed rather than finished, so the next block's data continues the
// same deflate stream, and a final empty block ends it.
async function* gzipBlocks(blocks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  yield new Uint8Array(GZIP_HEADER);
  let crc = 0;
  let size = 0;
  for await (const block of blocks) {
    crc = crc32(block, crc);
    size += block.byteLength;
    yield new Uint8Array(deflateRawSync(block, { finishFlush: constants.Z_SYNC_FLUSH }));
    // Already-buffered staged bytes keep this loop in microtasks; give requests a turn per block.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const end = deflateRawSync(new Uint8Array(0));
  const trailer = new Uint8Array(end.byteLength + 8);
  trailer.set(end);
  const view = new DataView(trailer.buffer);
  view.setUint32(end.byteLength, crc >>> 0, true);
  view.setUint32(end.byteLength + 4, size >>> 0, true);
  yield trailer;
}

async function* gunzipCapped(
  staged: ReadableStream<Uint8Array<ArrayBuffer>>,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  const source = staged.getReader();
  const failure: { error?: unknown; failed: boolean } = { failed: false };
  const watched = new ReadableStream<BufferSource>(
    {
      async pull(controller) {
        try {
          const { done, value } = await source.read();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (error) {
          failure.failed = true;
          failure.error = error;
          controller.error(error);
        }
      },
      cancel: (reason) => source.cancel(reason),
    },
    { highWaterMark: 0 },
  );
  let total = 0;
  try {
    for await (const chunk of watched.pipeThrough(new DecompressionStream("gzip"))) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new Tkp1Error(`staged decompressed size exceeds ${maxBytes} bytes`);
      yield chunk;
    }
  } catch (err) {
    if (failure.failed) throw failure.error;
    if (err instanceof Tkp1Error) throw err;
    throw new Tkp1Error("staged object is not valid gzip");
  }
}

// The canonical TKP1 bytes for a decompressed staged stream, in blocks of
// GZIP_BLOCK_BYTES (the last one shorter).
async function* canonicalBlocks(tkp1: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  let block = new Uint8Array(GZIP_BLOCK_BYTES);
  let blockFill = 0;
  function* write(bytes: Uint8Array): Generator<Uint8Array<ArrayBuffer>> {
    for (let off = 0; off < bytes.byteLength; ) {
      const n = Math.min(GZIP_BLOCK_BYTES - blockFill, bytes.byteLength - off);
      block.set(bytes.subarray(off, off + n), blockFill);
      blockFill += n;
      off += n;
      if (blockFill === GZIP_BLOCK_BYTES) {
        yield block;
        block = new Uint8Array(GZIP_BLOCK_BYTES);
        blockFill = 0;
      }
    }
  }

  const header = new Uint8Array(TKP1_HEADER_BYTES);
  let size = 0;
  let resampler: CanonicalResampler | null = null;
  let frameCount = 0;
  let frames = 0;
  let frame = new Uint8Array(TKP1_FRAME_BYTES);
  let frameFill = 0;
  for await (const chunk of tkp1) {
    let off = 0;
    if (size < TKP1_HEADER_BYTES) {
      off = Math.min(TKP1_HEADER_BYTES - size, chunk.byteLength);
      header.set(chunk.subarray(0, off), size);
    }
    size += chunk.byteLength;
    if (resampler === null) {
      if (size < TKP1_HEADER_BYTES) continue;
      const decoded = decodeTkp1Header(header);
      frameCount = decoded.frameCount;
      resampler = new CanonicalResampler(decoded.sourceSampleRateHz, frameCount);
      yield* write(encodeTkp1Header(resampler.outCount, decoded.sourceSampleRateHz));
    }
    // Bytes past the last frame are only counted: the size check below rejects them.
    while (off < chunk.byteLength && frames < frameCount) {
      const n = Math.min(TKP1_FRAME_BYTES - frameFill, chunk.byteLength - off);
      frame.set(chunk.subarray(off, off + n), frameFill);
      frameFill += n;
      off += n;
      if (frameFill < TKP1_FRAME_BYTES) break;
      for (const out of resampler.push(frame)) yield* write(out);
      frames++;
      frame = new Uint8Array(TKP1_FRAME_BYTES);
      frameFill = 0;
    }
  }
  if (resampler === null) throw new Tkp1Error(`too short for a header (${size} bytes)`);
  const expected = TKP1_HEADER_BYTES + TKP1_FRAME_BYTES * frameCount;
  if (size !== expected) {
    throw new Tkp1Error(`size ${size} != 24 + 204*${frameCount} (${expected})`);
  }
  resampler.finish();
  if (blockFill > 0) yield block.slice(0, blockFill);
}
