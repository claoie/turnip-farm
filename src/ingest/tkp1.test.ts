// Conformance tests for the TKP1 codec and canonical resampling,
// checked against the POSE_FORMAT.md §11 test vectors.
import { describe, expect, test } from "bun:test";
import { BlobTooLargeError } from "../r2/client";
import {
  canonicalizeStaged,
  decodeTkp1,
  encodeTkp1,
  isGapFrame,
  resampleToCanonical10Hz,
  Tkp1Error,
  type DecodedTkp1,
} from "./tkp1";

type Triple = [number, number, number];

function makeBlob(n: number, rateHz: number, fill: (frame: number, kp: number) => Triple): Uint8Array<ArrayBuffer> {
  const frames: Uint8Array<ArrayBuffer>[] = [];
  for (let i = 0; i < n; i++) {
    const f = new Uint8Array(204);
    const v = new DataView(f.buffer);
    for (let k = 0; k < 17; k++) {
      const [x, y, c] = fill(i, k);
      v.setFloat32(k * 12, x, true);
      v.setFloat32(k * 12 + 4, y, true);
      v.setFloat32(k * 12 + 8, c, true);
    }
    frames.push(f);
  }
  return encodeTkp1({ frameCount: n, sourceSampleRateHz: rateHz, frames });
}

function channel(frame: Uint8Array<ArrayBuffer>, kp: number, ch: number): number {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getFloat32(kp * 12 + ch * 4, true);
}

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

// The §11.1 worked example: 3 frames at 10 Hz, frame 1 a gap.
function section111(): Uint8Array<ArrayBuffer> {
  return makeBlob(3, 10, (i, k) => {
    if (i === 1) return [0, 0, 0];
    if (k === 0) return i === 0 ? [0.5, 0.2, 0.95] : [0.51, 0.21, 0.94];
    if (k === 5) return i === 0 ? [0.45, 0.35, 0.9] : [0.46, 0.36, 0.89];
    return [0, 0, 0];
  });
}

