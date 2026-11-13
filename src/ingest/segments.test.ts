// Training segment cutting and re-targeting (BACKEND_DESIGN.md §1.2.24,
// POSE_FORMAT.md §12). Pure; no database.

import { describe, expect, test } from "bun:test";
import {
  SEGMENT_CONTEXT_FRAMES,
  SEGMENT_MAX_FRAMES,
  SEGMENT_MIN_GAP_FRAMES,
  SEGMENT_NOISE_SD,
  SPLIT_BUCKETS,
  STANDARD_BONES,
  TKS1_FRAME_BYTES,
  TKS1_HEADER_BYTES,
  type SegmentFrame,
  chooseSegments,
  decodeTks1,
  encodeTks1,
  retargetSegment,
  splitBucket,
} from "./segments";
import type { DecodedTkp1 } from "./tkp1";

type Kp = [number, number, number];

function frameBytes(points: Partial<Record<number, Kp>>): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(204);
  const view = new DataView(bytes.buffer);
  for (const [k, [x, y, c]] of Object.entries(points) as [string, Kp][]) {
    view.setFloat32(Number(k) * 12, x, true);
    view.setFloat32(Number(k) * 12 + 4, y, true);
    view.setFloat32(Number(k) * 12 + 8, c, true);
  }
  return bytes;
}

// A standing pose at (ox, oy), sized by `s`, with arms out at `armAngle`
// radians from horizontal. Keypoints 0–4 sit around the head.
function body(ox: number, oy: number, s: number, armAngle = 0): Partial<Record<number, Kp>> {
  const ax = Math.cos(armAngle) * 0.3 * s;
  const ay = Math.sin(armAngle) * 0.3 * s;
  return {
    0: [ox, oy - 0.65 * s, 0.9],
    1: [ox - 0.03 * s, oy - 0.68 * s, 0.8],
    2: [ox + 0.03 * s, oy - 0.68 * s, 0.8],
    3: [ox - 0.06 * s, oy - 0.66 * s, 0.7],
    4: [ox + 0.06 * s, oy - 0.66 * s, 0.7],
    5: [ox - 0.2 * s, oy - 0.5 * s, 0.9],
    6: [ox + 0.2 * s, oy - 0.5 * s, 0.9],
    7: [ox - 0.2 * s - ax, oy - 0.5 * s + ay, 0.9],
    8: [ox + 0.2 * s + ax, oy - 0.5 * s + ay, 0.9],
    9: [ox - 0.2 * s - 2 * ax, oy - 0.5 * s + 2 * ay, 0.9],
    10: [ox + 0.2 * s + 2 * ax, oy - 0.5 * s + 2 * ay, 0.9],
    11: [ox - 0.1 * s, oy, 0.9],
    12: [ox + 0.1 * s, oy, 0.9],
    13: [ox - 0.1 * s, oy + 0.4 * s, 0.9],
    14: [ox + 0.1 * s, oy + 0.4 * s, 0.9],
    15: [ox - 0.1 * s, oy + 0.8 * s, 0.9],
    16: [ox + 0.1 * s, oy + 0.8 * s, 0.9],
  };
}

const pose = (frames: Partial<Record<number, Kp>>[]): DecodedTkp1 => ({
  frameCount: frames.length,
  sourceSampleRateHz: 30,
  frames: frames.map(frameBytes),
});

// rng() = 0 makes Box–Muller's radius sqrt(-2 ln 1) = 0: no noise.
const noNoise = () => 0;

type Joint = SegmentFrame[number] | undefined;
const dist = (a: Joint, b: Joint) => Math.hypot(a!.x - b!.x, a!.y - b!.y);
const midpoint = (a: Joint, b: Joint) => ({ x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 });

describe("chooseSegments", () => {
  const clip = (startFrame: number, endFrame: number) => ({ startFrame, endFrame });

  test("pads each window by the context and clamps to the source", () => {
    expect(SEGMENT_CONTEXT_FRAMES).toBe(5);
    expect(chooseSegments([clip(20, 40)], 600)).toEqual([{ clip: clip(20, 40), from: 15, to: 45 }]);
    expect(chooseSegments([clip(2, 10)], 12)).toEqual([{ clip: clip(2, 10), from: 0, to: 12 }]);
  });

  test("drops a segment that would start within the minimum gap of the last kept one", () => {
    expect(SEGMENT_MIN_GAP_FRAMES).toBe(10);
    // First kept: [15, 45). Next must start at >= 55, i.e. its clip at >= 60.
    const kept = chooseSegments([clip(59, 70), clip(20, 40), clip(100, 110)], 600);
    expect(kept.map((k) => [k.from, k.to])).toEqual([
      [15, 45],
      [95, 115],
    ]);
    const spaced = chooseSegments([clip(20, 40), clip(60, 70)], 600);
    expect(spaced.map((k) => [k.from, k.to])).toEqual([
      [15, 45],
      [55, 75],
    ]);
  });

  test("drops a segment longer than the maximum, and a clip past the end of the blob", () => {
    expect(SEGMENT_MAX_FRAMES).toBe(80);
    expect(chooseSegments([clip(10, 80)], 600)).toEqual([{ clip: clip(10, 80), from: 5, to: 85 }]);
    expect(chooseSegments([clip(10, 81)], 600)).toEqual([]);
    expect(chooseSegments([clip(590, 610)], 600)).toEqual([]);
  });
});

