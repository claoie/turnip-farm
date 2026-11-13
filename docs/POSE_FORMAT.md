# Pose Format — Interchange Format Specification

**Scope.** This document is the byte-level specification of the pose
format, the canonical encoding for pose keypoint sequences defined by the
master plan
(`https://github.com/hoiekim/turnip-farm/blob/main/docs/MASTER_PLAN.md`,
§3). It is used on the wire (client → farm pose-blob upload) and at rest
(R2 pose blobs). It is the *only* pose representation the farm accepts —
no JSON variant. The farm also stores and exports training segments in
a derived format, `TKS1`, specified in §12. Implementers should be able
to write a conformant encoder and decoder from this document plus the
test vectors in §11 alone.

**Conventions.** All multi-byte integers and floats are **little-endian**.
"**MUST**" / "**MUST NOT**" are conformance requirements (§10).

## 1. Overview

A pose-format blob is a 24-byte header followed by a dense frame array, with the
whole blob gzip-compressed (single member, RFC 1952) for transfer and
storage. Files are named `<name>.tkp1.gz`. The canonical sample rate is
**10 Hz**; the farm resamples client submissions to 10 Hz on ingest and
stores canonical only (§6). Each frame holds 17 keypoints (MoveNet, COCO
order, §4), each keypoint a `(x, y, confidence)` float32 triple.

## 2. Header (24 bytes)

| Offset | Size | Type   | Field                  | Value / constraint                                    |
|--------|------|--------|------------------------|-------------------------------------------------------|
| 0      | 4    | char[4] | `magic`               | ASCII `"TKP1"` (`0x54 0x4B 0x50 0x31`)                 |
| 4      | 2    | u16    | `format_version`       | `1`                                                   |
| 6      | 2    | u16    | `keypoint_count`       | `17`                                                  |
| 8      | 4    | u32    | `frame_count`           | Number of frames; `>= 0`                              |
| 12     | 4    | f32    | `sample_rate_hz`        | Canonical rate: `10.0`                                |
| 16     | 4    | f32    | `source_sample_rate_hz` | As-sent analysis rate (provenance), e.g. `30.0`       |
| 20     | 4    | u32    | `flags`                 | Reserved; MUST be `0`                                 |

Total: **24 bytes**. Total blob size: `24 + frame_count × 204` bytes.

Notes:

- `magic` doubles as the format identifier: there is no separate
  keypoint-format id field in the header. (The farm's `sources`
  table carries `keypoint_format = 'tkp1'` as the storage-level tag.)
- `source_sample_rate_hz` records the rate the client analyzed at; the
  frame data itself is always the resampled 10 Hz grid. When the client
  already analyzes at 10 Hz, both fields are `10.0`.
- `flags` is reserved for future additive-compatible extensions. There
  are none defined; encoders MUST write `0`, decoders MUST reject
  nonzero.

## 3. Frame array

Immediately after the header: `frame_count × 17 × 3` float32 values,
little-endian, laid out as `[frame][keypoint][channel]` with channel
order **(x, y, confidence)**.

Byte offset of keypoint `k` (0–16), channel `c` (0 = x, 1 = y,
2 = confidence) in frame `f` (0-based):

```
offset = 24 + ((f * 17 + k) * 3 + c) * 4
```

Each frame occupies exactly 204 bytes. There is no per-frame header,
no padding, and no variable-length encoding — a gap frame costs the same
204 bytes as a full pose (§7).

## 4. Keypoints (MoveNet, COCO order)

| Index | Name           | Index | Name            |
|-------|---------------|-------|-----------------|
| 0     | nose           | 9     | left_wrist      |
| 1     | left_eye       | 10    | right_wrist     |
| 2     | right_eye      | 11    | left_hip        |
| 3     | left_ear       | 12    | right_hip       |
| 4     | right_ear      | 13    | left_knee       |
| 5     | left_shoulder  | 14    | right_knee      |
| 6     | right_shoulder | 15    | left_ankle      |
| 7     | left_elbow     | 16    | right_ankle     |
| 8     | right_elbow    |       |                 |

"Left"/"right" are the subject's left/right as emitted by the pose
model. The order and count are fixed by `keypoint_count = 17`; a decoder
MUST reject any other count.

## 5. Spatial normalization

- `x = pixel_x / frame_width`, `y = pixel_y / frame_height`, nominally in
  `0..1`.
- Values **may fall outside** `[0, 1]` (letterbox-pad regions,
  extrapolated points). They are recorded as-is and **never clamped**.
- `confidence` is `0..1` per keypoint, as emitted by the model.

## 6. Temporal: canonical 10 Hz