const MUTATIONS: [string, (b: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>][] = [
  ["bad magic", (b: Uint8Array<ArrayBuffer>) => { b[0] = 0x58; return b; }],
  ["format_version 2", (b: Uint8Array<ArrayBuffer>) => { b[4] = 2; return b; }],
  ["keypoint_count 16", (b: Uint8Array<ArrayBuffer>) => { b[6] = 16; return b; }],
  ["flags 1", (b: Uint8Array<ArrayBuffer>) => { b[20] = 1; return b; }],
  ["frame_count 0", (b: Uint8Array<ArrayBuffer>) => { b[8] = 0; return b; }],
  ["truncated", (b: Uint8Array<ArrayBuffer>) => b.slice(0, b.length - 10)],
  ["trailing byte", (b: Uint8Array<ArrayBuffer>) => { const c = new Uint8Array(b.length + 1); c.set(b); return c; }],
  ["empty", () => new Uint8Array(0)],
];

describe("TKP1 codec", () => {
  test("§11.1: encoder output digest matches the spec vector", () => {
    expect(sha256Hex(section111())).toBe(
      "37ba29d3c206f3b9dd41219e29354c480791d000533efdfc8096ee6f0959cac9",
    );
  });

  test("§11.2: decoder reports 3 frames with frame 1 missing", () => {
    const d = decodeTkp1(section111());
    expect(d.frameCount).toBe(3);
    expect(d.sourceSampleRateHz).toBe(10);
    expect(isGapFrame(d.frames[0]!)).toBe(false);
    expect(isGapFrame(d.frames[1]!)).toBe(true);
    expect(isGapFrame(d.frames[2]!)).toBe(false);
    expect(channel(d.frames[0]!, 0, 0)).toBeCloseTo(0.5, 6);
  });

  test("round-trip preserves bytes", () => {
    const blob = makeBlob(7, 24, (i, k) => [i * 0.01 + k * 0.001, 0.5 - i * 0.01, 0.9]);
    expect(encodeTkp1(decodeTkp1(blob))).toEqual(blob);
  });

  test.each(MUTATIONS)("fail-closed on %s", (_, mutate) => {
    expect(() => decodeTkp1(mutate(section111()))).toThrow(Tkp1Error);
  });

});

// A staged upload as R2 hands it over: gzipped, in chunks of `chunk` bytes.
function staged(gz: Uint8Array, chunk: number = 65536): ReadableStream<Uint8Array<ArrayBuffer>> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= gz.length) return controller.close();
      controller.enqueue(gz.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("canonicalizeStaged", () => {
  // ~200 KB of frames: several of the 64 KiB blocks gzip is fed.
  const motion = (i: number, k: number): Triple => [Math.sin(i / 7 + k) * 0.5, Math.cos(i / 5 + k) * 0.5, i % 13 === 0 ? 0 : 0.9];

  test.each([
    [10, 1000],
    [30, 1000],
    [24, 997],
    [25, 1000],
    [29.97, 1001],
    [5, 400],
    [1, 120],
  ])("%p Hz: the batch transform's bytes, gzipped the same whatever the staged chunking", async (rate, n) => {
    const blob = makeBlob(n, rate, motion);
    const expected = encodeTkp1(resampleToCanonical10Hz(decodeTkp1(blob)));
    const gz = Bun.gzipSync(blob);
    const outputs = [];
    for (const chunk of [7, 333, 65536, gz.length]) outputs.push(await readAll(canonicalizeStaged(staged(gz, chunk))));
    expect(Bun.gunzipSync(outputs[0]!)).toEqual(expected);
    for (const output of outputs.slice(1)) expect(output).toEqual(outputs[0]!);
  });

  test("a single gzip member, mtime 0, that standard decoders read with its CRC and size checked", async () => {
    const blob = makeBlob(1000, 10, motion);
    const out = await readAll(canonicalizeStaged(staged(Bun.gzipSync(blob))));
    expect([...out.subarray(0, 8)]).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]);
    expect(Bun.gunzipSync(out)).toEqual(blob);
    expect(await readAll(new Blob([out]).stream().pipeThrough(new DecompressionStream("gzip")))).toEqual(blob);
    const corrupt = out.slice();
    corrupt[corrupt.length - 5]! ^= 1; // a CRC byte
    expect(() => Bun.gunzipSync(corrupt)).toThrow();
  });

  test("other work runs while a large blob is transformed", async () => {
    const gz = Bun.gzipSync(makeBlob(5000, 10, motion));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    try {
      // The whole upload is buffered, so only the transform itself can yield.
      await readAll(canonicalizeStaged(new Blob([gz]).stream()));
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(3);
  });

  test("an interpolated NaN is written as one fixed NaN", async () => {
    const blob = makeBlob(5, 24, (i, k) => (k === 0 ? [i === 2 ? NaN : 0.5, 0.2, 0.9] : [0, 0, 0.9]));
    const view = new DataView(blob.buffer);
    // A NaN with a nonstandard payload in frame 2's nose x.
    view.setUint32(24 + 2 * 204, 0x7fa00001, true);
    const out = Bun.gunzipSync(await readAll(canonicalizeStaged(staged(Bun.gzipSync(blob)))));
    // Canonical frame 1 sits at p = 2.4, between source frames 2 and 3.
    expect(new DataView(out.buffer).getUint32(24 + 204, true)).toBe(0x7fc00000);
  });

  test.each(MUTATIONS)("fail-closed on %s", async (_, mutate) => {
    const gz = Bun.gzipSync(mutate(section111()));
    await expect(readAll(canonicalizeStaged(staged(gz, 5)))).rejects.toBeInstanceOf(Tkp1Error);
  });

  test.each([0.5, 31])("rejects source rate %s Hz", async (r) => {
    const gz = Bun.gzipSync(makeBlob(4, r, (i, k) => (k === 0 ? [i * 0.1, 0.5, 0.9] : [0, 0, 0])));
    await expect(readAll(canonicalizeStaged(staged(gz)))).rejects.toBeInstanceOf(Tkp1Error);
  });

  test("rejects non-gzip", async () => {
    await expect(readAll(canonicalizeStaged(staged(new TextEncoder().encode("not gzip"))))).rejects.toThrow(
      "staged object is not valid gzip",
    );
  });

  test("rejects output over maxBytes without expanding it", async () => {
    // 1,000 zero bytes gzip to ~30 bytes: a zip bomb in miniature. With a
    // 10-byte cap the stream must fail once the expansion passes the cap.
    const bomb = Bun.gzipSync(new Uint8Array(1000));
    await expect(readAll(canonicalizeStaged(staged(bomb), { maxBytes: 10 }))).rejects.toThrow(/exceeds 10 bytes/);
  });

  test("accepts a blob that decompresses to exactly maxBytes", async () => {
    const blob = section111();
    const out = await readAll(canonicalizeStaged(staged(Bun.gzipSync(blob)), { maxBytes: blob.length }));
    expect(Bun.gunzipSync(out)).toEqual(blob);
  });

  test("the staged stream's own error passes through as itself", async () => {
    const failing = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(Bun.gzipSync(section111()).slice(0, 10));
        controller.error(new BlobTooLargeError("staging/x.tkp1.gz", 10));
      },
    });
    await expect(readAll(canonicalizeStaged(failing))).rejects.toBeInstanceOf(BlobTooLargeError);
  });
});

