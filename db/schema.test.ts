// Checks a migrated database against BACKEND_DESIGN.md §3 (with the sessions
// and unlinking changes). Runs only when TEST_DATABASE_URL is set; see
// db/testing.ts.

import { type SavepointSQL, SQL, type TransactionSQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "./testing";

const SOURCE_ID = "a".repeat(64);
const DIGEST = "b".repeat(64);
const KEY_HASH = "d".repeat(64);

describe.skipIf(!TEST_DATABASE_URL)("schema (BACKEND_DESIGN.md §3)", () => {
  const sql = new SQL(TEST_DATABASE_URL ?? "");
  afterAll(() => sql.close());

  // Runs one statement under a savepoint and returns the name of the
  // constraint it violated (undefined if it succeeded), leaving the
  // enclosing transaction usable.
  async function violation(
    tx: TransactionSQL,
    statement: (sp: SavepointSQL) => Promise<unknown>,
  ): Promise<string | undefined> {
    try {
      await tx.savepoint(statement);
      return undefined;
    } catch (err) {
      if (err instanceof SQL.PostgresError && err.constraint) return err.constraint;
      throw err;
    }
  }

  // One source with one clip; returns the clip ID.
  async function insertClip(tx: TransactionSQL): Promise<string> {
    await tx`
      INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, r2_key)
      VALUES (${SOURCE_ID}, ${KEY_HASH}, 600, 30, ${`poses/${SOURCE_ID}.tkp1.gz`})`;
    const [clip] = await tx`
      INSERT INTO clips (source_id, start_frame, end_frame)
      VALUES (${SOURCE_ID}, 120, 175)
      RETURNING id`;
    return clip.id;
  }

  test("has exactly the §3 tables", async () => {
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`;
    expect(rows.map((r: { table_name: string }) => r.table_name)).toEqual([
      "clips",
      "consents",
      "data_quarantine",
      "label_candidates",
      "label_taxonomy",
      "labels",
      "model_training_sources",
      "models",
      "reports",
      "schema_migrations", // dbmate's applied-version ledger
      "segment_sources",
      "sessions",
      "source_attribution",
      "sources",
      "training_segment_labels",
      "training_segments",
      "users",
    ]);
  });

  test("has exactly the §3 indexes, including those behind PK and UNIQUE constraints", async () => {
    const rows = await sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
      ORDER BY tablename, indexname`;
    expect(rows.map((r: { indexdef: string }) => r.indexdef)).toEqual([
      "CREATE UNIQUE INDEX clips_pkey ON public.clips USING btree (id)",
      "CREATE INDEX clips_source_id_idx ON public.clips USING btree (source_id)",
      "CREATE UNIQUE INDEX consents_pkey ON public.consents USING btree (user_id, disclosure_version)",
      "CREATE INDEX data_quarantine_open_idx ON public.data_quarantine USING btree (quarantined_at) WHERE (resolved_at IS NULL)",
      "CREATE UNIQUE INDEX data_quarantine_open_uniq ON public.data_quarantine USING btree (source_id) WHERE (resolved_at IS NULL)",
      "CREATE UNIQUE INDEX data_quarantine_pkey ON public.data_quarantine USING btree (id)",
      "CREATE INDEX label_candidates_account_hash_idx ON public.label_candidates USING btree (account_hash)",
      "CREATE UNIQUE INDEX label_candidates_name_account_uniq ON public.label_candidates USING btree (lower(name), account_hash)",
      "CREATE INDEX label_candidates_submitted_at_idx ON public.label_candidates USING btree (submitted_at)",
      "CREATE INDEX label_taxonomy_lookup_idx ON public.label_taxonomy USING btree (raw, taxonomy_version DESC)",
      "CREATE UNIQUE INDEX label_taxonomy_pkey ON public.label_taxonomy USING btree (id)",
      "CREATE UNIQUE INDEX label_taxonomy_raw_version_uniq ON public.label_taxonomy USING btree (raw, taxonomy_version)",
      "CREATE UNIQUE INDEX labels_clip_trick_uniq ON public.labels USING btree (clip_id, lower(trick_name))",
      "CREATE UNIQUE INDEX labels_pkey ON public.labels USING btree (id)",
      "CREATE UNIQUE INDEX model_training_sources_pkey ON public.model_training_sources USING btree (source_id, model_version)",
      "CREATE UNIQUE INDEX models_pkey ON public.models USING btree (id)",
      "CREATE UNIQUE INDEX models_version_key ON public.models USING btree (version)",
      "CREATE UNIQUE INDEX reports_pkey ON public.reports USING btree (id)",
      "CREATE INDEX reports_status_idx ON public.reports USING btree (status, created_at) WHERE (status = 'open'::text)",
      "CREATE UNIQUE INDEX segment_sources_pkey ON public.segment_sources USING btree (segment_id)",
      "CREATE INDEX segment_sources_source_id_idx ON public.segment_sources USING btree (source_id)",
      "CREATE INDEX sessions_expires_at_idx ON public.sessions USING btree (expires_at)",
      "CREATE UNIQUE INDEX sessions_pkey ON public.sessions USING btree (id)",
      "CREATE UNIQUE INDEX sessions_token_hash_key ON public.sessions USING btree (token_hash)",
      "CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id)",
      "CREATE INDEX source_attribution_attributed_at_idx ON public.source_attribution USING btree (attributed_at)",
      "CREATE UNIQUE INDEX source_attribution_pkey ON public.source_attribution USING btree (source_id)",
      "CREATE INDEX source_attribution_user_id_idx ON public.source_attribution USING btree (user_id)",
      "CREATE UNIQUE INDEX sources_pkey ON public.sources USING btree (id)",
      "CREATE INDEX sources_segments_dirty_idx ON public.sources USING btree (segments_dirty_at) WHERE (segments_dirty_at IS NOT NULL)",
      "CREATE UNIQUE INDEX training_segment_labels_pkey ON public.training_segment_labels USING btree (segment_id, trick_name)",
      "CREATE UNIQUE INDEX training_segments_pkey ON public.training_segments USING btree (id)",
      "CREATE UNIQUE INDEX training_segments_r2_key_key ON public.training_segments USING btree (r2_key)",
      "CREATE INDEX users_last_active_at_idx ON public.users USING btree (last_active_at)",
      "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
    ]);
  });

  test("contributions carry no account column (§1.2.17)", async () => {
    const rows = await sql`
      SELECT table_name || '.' || column_name AS col FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('sources', 'data_quarantine')
        AND column_name IN ('user_id', 'source_key_hash')
      ORDER BY 1`;
    expect(rows.map((r: { col: string }) => r.col)).toEqual(["sources.source_key_hash"]);
  });

  test("seeds taxonomy version 1, so the current version is always defined (§1.2.8)", async () => {
    const [{ current }] = await sql`SELECT max(taxonomy_version) AS current FROM label_taxonomy`;
    expect(current).toBe(1);
    const [{ canonical }] = await sql`
      SELECT canonical FROM label_taxonomy WHERE raw = 'corkscrew' AND taxonomy_version = 1`;
    expect(canonical).toBe("cork");
  });

  test("sources: hex IDs, key hashes, and digests, NULL digest until ingest", async () => {
    await inRollback(sql, async (tx) => {
      await insertClip(tx);
      const insert = (id: string, sha256: string | null, keyHash = KEY_HASH) => (sp: SavepointSQL) =>
        sp`INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, r2_key, sha256)
           VALUES (${id}, ${keyHash}, 600, 10, 'k', ${sha256})`;
      expect(await violation(tx, insert("A".repeat(64), null))).toBe("sources_id_hex");
      expect(await violation(tx, insert("c".repeat(63), null))).toBe("sources_id_hex");
      expect(await violation(tx, insert("c".repeat(64), "B".repeat(64)))).toBe("sources_sha_hex");
      expect(await violation(tx, insert("c".repeat(64), null, "D".repeat(64)))).toBe("sources_source_key_hash_check");
      expect(await violation(tx, insert("c".repeat(64), DIGEST))).toBeUndefined();

      const [source] = await tx`SELECT sha256, keypoint_format FROM sources WHERE id = ${SOURCE_ID}`;
      expect(source).toEqual({ sha256: null, keypoint_format: "tkp1" });
    });
  });

  test("clips: windows are non-empty and start at frame 0 or later", async () => {
    await inRollback(sql, async (tx) => {
      await insertClip(tx);
      const insert = (start: number, end: number) => (sp: SavepointSQL) =>
        sp`INSERT INTO clips (source_id, start_frame, end_frame) VALUES (${SOURCE_ID}, ${start}, ${end})`;
      expect(await violation(tx, insert(10, 10))).toBe("clips_check");
      expect(await violation(tx, insert(-1, 10))).toBe("clips_start_frame_check");
      expect(await violation(tx, insert(0, 1))).toBeUndefined();
    });
  });

  test("labels: one row per case-insensitive trick name per clip, stored trimmed (§1.2.12)", async () => {
    await inRollback(sql, async (tx) => {
      const clipId = await insertClip(tx);
      const insert = (name: string) => (sp: SavepointSQL) =>
        sp`INSERT INTO labels (clip_id, trick_name, taxonomy_version) VALUES (${clipId}, ${name}, 1)`;
      expect(await violation(tx, insert("Cork"))).toBeUndefined();
      expect(await violation(tx, insert("cork"))).toBe("labels_clip_trick_uniq");
      expect(await violation(tx, insert(" hook"))).toBe("labels_trick_name_check");
      expect(await violation(tx, insert(""))).toBe("labels_trick_name_check");
      expect(await violation(tx, insert("hook"))).toBeUndefined();

      const rows = await tx`SELECT trick_name FROM labels WHERE clip_id = ${clipId} ORDER BY trick_name`;
      expect(rows.map((r: { trick_name: string }) => r.trick_name)).toEqual(["Cork", "hook"]);
    });
  });

  test("models: versions are unique and the artifact digest is hex", async () => {
    await inRollback(sql, async (tx) => {
      const insert = (version: string, sha256: string, modelType = "trick-detection") =>
        (sp: SavepointSQL) =>
          sp`INSERT INTO models (version, model_type, taxonomy_version, r2_key, sha256)
             VALUES (${version}, ${modelType}, 1, 'models/m.zip', ${sha256})`;
      expect(await violation(tx, insert("trick-v1.0", DIGEST))).toBeUndefined();
      expect(await violation(tx, insert("trick-v1.0", DIGEST))).toBe("models_version_key");
      expect(await violation(tx, insert("trick-v1.1", "z".repeat(64)))).toBe("models_sha256_check");
      expect(await violation(tx, insert("trick-v1.1", DIGEST, "pose"))).toBe("models_model_type_check");

      const [model] = await tx`SELECT val_metrics, name_metrics, promoted_at FROM models WHERE version = 'trick-v1.0'`;
      expect(model).toEqual({ val_metrics: {}, name_metrics: {}, promoted_at: null });
    });
  });

  test("data_quarantine: one open quarantine per source; resolution set with resolved_at (§1.2.4)", async () => {
    await inRollback(sql, async (tx) => {
      await insertClip(tx);
      const quarantine = (sp: SavepointSQL) =>
        sp`INSERT INTO data_quarantine (source_id, reason) VALUES (${SOURCE_ID}, 'regression')`;
      expect(await violation(tx, quarantine)).toBeUndefined();
      expect(await violation(tx, quarantine)).toBe("data_quarantine_open_uniq");

      const resolve = (resolvedAt: Date | null, resolution: string | null) => (sp: SavepointSQL) =>
        sp`UPDATE data_quarantine SET resolved_at = ${resolvedAt}, resolution = ${resolution}
           WHERE source_id = ${SOURCE_ID}`;
      expect(await violation(tx, resolve(null, "released"))).toBe("quarantine_resolution_consistent");
      expect(await violation(tx, resolve(new Date(), null))).toBe("quarantine_resolution_consistent");
      expect(await violation(tx, resolve(new Date(), "ignored"))).toBe("data_quarantine_resolution_check");
      expect(await violation(tx, resolve(new Date(), "released"))).toBeUndefined();

      // Once resolved, the source can be quarantined again.
      expect(await violation(tx, quarantine)).toBeUndefined();
    });
  });

  test("reports: target types are constrained and new reports are open", async () => {
    await inRollback(sql, async (tx) => {
      await tx`INSERT INTO users (id) VALUES ('user-1')`;
      const insert = (targetType: string) => (sp: SavepointSQL) =>
        sp`INSERT INTO reports (reporter_user_id, target_type, target_id, reason)
           VALUES ('user-1', ${targetType}, 'x', 'wrong trick name')`;
      expect(await violation(tx, insert("video"))).toBe("reports_target_type_check");
      expect(await violation(tx, insert("clip"))).toBeUndefined();

      const [report] = await tx`SELECT status FROM reports WHERE reporter_user_id = 'user-1'`;
      expect(report.status).toBe("open");
    });
  });

  test("sessions: one row per hashed token", async () => {
    await inRollback(sql, async (tx) => {
      await tx`INSERT INTO users (id) VALUES ('user-1')`;
      const insert = (tokenHash: string) => (sp: SavepointSQL) =>
        sp`INSERT INTO sessions (user_id, token_hash, expires_at)
           VALUES ('user-1', ${tokenHash}, now() + interval '90 days')`;
      expect(await violation(tx, insert(KEY_HASH))).toBeUndefined();
      expect(await violation(tx, insert(KEY_HASH))).toBe("sessions_token_hash_key");
      expect(await violation(tx, insert("not-hex"))).toBe("sessions_token_hash_check");
    });
  });

  test("deleting a source cascades to clips, labels, quarantine rows, and attribution", async () => {
    await inRollback(sql, async (tx) => {
      const clipId = await insertClip(tx);
      await tx`INSERT INTO users (id) VALUES ('user-1')`;
      await tx`INSERT INTO labels (clip_id, trick_name, taxonomy_version) VALUES (${clipId}, 'cork', 1)`;
      await tx`INSERT INTO data_quarantine (source_id, reason) VALUES (${SOURCE_ID}, 'regression')`;
      await tx`INSERT INTO source_attribution (source_id, user_id) VALUES (${SOURCE_ID}, 'user-1')`;

      await tx`DELETE FROM sources WHERE id = ${SOURCE_ID}`;

      const [counts] = await tx`
        SELECT (SELECT count(*) FROM clips WHERE id = ${clipId})::int                         AS clips,
               (SELECT count(*) FROM labels WHERE clip_id = ${clipId})::int                   AS labels,
               (SELECT count(*) FROM data_quarantine WHERE source_id = ${SOURCE_ID})::int     AS quarantine,
               (SELECT count(*) FROM source_attribution WHERE source_id = ${SOURCE_ID})::int  AS attribution`;
      expect(counts).toEqual({ clips: 0, labels: 0, quarantine: 0, attribution: 0 });
    });
  });

  test("deleting a user cascades to sessions, attribution, and reports, but not to sources", async () => {
    await inRollback(sql, async (tx) => {
      await insertClip(tx);
      await tx`INSERT INTO users (id) VALUES ('user-1')`;
      await tx`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ('user-1', ${KEY_HASH}, now() + interval '1 day')`;
      await tx`INSERT INTO source_attribution (source_id, user_id) VALUES (${SOURCE_ID}, 'user-1')`;
      await tx`INSERT INTO reports (reporter_user_id, target_type, target_id, reason) VALUES ('user-1', 'source', ${SOURCE_ID}, 'r')`;

      await tx`DELETE FROM users WHERE id = 'user-1'`;

      const [counts] = await tx`
        SELECT (SELECT count(*) FROM sessions WHERE user_id = 'user-1')::int                 AS sessions,
               (SELECT count(*) FROM source_attribution WHERE user_id = 'user-1')::int       AS attribution,
               (SELECT count(*) FROM reports WHERE reporter_user_id = 'user-1')::int         AS reports,
               (SELECT count(*) FROM sources WHERE id = ${SOURCE_ID})::int                   AS sources`;
      expect(counts).toEqual({ sessions: 0, attribution: 0, reports: 0, sources: 1 });
    });
  });

  test("model_training_sources: source-level membership, no account column (§1.2.20)", async () => {
    await inRollback(sql, async (tx) => {
      await insertClip(tx);
      await tx`INSERT INTO models (version, taxonomy_version, r2_key, sha256)
        VALUES ('trick-v1.3', 1, 'models/trick-v1.3', ${DIGEST})`;
      const member = (version: string, sourceId: string) => (sp: SavepointSQL) =>
        sp`INSERT INTO model_training_sources (model_version, source_id)
           VALUES (${version}, ${sourceId})`;
      // Unknown model version and unknown source both rejected.
      expect(await violation(tx, member("trick-v9.9", SOURCE_ID))).toBe(
        "model_training_sources_model_version_fkey",
      );
      expect(await violation(tx, member("trick-v1.3", "c".repeat(64)))).toBe(
        "model_training_sources_source_id_fkey",
      );
      expect(await violation(tx, member("trick-v1.3", SOURCE_ID))).toBeUndefined();
      // Same (source, version) pair recorded twice is one row.
      expect(await violation(tx, member("trick-v1.3", SOURCE_ID))).toBe(
        "model_training_sources_pkey",
      );
      // Deleting the source cascades the membership rows; deleting nothing
      // else does.
      await tx`DELETE FROM sources WHERE id = ${SOURCE_ID}`;
      const [{ count }] = await tx`SELECT count(*)::int AS count FROM model_training_sources`;
      expect(count).toBe(0);
      const [{ models }] = await tx`SELECT count(*)::int AS models FROM models`;
      expect(models).toBe(1);
    });
  });
});