The canonical grid is fixed: frame `k` sits at `t = k / 10` seconds,
`k = 0 .. frame_count - 1`, with frame 0 at `t = 0`.

**Resampling** (performed by the farm on ingest; clients submit at their
analysis rate of 1–30 Hz):

- Let the source have `n` frames at `source_sample_rate_hz = r`.
  Canonical `frame_count = floor(((n - 1) / r) * 10) + 1`. (For `n = 1`,
  `frame_count = 1`.)
- For each canonical timestamp `t = k / 10`: source position
  `p = t * r`; `i = floor(p)`, `frac = p - i`. When `frac == 0` the
  canonical frame is `S[i]` exactly (no interpolation) — this is the
  last canonical frame whenever `10(n-1)/r` is an integer, and `S[i+1]`
  does not exist there. Otherwise the canonical frame is
  `(1 - frac) * S[i] + frac * S[i+1]`, applied per-channel to
  `(x, y, confidence)`. By construction `p <= n - 1`, and `S[i+1]`
  always exists when `frac > 0`.
- Source rate above 10 Hz → downsampled; below 10 Hz → upsampled;
  exactly 10 Hz → copied unchanged.

**Gaps break interpolation.** If `S[i]` or `S[i+1]` is a gap frame (§7),
the canonical frame is a gap — the encoder MUST NOT interpolate across
missing data, and MUST NOT synthesize pose where none was detected.

## 7. Gap semantics

- A **gap frame** is a frame whose 17 confidence values are all exactly
  `0.0f`. In a gap frame, `x` and `y` MUST also be `0.0f` (encoder
  requirement) — i.e. the whole 204-byte frame is zero bytes.
- **Decoder rule:** a frame is missing ⟺ all 17 confidence values
  `== 0.0f` (exact float comparison; encoders write literal `0.0f`).
- Decoders MUST treat gap frames as missing data: never interpolate
  across them when rendering skeletons or featurizing for training.
- Fixed-size representation: gaps need no special-casing in the binary
  layout, only in interpretation.

## 8. Compression and size

- The **entire blob** (24-byte header + frame array) is compressed as a
  single gzip member (RFC 1952). `mtime = 0` is recommended for
  reproducible builds but not required on the wire.
- Uncompressed size: `24 + 204 × frame_count` bytes → **2,040 bytes/s**
  at 10 Hz (≈ 122 KB for a 60-second session). Gzip typically shrinks
  this a further 5–25% depending on motion (static backgrounds and gap
  runs compress well; see the §11.1 vector: 636 → 93 bytes for a sparse
  example, which is not representative of real footage; exact gzipped
  size is encoder-dependent).

## 9. Versioning

Decoders MUST fail closed: reject any blob whose `magic != "TKP1"`,
`format_version != 1`, `keypoint_count != 17`, or `flags != 0`.

**TKP2** (judgment call — the master plan does not define it): any
incompatible change (different keypoint set or count, different layout,
different gap semantics) requires a **new 4-byte magic** (e.g. `"TKP2"`)
**and** `format_version = 2`. Purely additive-compatible extensions would
use the `flags` field with a version bump — which v1 decoders reject by
the rule above, as intended.

## 10. Conformance

**Encoder MUST:**

1. Emit the 24-byte header exactly per §2, little-endian, `flags = 0`.
2. Write exactly `frame_count × 17 × 3` float32 LE values after the
   header — no more, no fewer.
3. Write gap frames as 204 zero bytes (`x = y = confidence = 0.0f`).
4. Never interpolate across gap frames when resampling (§6).
5. Record `x`/`y` unclamped, even outside `[0, 1]`.
6. Gzip the whole blob as a single member.

**Decoder MUST:**

1. Reject unknown `magic`, `format_version != 1`,
   `keypoint_count != 17`, or nonzero `flags`.
2. After gunzip, reject blobs whose length `!= 24 + frame_count × 204`.
3. Treat all-zero-confidence frames as missing; never interpolate
   across them.
4. Not assume `x`/`y ∈ [0, 1]`.

## 11. Test vectors

### 11.1 Worked example (3 frames, one gap)

- Header: `magic = "TKP1"`, `format_version = 1`, `keypoint_count = 17`,
  `frame_count = 3`, `sample_rate_hz = 10.0`,
  `source_sample_rate_hz = 10.0`, `flags = 0`.
- Frame 0: keypoint 0 (nose) = `(0.5, 0.2, 0.95)`, keypoint 5
  (left_shoulder) = `(0.45, 0.35, 0.9)`; all other keypoints zero.
- Frame 1: gap (all 204 bytes zero).
- Frame 2: keypoint 0 (nose) = `(0.51, 0.21, 0.94)`, keypoint 5
  (left_shoulder) = `(0.46, 0.36, 0.89)`; all other keypoints zero.

