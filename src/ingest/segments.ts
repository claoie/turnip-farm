// Training segments (BACKEND_DESIGN.md §1.2.24, POSE_FORMAT.md §12): the
// only pose the training export serves. Pure functions: cutting short
// windows around confirmed clips out of a canonical 10 Hz TKP1 sequence,
// re-targeting each onto a standard body, and encoding the result as TKS1.
// No I/O and no clock; randomness comes in through `Rng`, so tests are
// deterministic. The segmenter (segmenter.ts) wires these to R2 and
// Postgres.

import { CANONICAL_HZ, type DecodedTkp1, TKP1_KEYPOINT_COUNT } from "./tkp1";

// Open values (judgment calls, BACKEND_DESIGN.md §1.2.24). Named here so a
// change is one line and one doc row.

/** Frames of context kept before and after each clip window (0.5 s). */
export const SEGMENT_CONTEXT_FRAMES = 5;
/** Longest segment kept, context included (8 s); longer clips are dropped. */
export const SEGMENT_MAX_FRAMES = 80;
/** Fewest frames between two kept segments of one source (1 s); a closer one is dropped. */
export const SEGMENT_MIN_GAP_FRAMES = 10;
/** Standard deviation of the Gaussian noise added to every joint's x and y, in torso lengths. */
export const SEGMENT_NOISE_SD = 0.02;
/** Number of split buckets a segment is assigned to (by source), for leakage-free holdout splits. */
export const SPLIT_BUCKETS = 10;

// TKS1, the segment blob format (POSE_FORMAT.md §12).
export const TKS1_MAGIC = "TKS1";
export const TKS1_VERSION = 1;
export const TKS1_KEYPOINT_COUNT = 13;
export const TKS1_HEADER_BYTES = 24;
export const TKS1_FRAME_BYTES = TKS1_KEYPOINT_COUNT * 3 * 4; // 156

/**
 * TKS1 joint order. Index 0 is the head point (collapsed from TKP1
 * keypoints 0–4); 1–12 are TKP1 keypoints 5–16 in the same order.
 */
export const TKS1_JOINTS = [
  "head",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
] as const;

/**
 * Bone lengths of the standard body, in torso lengths (hip midpoint to
 * shoulder midpoint = 1). Every segment is re-targeted onto these, so limb
 * proportions don't survive into training data.
 */
export const STANDARD_BONES = {
  torso: 1.0,
  hipHalf: 0.2,
  shoulderHalf: 0.35,
  neckToHead: 0.45,
  upperArm: 0.55,
  forearm: 0.5,
  thigh: 0.85,
  shin: 0.8,
} as const;

/** A source of uniform randoms in [0, 1). */
export type Rng = () => number;

/** Uniform randoms from the platform CSPRNG. */
export const cryptoRng: Rng = () => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! / 2 ** 32;
};

export interface ClipWindow {
  startFrame: number;
  /** Exclusive, as in `clips.end_frame`. */
  endFrame: number;
}

export interface SegmentCut<C extends ClipWindow> {
  clip: C;
  /** Canonical frame range of the source, end exclusive. */
  from: number;
  to: number;
}

/**
 * Picks the segments to keep: each clip window padded by
 * SEGMENT_CONTEXT_FRAMES, clamped to the source; clips are taken in start
 * order, and a segment longer than SEGMENT_MAX_FRAMES, or starting fewer
 * than SEGMENT_MIN_GAP_FRAMES after the last kept one ends, is dropped, so
 * kept segments never overlap or touch.
 */
export function chooseSegments<C extends ClipWindow>(clips: readonly C[], frameCount: number): SegmentCut<C>[] {
  const ordered = [...clips].sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
  const kept: SegmentCut<C>[] = [];
  let lastEnd = -Infinity;
  for (const clip of ordered) {
    if (clip.endFrame > frameCount || clip.startFrame >= clip.endFrame) continue;
    const from = Math.max(0, clip.startFrame - SEGMENT_CONTEXT_FRAMES);
    const to = Math.min(frameCount, clip.endFrame + SEGMENT_CONTEXT_FRAMES);
    if (to <= from || to - from > SEGMENT_MAX_FRAMES) continue;
    if (from < lastEnd + SEGMENT_MIN_GAP_FRAMES) continue;
    kept.push({ clip, from, to });
    lastEnd = to;
  }
  return kept;
}

type Point = { x: number; y: number; c: number } | null;