describe("retargetSegment", () => {
  test("bones take the standard lengths, whatever the subject's size or place", () => {
    for (const [ox, oy, s] of [
      [0.5, 0.6, 0.5],
      [0.2, 0.4, 0.2],
    ] as const) {
      const frames = retargetSegment(pose([body(ox, oy, s, 0.3)]), 0, 1, noNoise)!;
      const [head, ls, rs, le, re, lw, rw, lh, rh, lk, rk, la, ra] = frames[0]!;
      const neck = midpoint(ls, rs);
      const root = midpoint(lh, rh);
      expect(Math.hypot(neck.x - root.x, neck.y - root.y)).toBeCloseTo(STANDARD_BONES.torso, 5);
      expect(dist(ls, rs)).toBeCloseTo(2 * STANDARD_BONES.shoulderHalf, 5);
      expect(dist(lh, rh)).toBeCloseTo(2 * STANDARD_BONES.hipHalf, 5);
      expect(Math.hypot(head!.x - neck.x, head!.y - neck.y)).toBeCloseTo(STANDARD_BONES.neckToHead, 5);
      expect(dist(ls, le)).toBeCloseTo(STANDARD_BONES.upperArm, 5);
      expect(dist(rs, re)).toBeCloseTo(STANDARD_BONES.upperArm, 5);
      expect(dist(le, lw)).toBeCloseTo(STANDARD_BONES.forearm, 5);
      expect(dist(re, rw)).toBeCloseTo(STANDARD_BONES.forearm, 5);
      expect(dist(lh, lk)).toBeCloseTo(STANDARD_BONES.thigh, 5);
      expect(dist(rh, rk)).toBeCloseTo(STANDARD_BONES.thigh, 5);
      expect(dist(lk, la)).toBeCloseTo(STANDARD_BONES.shin, 5);
      expect(dist(rk, ra)).toBeCloseTo(STANDARD_BONES.shin, 5);
      // One segment frame centers the root on the origin.
      expect(root.x).toBeCloseTo(0, 5);
      expect(root.y).toBeCloseTo(0, 5);
    }
  });

  test("two subjects with the same joint angles come out identical", () => {
    const a = retargetSegment(pose([body(0.5, 0.6, 0.5, 0.4)]), 0, 1, noNoise)!;
    const b = retargetSegment(pose([body(0.3, 0.7, 0.25, 0.4)]), 0, 1, noNoise)!;
    a[0]!.forEach((joint, k) => {
      expect(joint!.x).toBeCloseTo(b[0]![k]!.x, 5);
      expect(joint!.y).toBeCloseTo(b[0]![k]!.y, 5);
    });
    // A different arm angle does change the wrists.
    const c = retargetSegment(pose([body(0.5, 0.6, 0.5, -0.4)]), 0, 1, noNoise)!;
    expect(Math.abs(c[0]![5]!.y - a[0]![5]!.y)).toBeGreaterThan(0.1);
  });

  test("root motion survives in torso lengths, centered on the segment mean", () => {
    // The subject rises by one torso length (0.5 * s with s = 0.5 → 0.25) between frames.
    const frames = retargetSegment(pose([body(0.5, 0.6, 0.5), body(0.5, 0.35, 0.5)]), 0, 2, noNoise)!;
    const r0 = midpoint(frames[0]![7], frames[0]![8]);
    const r1 = midpoint(frames[1]![7], frames[1]![8]);
    expect(r0.y).toBeCloseTo(0.5, 5);
    expect(r1.y).toBeCloseTo(-0.5, 5);
    expect(r0.x).toBeCloseTo(0, 5);
  });

  test("a frame missing a hip is a gap; a joint whose parent is missing is missing", () => {
    const noHip = body(0.5, 0.6, 0.5);
    delete noHip[12];
    const noElbow = body(0.5, 0.6, 0.5);
    delete noElbow[7];
    const frames = retargetSegment(pose([body(0.5, 0.6, 0.5), noHip, noElbow]), 0, 3, noNoise)!;
    expect(frames[1]!.every((j) => j === null)).toBe(true);
    expect(frames[2]![3]).toBeNull(); // left elbow
    expect(frames[2]![5]).toBeNull(); // left wrist, whose parent is the elbow
    expect(frames[2]![6]).not.toBeNull(); // right wrist
  });

  test("the head is one point from the detected face keypoints, and null without any", () => {
    const noFace = body(0.5, 0.6, 0.5);
    for (const k of [0, 1, 2, 3, 4]) delete noFace[k];
    const frames = retargetSegment(pose([body(0.5, 0.6, 0.5), noFace]), 0, 2, noNoise)!;
    expect(frames[0]![0]!.c).toBeCloseTo((0.9 + 0.8 + 0.8 + 0.7 + 0.7) / 5, 5);
    expect(frames[1]![0]).toBeNull();
    expect(frames[0]).toHaveLength(13);
  });

  test("null when no frame has both hips and both shoulders", () => {
    const torsoless = body(0.5, 0.6, 0.5);
    delete torsoless[5];
    expect(retargetSegment(pose([torsoless]), 0, 1, noNoise)).toBeNull();
  });

  test("adds Gaussian noise with the configured spread", () => {
    expect(SEGMENT_NOISE_SD).toBe(0.02);
    const clean = retargetSegment(pose([body(0.5, 0.6, 0.5)]), 0, 1, noNoise)![0]!;
    const deltas: number[] = [];
    for (let run = 0; run < 400; run++) {
      const noisy = retargetSegment(pose([body(0.5, 0.6, 0.5)]), 0, 1, Math.random)![0]!;
      noisy.forEach((j, k) => deltas.push(j!.x - clean[k]!.x, j!.y - clean[k]!.y));
    }
    const mean = deltas.reduce((s, d) => s + d, 0) / deltas.length;
    const sd = Math.sqrt(deltas.reduce((s, d) => s + (d - mean) ** 2, 0) / deltas.length);
    expect(Math.abs(mean)).toBeLessThan(0.002);
    expect(sd).toBeGreaterThan(0.017);
    expect(sd).toBeLessThan(0.023);
  });
});