Digests (uncompressed blob only):

```
sha256(.tkp1)     = 37ba29d3c206f3b9dd41219e29354c480791d000533efdfc8096ee6f0959cac9
```

No digest is given for `.tkp1.gz`: deflate output varies by encoder
and compression level even with `mtime = 0`, so a gzip digest is not
reproducible from this document. A conformant implementation MUST
produce the byte-identical `.tkp1` above (checked by its digest); the
gzip wrapping is transport only.

Annotated header (24 bytes):

```
offset  0.. 4  54 4b 50 31   magic "TKP1"
offset  4.. 6  01 00         format_version = 1 (u16 LE)
offset  6.. 8  11 00         keypoint_count = 17 (u16 LE)
offset  8..12  03 00 00 00   frame_count = 3 (u32 LE)
offset 12..16  00 00 20 41   sample_rate_hz = 10.0 (f32 LE)
offset 16..20  00 00 20 41   source_sample_rate_hz = 10.0 (f32 LE)
offset 20..24  00 00 00 00   flags = 0 (u32 LE)
```

Spot checks an implementer can verify without decoding the whole blob:

- Bytes 24..35 (frame 0, keypoint 0):
  `00 00 00 3f cd cc 4c 3e 33 33 73 3f`
  = f32 LE `(0.5, 0.2, 0.95)`.
- Bytes 84..95 (frame 0, keypoint 5 = offset `24 + 5*12`):
  `66 66 e6 3e 33 33 b3 3e 66 66 66 3f`
  = f32 LE `(0.45, 0.35, 0.9)`.
- Bytes 228..431 (frame 1): all `00` → decoder MUST report frame 1
  as missing.
- Bytes 432..443 (frame 2, keypoint 0):
  `5c 8f 02 3f 3d 0a 57 3e d7 a3 70 3f`
  = f32 LE `(0.51, 0.21, 0.94)`.

Full blob hex (636 bytes; offset : 16 bytes/line):

```
0000  54 4b 50 31 01 00 11 00 03 00 00 00 00 00 20 41
0010  00 00 20 41 00 00 00 00 00 00 00 3f cd cc 4c 3e
0020  33 33 73 3f 00 00 00 00 00 00 00 00 00 00 00 00
0030  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0040  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0050  00 00 00 00 66 66 e6 3e 33 33 b3 3e 66 66 66 3f
0060  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0070  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0080  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0090  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00a0  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00b0  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00c0  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00d0  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00e0  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00f0  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0100  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0110  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0120  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0130  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0140  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0150  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0160  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0170  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0180  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0190  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
01a0  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
01b0  5c 8f 02 3f 3d 0a 57 3e d7 a3 70 3f 00 00 00 00
01c0  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
01d0  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
01e0  00 00 00 00 00 00 00 00 00 00 00 00 1f 85 eb 3e
01f0  ec 51 b8 3e 0a d7 63 3f 00 00 00 00 00 00 00 00
0200  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0210  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0220  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0230  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0240  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0250  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0260  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0270  00 00 00 00 00 00 00 00 00 00 00 00
```

### 11.2 Gap handling check

Using the §11.1 vector: a conformant decoder MUST report exactly
3 frames, with frame 1 flagged missing (all 17 confidences `== 0.0f`)
and frames 0 and 2 present. A conformant renderer MUST NOT draw a
skeleton for frame 1 and MUST NOT interpolate a pose between frames 0
and 2.

### 11.3 Resampling check

Source: 5 frames at `source_sample_rate_hz = 24.0`
(timestamps 0, 1/24, 2/24, 3/24, 4/24 s).
Canonical `frame_count = floor(((5 - 1) / 24) * 10) + 1 = 2`.

- Canonical frame 0 at `t = 0.0` → `p = 0.0` → exactly source frame 0.
- Canonical frame 1 at `t = 0.1` → `p = 2.4` → `i = 2`, `frac = 0.4` →
  `0.6 * S[2] + 0.4 * S[3]` per channel.
  Worked: if `S[2].nose.x = 0.50` and `S[3].nose.x = 0.55`, the
  canonical nose x = `0.6 * 0.50 + 0.4 * 0.55 = 0.52`.
- If `S[3]` were a gap frame, canonical frame 1 MUST be a gap
  (gaps break interpolation, §6) — not `0.6 * S[2]`.

## 12. Training segments (`TKS1`)

The farm keeps whole-session `TKP1` blobs only while the contributing
account exists, and never exports them. What it exports for training is
**segments**: short windows cut around each confirmed clip, re-targeted
onto a standard body (`BACKEND_DESIGN.md` §1.2.24). A segment blob is a
separate format, `TKS1`, because its keypoint set differs from `TKP1`'s
(§9). It is written only by the farm and read only by the training
pipeline. Files are named `segments/<segment_id>.tks1.gz`, where
`segment_id` is a random UUIDv4 with no relation to the source.

