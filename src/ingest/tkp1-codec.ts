// TKP1 decoding (POSE_FORMAT.md): the header, frame layout and gap rule.
// No imports and no runtime-specific APIs, so the farm's ingest worker
// (through tkp1.ts) and the web client's pose player decode with the same
// code.

export const TKP1_MAGIC = "TKP1";
export const TKP1_VERSION = 1;
export const TKP1_KEYPOINT_COUNT = 17;
export const TKP1_HEADER_BYTES = 24;
export const TKP1_FRAME_BYTES = TKP1_KEYPOINT_COUNT * 3 * 4; // 17 kp x (x,y,conf) f32 = 204
export const CANONICAL_HZ = 10;
// The client analysis range the farm accepts (BACKEND_DESIGN.md §7.3,
// POST /api/sources validation).
export const MIN_SOURCE_HZ = 1;
export const MAX_SOURCE_HZ = 30;

export class Tkp1Error extends Error {
  constructor(readonly reason: string) {
    super(`invalid TKP1 blob: ${reason}`);
    this.name = "Tkp1Error";
  }
}

export interface DecodedTkp1 {
  frameCount: number;
  // As-sent analysis rate, provenance only (f32 header field).
  sourceSampleRateHz: number;
  // n x 204 raw frame bytes, in source order. A gap frame is 204 zero bytes.
  frames: Uint8Array<ArrayBuffer>[];
}

function readF32LE(view: DataView, offset: number): number {
  return view.getFloat32(offset, true);
}

// A frame is missing iff all 17 confidence values are exactly 0.0f
// (POSE_FORMAT.md §7 decoder rule).
export function isGapFrame(frame: Uint8Array<ArrayBuffer>): boolean {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  for (let k = 0; k < TKP1_KEYPOINT_COUNT; k++) {
    if (readF32LE(view, k * 12 + 8) !== 0) return false;
  }
  return true;
}

/**
 * The 24-byte header's frame count and as-sent rate, validated fail-closed
 * (POSE_FORMAT.md §9). `bytes` holds at least the header.
 */
export function decodeTkp1Header(bytes: Uint8Array<ArrayBuffer>): { frameCount: number; sourceSampleRateHz: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== TKP1_MAGIC) throw new Tkp1Error(`bad magic ${JSON.stringify(magic)}`);
  const version = view.getUint16(4, true);
  if (version !== TKP1_VERSION) throw new Tkp1Error(`unsupported format_version ${version}`);
  const keypointCount = view.getUint16(6, true);
  if (keypointCount !== TKP1_KEYPOINT_COUNT) {
    throw new Tkp1Error(`unsupported keypoint_count ${keypointCount}`);
  }
  const frameCount = view.getUint32(8, true);
  if (frameCount < 1) throw new Tkp1Error(`frame_count ${frameCount} < 1`);
  const flags = view.getUint32(20, true);
  if (flags !== 0) throw new Tkp1Error(`unsupported flags ${flags}`);
  return { frameCount, sourceSampleRateHz: readF32LE(view, 16) };
}

// Decode fail-closed (POSE_FORMAT.md §9): any header or size violation
// rejects the whole blob.
export function decodeTkp1(bytes: Uint8Array<ArrayBuffer>): DecodedTkp1 {
  if (bytes.length < TKP1_HEADER_BYTES) {
    throw new Tkp1Error(`too short for a header (${bytes.length} bytes)`);
  }
  const { frameCount, sourceSampleRateHz } = decodeTkp1Header(bytes);
  const expected = TKP1_HEADER_BYTES + TKP1_FRAME_BYTES * frameCount;
  if (bytes.length !== expected) {
    throw new Tkp1Error(`size ${bytes.length} != 24 + 204*${frameCount} (${expected})`);
  }
  const frames: Uint8Array<ArrayBuffer>[] = [];
  for (let i = 0; i < frameCount; i++) {
    frames.push(
      bytes.slice(TKP1_HEADER_BYTES + i * TKP1_FRAME_BYTES, TKP1_HEADER_BYTES + (i + 1) * TKP1_FRAME_BYTES),
    );
  }
  return { frameCount, sourceSampleRateHz, frames };
}