describe("TKS1", () => {
  test("encodes the header and frames per POSE_FORMAT.md §12 and decodes them back", () => {
    const frames = retargetSegment(pose([body(0.5, 0.6, 0.5), {}]), 0, 2, noNoise);
    // The second frame has no hips → gap.
    expect(frames).not.toBeNull();
    const bytes = encodeTks1(frames!);
    expect(bytes.length).toBe(TKS1_HEADER_BYTES + 2 * TKS1_FRAME_BYTES);
    expect(Array.from(bytes.slice(0, 24))).toEqual([
      0x54, 0x4b, 0x53, 0x31, // "TKS1"
      1, 0, // format_version
      13, 0, // keypoint_count
      2, 0, 0, 0, // frame_count
      0x00, 0x00, 0x20, 0x41, // 10.0f
      0, 0, 0, 0, 0, 0, 0, 0, // reserved
    ]);
    expect(bytes.slice(24 + 156).every((b) => b === 0)).toBe(true);
    const decoded = decodeTks1(bytes);
    expect(decoded[1]!.every((j) => j === null)).toBe(true);
    decoded[0]!.forEach((j, k) => {
      expect(j!.x).toBeCloseTo(frames![0]![k]!.x, 5);
      expect(j!.c).toBeCloseTo(frames![0]![k]!.c, 5);
    });
  });

  test("the decoder fails closed", () => {
    const good = encodeTks1([[null, null, null, null, null, null, null, null, null, null, null, null, null]]);
    const bad = (mutate: (b: Uint8Array<ArrayBuffer>) => void) => {
      const b = good.slice();
      mutate(b);
      return () => decodeTks1(b);
    };
    expect(() => decodeTks1(good)).not.toThrow();
    expect(bad((b) => (b[3] = 0x32))).toThrow("magic");
    expect(bad((b) => (b[6] = 17))).toThrow("keypoint_count");
    expect(bad((b) => (b[16] = 1))).toThrow("reserved");
    expect(() => decodeTks1(good.slice(0, good.length - 1))).toThrow("size");
  });
});

describe("splitBucket", () => {
  test("is a stable bucket in 0..SPLIT_BUCKETS-1", () => {
    const a = "a".repeat(64);
    expect(splitBucket(a)).toBe(splitBucket(a));
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const b = splitBucket(i.toString(16).padStart(64, "0"));
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(SPLIT_BUCKETS);
      seen.add(b);
    }
    expect(seen.size).toBe(SPLIT_BUCKETS);
  });
});