describe("canonical 10 Hz resampling (POSE_FORMAT.md §6)", () => {
  test("§11.3: 5 frames @24 Hz → 2 canonical frames", () => {
    // The spec's worked values: S[2].nose.x = 0.50, S[3].nose.x = 0.55.
    const xs = [0.4, 0.45, 0.5, 0.55, 0.6];
    const blob = makeBlob(5, 24, (i, k) => (k === 0 ? [xs[i]!, 0.2, 0.9] : [0, 0, 0]));
    const out = resampleToCanonical10Hz(decodeTkp1(blob));
    expect(out.frameCount).toBe(2);
    // Canonical frame 0 at t=0 → exactly source frame 0.
    expect(channel(out.frames[0]!, 0, 0)).toBeCloseTo(0.4, 6);
    // Canonical frame 1 at t=0.1 → p=2.4 → 0.6*S[2] + 0.4*S[3] = 0.52.
    expect(channel(out.frames[1]!, 0, 0)).toBeCloseTo(0.52, 5);
  });

  test("§11.3 gap variant: S[3] a gap → canonical frame 1 is a gap", () => {
    const blob = makeBlob(5, 24, (i, k) => (i === 3 || k !== 0 ? [0, 0, 0] : [0.5 + i * 0.05, 0.2, 0.9]));
    const out = resampleToCanonical10Hz(decodeTkp1(blob));
    expect(out.frameCount).toBe(2);
    expect(isGapFrame(out.frames[1]!)).toBe(true);
    // Not 0.6 * S[2]: no pose is synthesized across missing data.
    expect(channel(out.frames[1]!, 0, 0)).toBe(0);
  });

  test("gap on the left side also breaks interpolation", () => {
    const blob = makeBlob(5, 24, (i, k) => (i === 2 || k !== 0 ? [0, 0, 0] : [0.5 + i * 0.05, 0.2, 0.9]));
    const out = resampleToCanonical10Hz(decodeTkp1(blob));
    expect(isGapFrame(out.frames[1]!)).toBe(true);
  });

  test("30 Hz → 10 Hz downsample: frame_count floor(((n-1)/r)*10)+1", () => {
    const blob = makeBlob(31, 30, (i, k) => (k === 0 ? [i, 0.5, 0.9] : [0, 0, 0]));
    const out = resampleToCanonical10Hz(decodeTkp1(blob));
    expect(out.frameCount).toBe(11);
    // Grid points land exactly on source frames (p = 3k).
    expect(channel(out.frames[0]!, 0, 0)).toBe(0);
    expect(channel(out.frames[10]!, 0, 0)).toBe(30);
  });

  test("25 Hz → 10 Hz: fractional interpolation between frames", () => {
    const blob = makeBlob(6, 25, (i, k) => (k === 0 ? [i * 0.1, 0.5, 0.9] : [0, 0, 0]));
    const out = resampleToCanonical10Hz(decodeTkp1(blob));
    expect(out.frameCount).toBe(3); // floor(5/25*10)+1
    // k=1: t=0.1 → p=2.5 → 0.5*S[2] + 0.5*S[3] = 0.25.
    expect(channel(out.frames[1]!, 0, 0)).toBeCloseTo(0.25, 5);
    // k=2: t=0.2 → p=5 → exactly S[5].
    expect(channel(out.frames[2]!, 0, 0)).toBeCloseTo(0.5, 6);
  });

  test("below 10 Hz → upsampled", () => {
    const blob = makeBlob(3, 5, (i, k) => (k === 0 ? [i, 0.5, 0.9] : [0, 0, 0]));
    const out = resampleToCanonical10Hz(decodeTkp1(blob));
    expect(out.frameCount).toBe(5); // floor(2/5*10)+1
    expect(channel(out.frames[0]!, 0, 0)).toBe(0);
    expect(channel(out.frames[4]!, 0, 0)).toBe(2);
    expect(channel(out.frames[1]!, 0, 0)).toBeCloseTo(0.5, 5);
  });

  test("exactly 10 Hz → byte-identical passthrough", () => {
    const blob = makeBlob(4, 10, (i, k) => [i * 0.1 + k * 0.01, 0.5, 0.9]);
    const out = encodeTkp1(resampleToCanonical10Hz(decodeTkp1(blob)));
    expect(out).toEqual(blob);
  });

  test("single frame → single canonical frame", () => {
    const blob = makeBlob(1, 30, (i, k) => (k === 0 ? [0.7, 0.3, 0.95] : [0, 0, 0]));
    const out = resampleToCanonical10Hz(decodeTkp1(blob));
    expect(out.frameCount).toBe(1);
    expect(channel(out.frames[0]!, 0, 0)).toBeCloseTo(0.7, 6);
  });

  test.each([0.5, 31])("rejects source rate %s Hz", (r) => {
    const blob = makeBlob(4, r, (i, k) => (k === 0 ? [i * 0.1, 0.5, 0.9] : [0, 0, 0]));
    expect(() => resampleToCanonical10Hz(decodeTkp1(blob))).toThrow(Tkp1Error);
  });

  test("output header carries canonical rate and preserves the as-sent rate", () => {
    const blob = makeBlob(6, 25, (i, k) => (k === 0 ? [i * 0.1, 0.5, 0.9] : [0, 0, 0]));
    const view = new DataView(encodeTkp1(resampleToCanonical10Hz(decodeTkp1(blob))).buffer);
    expect(view.getFloat32(12, true)).toBe(10);
    expect(view.getFloat32(16, true)).toBe(25);
    expect(view.getUint32(8, true)).toBe(3);
  });
});
