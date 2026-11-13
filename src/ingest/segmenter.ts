// The segmenter (BACKEND_DESIGN.md §1.2.24): cuts training segments out of
// a source's canonical blob whenever its clips or labels change. It runs
// on the ingest poller's interval, because clips arrive after ingest: a
// source is cut once its blob is stored and again after every clip or
// label write, which mark it with `sources.segments_dirty_at`.
//
// Per dirty source:
//   1. Read its labeled clips; fetch the canonical blob and check its
//      digest against `sources.sha256`.
//   2. Choose and re-target the segments (segments.ts); PUT each new
//      segment blob under a fresh random id.
//   3. One transaction: claim the work by compare-and-set on
//      `segments_dirty_at` (a write since step 1 loses the claim), replace
//      the source's segment rows, labels and links.
//   4. Delete the replaced segment blobs.
// A failure before step 3 leaves new blobs with no rows; they are deleted
// on the way out, and the source stays dirty for the next run. A failure
// in step 4 leaves blobs no row points at; they hold transformed pose
// only and are logged by key, never next to a source id.
//
// Logs never put a segment id next to a source id: that pair is the link
// the design deletes with the account (§8).

import type { SQL } from "bun";
import { transaction } from "../db";
import type { BlobStore } from "./store";
import {
  chooseSegments,
  cryptoRng,
  encodeTks1,
  retargetSegment,
  type Rng,
  splitBucket,
} from "./segments";
import { decodeTkp1, gunzipStaged, gzipCanonical } from "./tkp1";

/** Most dirty sources one run cuts; the next run picks up the rest. */
export const SEGMENTER_BATCH = 20;

export const SEGMENT_PREFIX = "segments/";
export const segmentKeyFor = (segmentId: string): string => `${SEGMENT_PREFIX}${segmentId}.tks1.gz`;

export interface SegmenterDeps {
  sql: SQL;
  store: BlobStore;
  rng?: Rng;
  batch?: number;
}

interface LabeledClip {
  startFrame: number;
  endFrame: number;
  proposalModelVersion: string | null;
  suggestedNames: string[];
  suggestionsWithheld: boolean;
  labels: { trickName: string; origin: string; taxonomyVersion: number }[];
}

export type SegmentOutcome = "cut" | "superseded";

export interface SegmenterSummary {
  cut: number;
  superseded: number;
  failed: number;
}

// One run over the dirty sources. Per-source failures are counted, never
// thrown, so one bad source can't stall the rest.
export async function segmentDirtySources(deps: SegmenterDeps): Promise<SegmenterSummary> {
  const dirty = await deps.sql`
    SELECT id FROM sources
    WHERE segments_dirty_at IS NOT NULL
      AND sha256 IS NOT NULL
      AND (segments_cut_at IS NULL OR segments_cut_at <> segments_dirty_at)
    ORDER BY segments_dirty_at, id
    LIMIT ${deps.batch ?? SEGMENTER_BATCH}`;
  const summary: SegmenterSummary = { cut: 0, superseded: 0, failed: 0 };
  for (const { id } of dirty as { id: string }[]) {
    try {
      const outcome = await segmentSource(deps, id);
      if (outcome === "cut") summary.cut++;
      else summary.superseded++;
    } catch (err) {
      summary.failed++;
      console.warn("segmenter: a source failed; it stays dirty for the next run:", err);
    }
  }
  return summary;
}