function readFrame(frame: Uint8Array<ArrayBuffer>): Point[] {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const points: Point[] = [];
  for (let k = 0; k < TKP1_KEYPOINT_COUNT; k++) {
    const c = view.getFloat32(k * 12 + 8, true);
    points.push(c > 0 ? { x: view.getFloat32(k * 12, true), y: view.getFloat32(k * 12 + 4, true), c } : null);
  }
  return points;
}

const mid = (a: Point, b: Point): Point =>
  a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, c: Math.min(a.c, b.c) } : null;

function headPoint(points: Point[]): Point {
  const face = points.slice(0, 5).filter((p): p is NonNullable<Point> => p !== null);
  if (face.length === 0) return null;
  const n = face.length;
  return {
    x: face.reduce((s, p) => s + p.x, 0) / n,
    y: face.reduce((s, p) => s + p.y, 0) / n,
    c: face.reduce((s, p) => s + p.c, 0) / n,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
}

/** One TKS1 frame: 13 joints, null where missing. All null is a gap. */
export type SegmentFrame = ({ x: number; y: number; c: number } | null)[];

/**
 * Re-targets canonical frames [from, to) onto the standard body:
 * - the root is the hip midpoint; a frame missing either hip is a gap;
 * - root positions are centered on their mean over the segment and scaled
 *   by the segment's median torso length, so the result is in torso
 *   lengths and the subject's place in the picture is gone;
 * - every other joint is placed from its parent along the observed bone
 *   direction at the standard bone length (STANDARD_BONES), so joint
 *   angles survive and proportions don't; a joint whose parent is missing
 *   is missing;
 * - the head is one point, the mean of the detected keypoints 0–4;
 * - Gaussian noise with SEGMENT_NOISE_SD is added to every joint's x and y.
 * Confidence is carried over from the observed joint. Returns null when no
 * frame has both hips and both shoulders (nothing to scale by).
 */
export function retargetSegment(
  pose: DecodedTkp1,
  from: number,
  to: number,
  rng: Rng,
): SegmentFrame[] | null {
  const observed = pose.frames.slice(from, to).map(readFrame);
  const roots = observed.map((p) => mid(p[11]!, p[12]!));
  const necks = observed.map((p) => mid(p[5]!, p[6]!));

  const torsoLengths: number[] = [];
  for (let i = 0; i < observed.length; i++) {
    const r = roots[i]!;
    const n = necks[i]!;
    if (r && n) torsoLengths.push(Math.hypot(n.x - r.x, n.y - r.y));
  }
  const scale = torsoLengths.length > 0 ? median(torsoLengths) : 0;
  if (!(scale > 0)) return null;

  const present = roots.filter((r): r is NonNullable<Point> => r !== null);
  const cx = present.reduce((s, r) => s + r.x, 0) / present.length;
  const cy = present.reduce((s, r) => s + r.y, 0) / present.length;

  const gauss = () => {
    // Box–Muller; 1 - u keeps log() away from 0.
    const u = 1 - rng();
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * SEGMENT_NOISE_SD;
  };

  return observed.map((points, i) => {
    const out: SegmentFrame = new Array(TKS1_KEYPOINT_COUNT).fill(null);
    const root = roots[i]!;
    if (!root) return out;
    const placed = new Map<string, { x: number; y: number }>();
    const rootOut = { x: (root.x - cx) / scale, y: (root.y - cy) / scale };

    // Places `child` from parent position `fromOut` (observed `fromObs`) at
    // `length` along the observed direction; null when either is missing
    // or they coincide.
    const place = (
      fromObs: Point,
      fromOut: { x: number; y: number } | undefined,
      child: Point,
      length: number,
    ): { x: number; y: number } | null => {
      if (!fromObs || !fromOut || !child) return null;
      const dx = child.x - fromObs.x;
      const dy = child.y - fromObs.y;
      const d = Math.hypot(dx, dy);
      if (d === 0) return null;
      return { x: fromOut.x + (dx / d) * length, y: fromOut.y + (dy / d) * length };
    };
    const set = (index: number, name: string, pos: { x: number; y: number } | null, c: number | undefined) => {
      if (!pos || c === undefined) return;
      placed.set(name, pos);
      out[index] = { x: pos.x + gauss(), y: pos.y + gauss(), c };
    };

    const neck = necks[i]!;
    const neckOut = place(root, rootOut, neck, STANDARD_BONES.torso) ?? undefined;
    const head = headPoint(points);
    // TKS1 index = TKP1 index - 4 for keypoints 5..16.
    set(7, "lhip", place(root, rootOut, points[11]!, STANDARD_BONES.hipHalf), points[11]?.c);
    set(8, "rhip", place(root, rootOut, points[12]!, STANDARD_BONES.hipHalf), points[12]?.c);
    set(1, "lsho", place(neck, neckOut, points[5]!, STANDARD_BONES.shoulderHalf), points[5]?.c);
    set(2, "rsho", place(neck, neckOut, points[6]!, STANDARD_BONES.shoulderHalf), points[6]?.c);
    set(0, "head", place(neck, neckOut, head, STANDARD_BONES.neckToHead), head?.c);
    set(3, "lelb", place(points[5]!, placed.get("lsho"), points[7]!, STANDARD_BONES.upperArm), points[7]?.c);
    set(4, "relb", place(points[6]!, placed.get("rsho"), points[8]!, STANDARD_BONES.upperArm), points[8]?.c);
    set(5, "lwri", place(points[7]!, placed.get("lelb"), points[9]!, STANDARD_BONES.forearm), points[9]?.c);
    set(6, "rwri", place(points[8]!, placed.get("relb"), points[10]!, STANDARD_BONES.forearm), points[10]?.c);
    set(9, "lkne", place(points[11]!, placed.get("lhip"), points[13]!, STANDARD_BONES.thigh), points[13]?.c);
    set(10, "rkne", place(points[12]!, placed.get("rhip"), points[14]!, STANDARD_BONES.thigh), points[14]?.c);
    set(11, "lank", place(points[13]!, placed.get("lkne"), points[15]!, STANDARD_BONES.shin), points[15]?.c);
    set(12, "rank", place(points[14]!, placed.get("rkne"), points[16]!, STANDARD_BONES.shin), points[16]?.c);
    return out;
  });
}

/** Encodes frames as an uncompressed TKS1 blob (POSE_FORMAT.md §12). */
export function encodeTks1(frames: SegmentFrame[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(TKS1_HEADER_BYTES + frames.length * TKS1_FRAME_BYTES);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 4; i++) bytes[i] = TKS1_MAGIC.charCodeAt(i);
  view.setUint16(4, TKS1_VERSION, true);
  view.setUint16(6, TKS1_KEYPOINT_COUNT, true);
  view.setUint32(8, frames.length, true);
  view.setFloat32(12, CANONICAL_HZ, true);
  // Bytes 16..24 are reserved and stay zero: no source rate, no flags.
  frames.forEach((frame, f) => {
    frame.forEach((joint, k) => {
      if (!joint) return; // a missing joint is three zero floats
      const at = TKS1_HEADER_BYTES + (f * TKS1_KEYPOINT_COUNT + k) * 12;
      view.setFloat32(at, joint.x, true);
      view.setFloat32(at + 4, joint.y, true);
      view.setFloat32(at + 8, joint.c, true);
    });
  });
  return bytes;
}

/** Decodes an uncompressed TKS1 blob, failing closed like the TKP1 decoder. */
export function decodeTks1(bytes: Uint8Array<ArrayBuffer>): SegmentFrame[] {
  if (bytes.length < TKS1_HEADER_BYTES) throw new Error("TKS1: too short for a header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== TKS1_MAGIC) throw new Error(`TKS1: bad magic ${JSON.stringify(magic)}`);
  if (view.getUint16(4, true) !== TKS1_VERSION) throw new Error("TKS1: unsupported version");
  if (view.getUint16(6, true) !== TKS1_KEYPOINT_COUNT) throw new Error("TKS1: unsupported keypoint_count");
  const n = view.getUint32(8, true);
  if (view.getFloat32(12, true) !== CANONICAL_HZ) throw new Error("TKS1: sample_rate_hz must be 10");
  if (view.getUint32(16, true) !== 0 || view.getUint32(20, true) !== 0) throw new Error("TKS1: reserved bytes set");
  if (bytes.length !== TKS1_HEADER_BYTES + n * TKS1_FRAME_BYTES) throw new Error("TKS1: size mismatch");
  const frames: SegmentFrame[] = [];
  for (let f = 0; f < n; f++) {
    const frame: SegmentFrame = [];
    for (let k = 0; k < TKS1_KEYPOINT_COUNT; k++) {
      const at = TKS1_HEADER_BYTES + (f * TKS1_KEYPOINT_COUNT + k) * 12;
      const c = view.getFloat32(at + 8, true);
      frame.push(c > 0 ? { x: view.getFloat32(at, true), y: view.getFloat32(at + 4, true), c } : null);
    }
    frames.push(frame);
  }
  return frames;
}

/** The split bucket of a source: first byte of SHA-256(source id) mod SPLIT_BUCKETS. */
export function splitBucket(sourceId: string): number {
  const digest = new Bun.CryptoHasher("sha256").update(sourceId).digest();
  return digest[0]! % SPLIT_BUCKETS;
}