### 12.1 Layout

The same shape as `TKP1` (§2–§3): a 24-byte header, then a dense
`[frame][joint][channel]` float32 array, little-endian, the whole blob
gzipped as one member. Total size `24 + frame_count × 156` bytes.

| Offset | Size | Type    | Field            | Value / constraint                     |
|--------|------|---------|------------------|----------------------------------------|
| 0      | 4    | char[4] | `magic`          | ASCII `"TKS1"` (`0x54 0x4B 0x53 0x31`) |
| 4      | 2    | u16     | `format_version` | `1`                                    |
| 6      | 2    | u16     | `keypoint_count` | `13`                                   |
| 8      | 4    | u32     | `frame_count`    | `>= 1`                                 |
| 12     | 4    | f32     | `sample_rate_hz` | `10.0`                                 |
| 16     | 8    | —       | reserved         | MUST be zero (no source rate, no flags) |

Byte offset of joint `k` (0–12), channel `c` (0 = x, 1 = y,
2 = confidence) in frame `f`:

```
offset = 24 + ((f * 13 + k) * 3 + c) * 4
```

### 12.2 Joints

| Index | Joint          | From `TKP1`                  |
|-------|----------------|------------------------------|
| 0     | head           | mean of the detected keypoints 0–4 |
| 1     | left_shoulder  | 5                            |
| 2     | right_shoulder | 6                            |
| 3     | left_elbow     | 7                            |
| 4     | right_elbow    | 8                            |
| 5     | left_wrist     | 9                            |
| 6     | right_wrist    | 10                           |
| 7     | left_hip       | 11                           |
| 8     | right_hip      | 12                           |
| 9     | left_knee      | 13                           |
| 10    | right_knee     | 14                           |
| 11    | left_ankle     | 15                           |
| 12    | right_ankle    | 16                           |

### 12.3 Coordinates

Segment coordinates are not image coordinates. They are in **torso
lengths** in a body-centered frame, with the same axis directions as
`TKP1` (x right, y down in the original picture):

- The **root** is the hip midpoint (`TKP1` 11 and 12). Root positions
  are centered on their mean over the segment and divided by the
  segment's median torso length (hip midpoint to shoulder midpoint, in
  `TKP1` units). Root motion, such as a jump, survives; the subject's
  place in the picture does not. The root itself is not stored; it is
  the midpoint of joints 7 and 8.
- Every other joint is placed from its parent along the **observed bone
  direction** at the **standard bone length**, so joint angles survive
  and limb proportions do not. Parents: hips from the root; the shoulder
  midpoint from the root; shoulders and the head from the shoulder
  midpoint; elbows from shoulders, wrists from elbows; knees from hips,
  ankles from knees. Standard lengths, in torso lengths:

  | Bone                          | Length |
  |-------------------------------|--------|
  | root → shoulder midpoint      | 1.00   |
  | root → each hip               | 0.20   |
  | shoulder midpoint → each shoulder | 0.35 |
  | shoulder midpoint → head      | 0.45   |
  | shoulder → elbow              | 0.55   |
  | elbow → wrist                 | 0.50   |
  | hip → knee                    | 0.85   |
  | knee → ankle                  | 0.80   |

- Independent Gaussian noise with standard deviation **0.02** torso
  lengths is added to each stored joint's x and y.
- `confidence` is the observed `TKP1` confidence of the joint (for the
  head, the mean over the keypoints 0–4 it used), never noised.

### 12.4 Missing data

- A joint is missing ⟺ its confidence is `0.0f`; its three floats are
  then all `0.0f`. A joint is missing when it was not detected, when its
  parent is missing, or when it coincides with its parent.
- A frame missing either hip has no root, so all 13 joints are missing:
  a **gap frame** (156 zero bytes), as in §7.
- Decoders MUST treat missing joints and gap frames as missing data and
  never interpolate across them.

### 12.5 Decoder conformance

A decoder MUST reject a blob whose `magic != "TKS1"`,
`format_version != 1`, `keypoint_count != 13`,
`sample_rate_hz != 10.0`, any nonzero reserved byte, or whose length
after gunzip is not `24 + frame_count × 156`.

### 12.6 What a segment omits

A segment carries no source id, video id, account, timestamp, capture
rate, image position or limb proportions. The farm cuts at most one
segment per clip and keeps no two segments of a source that overlap or
lie within 1 second of each other, so a session can't be stitched back
together from its segments (`BACKEND_DESIGN.md` §1.2.24).