export async function segmentSource(deps: SegmenterDeps, sourceId: string): Promise<SegmentOutcome> {
  const [source] = await deps.sql`
    SELECT r2_key, sha256, frame_count,
           to_char(segments_dirty_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS dirty_iso
    FROM sources WHERE id = ${sourceId}`;
  if (!source || source.sha256 === null || source.dirty_iso === null) return "superseded";
  const dirtyIso = source.dirty_iso as string;

  const clips = await labeledClips(deps.sql, sourceId);

  const stored = await deps.store.get(source.r2_key as string);
  if (stored === null) throw new Error("canonical blob missing");
  const digest = new Bun.CryptoHasher("sha256").update(stored.bytes).digest("hex");
  if (digest !== source.sha256) throw new Error("canonical blob digest mismatch");
  const pose = decodeTkp1(await gunzipStaged(stored.bytes));

  const rng = deps.rng ?? cryptoRng;
  const bucket = splitBucket(sourceId);
  const fresh: {
    id: string;
    r2Key: string;
    sha256: string;
    frameCount: number;
    windowStart: number;
    windowEnd: number;
    clip: LabeledClip;
  }[] = [];
  try {
    for (const cut of chooseSegments(clips, pose.frameCount)) {
      const frames = retargetSegment(pose, cut.from, cut.to, rng);
      if (frames === null) continue;
      const id = crypto.randomUUID();
      const bytes = gzipCanonical(encodeTks1(frames));
      const r2Key = segmentKeyFor(id);
      await deps.store.put(r2Key, bytes, "application/gzip");
      fresh.push({
        id,
        r2Key,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        frameCount: frames.length,
        windowStart: cut.clip.startFrame - cut.from,
        windowEnd: cut.clip.endFrame - cut.from,
        clip: cut.clip,
      });
    }

    const replaced = await transaction(deps.sql, async (tx) => {
      const [claimed] = await tx`
        UPDATE sources SET segments_cut_at = segments_dirty_at
        WHERE id = ${sourceId} AND segments_dirty_at = ${dirtyIso}::timestamptz
        RETURNING id`;
      if (!claimed) return null;
      const old = (await tx`
        DELETE FROM training_segments
        WHERE id IN (SELECT segment_id FROM segment_sources WHERE source_id = ${sourceId})
        RETURNING r2_key`) as { r2_key: string }[];
      for (const s of fresh) {
        await tx`
          INSERT INTO training_segments
            (id, r2_key, sha256, frame_count, window_start, window_end, split_bucket,
             proposal_model_version, suggested_names, suggestions_withheld)
          VALUES (${s.id}::uuid, ${s.r2Key}, ${s.sha256}, ${s.frameCount}, ${s.windowStart},
                  ${s.windowEnd}, ${bucket}, ${s.clip.proposalModelVersion},
                  ${pgTextArray(s.clip.suggestedNames)}::text[], ${s.clip.suggestionsWithheld})`;
        for (const l of s.clip.labels) {
          await tx`
            INSERT INTO training_segment_labels (segment_id, trick_name, origin, taxonomy_version)
            VALUES (${s.id}::uuid, ${l.trickName}, ${l.origin}, ${l.taxonomyVersion})`;
        }
        await tx`INSERT INTO segment_sources (segment_id, source_id) VALUES (${s.id}::uuid, ${sourceId})`;
      }
      return old.map((o) => o.r2_key);
    });

    if (replaced === null) {
      // A write landed after this run read the source: the next run cuts
      // again from the newer state.
      await deleteBlobs(deps.store, fresh.map((s) => s.r2Key));
      return "superseded";
    }
    await deleteBlobs(deps.store, replaced);
    return "cut";
  } catch (err) {
    await deleteBlobs(deps.store, fresh.map((s) => s.r2Key));
    throw err;
  }
}

async function labeledClips(sql: SQL, sourceId: string): Promise<LabeledClip[]> {
  const rows = (await sql`
    SELECT c.id, c.start_frame, c.end_frame, c.proposal_model_version, c.suggested_names,
           c.suggestions_withheld, l.trick_name, l.origin, l.taxonomy_version
    FROM clips c
    JOIN labels l ON l.clip_id = c.id
    WHERE c.source_id = ${sourceId}
    ORDER BY c.id, l.trick_name`) as Record<string, any>[];
  const byClip = new Map<string, LabeledClip>();
  for (const r of rows) {
    let clip = byClip.get(r.id);
    if (!clip) {
      clip = {
        startFrame: r.start_frame,
        endFrame: r.end_frame,
        proposalModelVersion: r.proposal_model_version,
        suggestedNames: r.suggested_names ?? [],
        suggestionsWithheld: r.suggestions_withheld,
        labels: [],
      };
      byClip.set(r.id, clip);
    }
    clip.labels.push({ trickName: r.trick_name, origin: r.origin, taxonomyVersion: r.taxonomy_version });
  }
  return [...byClip.values()];
}

// Bun's SQL tag doesn't bind a JS array as a Postgres array; build the
// literal, quoting every element.
function pgTextArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`;
}

async function deleteBlobs(store: BlobStore, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    try {
      await store.delete(key);
    } catch (err) {
      console.warn(`segmenter: could not delete ${key}:`, err);
    }
  }
}

// The segment rows and blobs linked to a source, for the paths that
// delete the source outright (DELETE /api/sources/:id, a quarantine
// purge): the owner asked for the data to go, or it is poison.
export async function linkedSegmentKeys(sql: SQL, sourceId: string): Promise<string[]> {
  const rows = (await sql`
    SELECT t.r2_key FROM segment_sources ss
    JOIN training_segments t ON t.id = ss.segment_id
    WHERE ss.source_id = ${sourceId}`) as { r2_key: string }[];
  return rows.map((r) => r.r2_key);
}

/** Deletes the segment rows linked to a source; returns their blob keys. */
export async function deleteLinkedSegmentRows(tx: SQL, sourceId: string): Promise<string[]> {
  const rows = (await tx`
    DELETE FROM training_segments
    WHERE id IN (SELECT segment_id FROM segment_sources WHERE source_id = ${sourceId})
    RETURNING r2_key`) as { r2_key: string }[];
  return rows.map((r) => r.r2_key);
}

// The poller for the segmenter, on the ingest interval. Returns a stop
// function for tests and shutdown.
export function startSegmenter(deps: SegmenterDeps, intervalMs: number): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const s = await segmentDirtySources(deps);
      if (s.cut + s.superseded + s.failed > 0) {
        console.log(`segmenter: ${s.cut} cut, ${s.superseded} superseded, ${s.failed} failed`);
      }
    } catch (err) {
      console.error("segmenter run failed:", err);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
