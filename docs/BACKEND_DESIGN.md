# Turnip Farm — Database + API Design

**Scope.** This document is the detailed backend design for `turnip-farm`,
implementing the contract in the master plan
(`https://github.com/hoiekim/turnip-farm/blob/main/docs/MASTER_PLAN.md`,
Rev 5). It specifies the Postgres schema, index strategy, upsert
semantics, the training-data export pattern, and the full REST API, at a
level of detail intended to be implementable without guessing. Companion
documents: the pose wire-format specification (`POSE_FORMAT.md`); the iOS
contribution design and the ML training design are specified separately.
Stack: Bun + TypeScript + Postgres + R2, per the master plan.

## 1. Design decisions

### 1.1 Labels: Clip → Label is one-to-many (explicit decision)

The master plan states the hierarchy **Source → Clip → Label, one-to-many
at every level**, but its drafted schema also said `labels.clip_id UNIQUE`
with exactly one label row per clip holding a `TEXT[]` of trick names —
which is effectively Clip → Label one-to-one with the multiplicity pushed
into an array column. This document resolves that inconsistency **in favor
of the stated one-to-many hierarchy**:

- **One label row per `(clip_id, trick_name)`.**
- Each row carries its own `origin` (§1.2.18), `taxonomy_version`,
  `created_at`, `updated_at`.
- Re-submission of a clip's labels **replaces the clip's whole label set in
  a single transaction** (DELETE existing rows for the clip, INSERT the new
  set). No merge logic, no array surgery.

**Rationale.** The maintainer specified one-to-many at every level; per-name
rows make per-name provenance exact (which taxonomy version was in effect
when *that* name was confirmed, when it was first seen) instead of smearing
it across an array; set-replacement keeps the client's "confirm →
contribute" flow idempotent; and `UNIQUE(clip_id, trick_name)` gives the
database, not application code, the job of deduplicating re-submissions.

Two departures from the master plan's label draft follow from this:

- **No per-label `user_id`.** Only the source's owner ever submits labels
  (the confirmed contribution flow has no community labeling queue), so
  attribution is `labels → clips → sources → source_attribution`, which
  is also the attribution the quarantine flow uses, and it exists only
  for 30 days after the source's last write (§1.2.17). A per-label
  `user_id` would be a second, longer-lived link to the same account.
- **No per-label `start_frame` / `end_frame`.** The label window *is* the
  clip window. The training target is one segment per confirmed clip window
  (master plan §6), so a second, label-level window is redundant. If a
  labeler tightens a window, they edit the clip and re-confirm.

### 1.2 Judgment calls (master plan silent or ambiguous)

1. `models.sha256` added — the model manifest must carry a checksum
   (master plan §4), so the digest lives on the row.
2. `data_quarantine.metrics JSONB` kept from the master plan draft — a
   snapshot of the regression metrics that triggered the quarantine, for
   the review queue.
3. **Purge = hard delete of the source row** (cascades to clips/labels;
   the R2 blob is deleted too). Consequence: "exclude quarantined sources
   from training" is implemented as "exclude sources with an *open*
   (unresolved) quarantine row". A released source rejoins training; a
   purged source is gone entirely.
4. One open quarantine per source, enforced by a partial unique index.
5. Single-resource GETs return **404 (not 403)** for resources the caller
   does not own, so resource IDs are not usable as an ownership oracle.
6. Follows the master plan's `GET /api/models/current` naming for the
   model manifest endpoint (an earlier draft used `/latest`).
7. Pipeline endpoints (`POST /api/models`, `GET /api/labels/export`)
   authenticate with a **service API key**, not Sign in with Apple.
8. Current taxonomy version = `max(taxonomy_version)` over
   `label_taxonomy`; the seed migration inserts version 1, so it is always
   defined.
9. `r2_key` is deterministic: `poses/<source_id>.tkp1.gz`.
   Re-contribution overwrites the same key.
10. Blob integrity is two-layered, because the farm resamples on ingest
    and stores canonical-only (POSE_FORMAT.md §6):
    - **Transport.** The presigned PUT URL requires the client to attach
      a content checksum (`Content-MD5` or `x-amz-checksum-sha256`);
      storage rejects a corrupted upload at write time. The client never
      supplies the stored digest.
    - **Stored.** `sources.sha256` is the SHA-256 of the **canonical**
      `.tkp1.gz` blob bytes as stored — computed by the farm at ingest,
      after resampling to 10 Hz; NULL until ingest completes. A digest of
      the as-sent bytes would be invalidated by ingest for every
      non-10 Hz contribution, so it is never stored.
    A farm-side ingest worker resamples the staged upload to canonical
    10 Hz, stores it at `r2_key`, sets `sources.sha256`, and deletes the
    staged object. Clip submission re-verifies the stored blob against
    `sources.sha256` (`422 BLOB_DIGEST_MISMATCH`); a NULL digest means
    the blob is not ingested yet (`422 BLOB_MISSING`). A source row
    registered but never uploaded is a harmless dangling row that
    self-heals on re-contribution.
11. `updated_at` is set explicitly in every upsert's `DO UPDATE` clause;
    no database triggers.
12. Label names are trimmed at the API boundary; case-insensitive
    duplicates are deduped pre-insert (§5) — a unique index rejects
    duplicates, it does not collapse them. Uniqueness is enforced on
    `(clip_id, lower(trick_name))`; the original casing is preserved in
    storage and the raw string is never altered.
13. **Source ownership is first-writer-wins, proven by a source key.**
    The first contribution of a `video_id` sets its source key: 32 random
    bytes the client generates and keeps (§7.2); the farm stores only
    `sources.source_key_hash`, which is never overwritten. Every later
    read or write of that source must present the key. Rationale: for
    imported files the `video_id` is `SHA-256(file bytes)`, so two
    contributors importing the byte-identical file compute the identical
    ID (master plan §1 caveat). Transferring ownership to the second
    writer would let strangers claim each other's sources; keeping the
    first writer also matches the dedup intent (the second identical
    contribution carries no new bytes). A second contributor registering
    an already-claimed `video_id` without its key receives
    `409 SOURCE_ALREADY_CLAIMED`. Ownership is a key rather than an
    account, so the farm can serve owners without linking sources to
    accounts (§1.2.17).
14. **Sessions, not per-request identity tokens.** Apple's guidance is
    to verify the identity token once and then run your own session:
    "After verifying the identity token, your app is responsible for
    managing the user session", and "User interaction is required any
    time a new identity token is requested" (Apple, *Verifying a user*).
    Identity tokens are observed to expire about ten minutes after issue
    (Apple doesn't document the figure), and the device cannot refresh
    them silently, so verifying them on every request would lock users
    out minutes after sign-in. The farm verifies the identity token
    once, at `POST /api/auth/apple`, and issues its own opaque session
    token (§7.1). The API stays stateless in the deployment sense:
    sessions live in Postgres, not in process memory.
15. **Apple's refresh token is kept, encrypted, for revocation only.**
    App Review guideline 5.1.1(v) requires in-app account deletion, and
    apps using Sign in with Apple should revoke the user's tokens through
    the REST API when an account is deleted. Revocation needs a refresh
    or access token, so sign-in exchanges the authorization code and
    stores the refresh token encrypted (§3, §7.1). Revoking it
    invalidates "the tokens and associated user authorizations for a
    user" (Apple, *Token revocation*), so the latest token per user is
    enough even across devices; each sign-in replaces it. The farm does
    **not** run Apple's optional daily refresh-token validation: Apple
    throttles it, server-to-server notifications (§7.3) report revoked
    consent and deleted Apple Accounts, and the client checks
    `getCredentialState` on launch (§7.1).
16. **Blocked users can still leave.** `is_blocked` removes contribution
    rights, not the right to sign out or delete the account (§7.1).
17. **Contributions are linked to an account for 30 days at most.** The
    farm needs to know *who* contributed for one purpose: finding and
    blocking an account that poisons the dataset (master plan §6), which
    takes days, not years. So `sources` carries no account column.
    Instead, a `source_attribution` row links a source to the account
    that last wrote it. Every contribution write refreshes it, and it is
    deleted 30 days after the source's last write: a source that is still
    being edited stays linked, and one left alone is unlinked 30 days
    after its last edit. Nothing else needs the link. Ownership is the
    source key (§1.2.13), training splits by source rather than by user,
    and reputation is not computed from contributions (§9 Q2). Reports
    are the one other place an account meets a contribution:
    `reports.reporter_user_id` sits next to a `target_id`, and since
    only a source's key holder can see it, the reporter is usually its
    contributor. Reports are therefore deleted 30 days after they are
    filed, by the same purge (§4). Once unlinked, the farm treats a
    contribution as belonging to no account.
    Some linkage remains possible outside the farm's records: a pose
    sequence can be matched against a public video of the person in it,
    and anyone holding an imported file can recompute its `video_id`.
    Whether that makes unlinked contributions personal data is a question
    for counsel (§9 Q9).
    *Re-weighed and kept, 2026-10-15* (master plan §1). Linking would
    buy complete account deletion, splits by person, per-labeler
    reliability, and restore on any device; it would cost one
    re-identified video identifying every other video under the same
    account. The app's Profile tab needs no link (§1.2.21). Unlinking is
    not a one-way door: the client keeps every source's key, so a future
    opt-in "link my contributions" call, taking source keys, can re-link
    the sources whose keys it still holds, on the user's say. *Reopen
    if:* counsel answers §9 Q9 that unlinked pose sequences are personal
    data anyway, or a social feature is put on the roadmap. A reversal
    lands before the first deployment, while restoring `sources.user_id`
    is a plain additive migration.
18. **Labels carry provenance, never identity.** Each label row records
    its `origin`: `typed` (typed by hand), `vocabulary` (picked from the
    vocabulary's suggestions), or `model` (pre-filled by the trick model
    and kept). Each clip records `proposal_model_version` (the
    `models.version` that proposed its window or names; NULL for the
    heuristic detector or a manual clip), `suggested_names` (the names
    that model pre-filled — or, on a blind clip, would have — kept or
    removed, so a removed suggestion is a known disagreement;
    `MODEL_CONTRACT.md` §3.3), and `suggestions_withheld` (the client
    showed no model names for this clip: the blind sample, master plan
    §6).
    Training needs all four to tell a name the user gave from a
    suggestion the user let stand (`TRAINING_DESIGN.md`). They are
    client-reported and unverifiable, like the names themselves, and
    describe how a label was made, not who made it.
    `proposal_model_version` is TEXT without a foreign key: a client
    can report a version the farm has since rolled back past, and
    `models` rows are never deleted anyway.
19. **The manifest and the vocabulary are public.**
    `GET /api/models/current` and `GET /api/taxonomy/current` need no
    session (§7.1). Neither holds
    anything user-specific, and the app has to reach both for users who
    never sign in: naming and the Profile work without an account, and
    a model that only signed-in users could download would leave
    everyone else on the heuristic detector. Both are rate-limited per
    client IP.
20. **Training membership is source-level.** `model_training_sources`
    records which sources trained each promoted model, so an owner can
    see that their contribution went into a model
    (`GET /api/sources/:id` → `trained_in`). The pipeline sends the list
    with `POST /api/models`. It holds no account and cascades with the
    source; ids of sources deleted between training and publish are
    skipped, not rejected.
21. **No profile state.** The app's Profile tab (achievements, levels,
    progress, the gallery, highlights) is computed on the device and
    never sent here (master plan §1). There is no profile,
    achievement, score, or leaderboard table, and adding one needs the
    master plan's reopen condition first: it would have to know whose
    contributions are whose, which §1.2.17 removes.
22. **Quarantine review transitions are pipeline-key endpoints.**
    `POST /api/quarantine/:source_id/release` and `/purge` authenticate
    with the pipeline service key — the only non-user credential in the
    system; the maintainer operates the pipeline, so no separate admin
    auth exists yet. Purge hard-deletes the source (§1.2.3), so a
    `resolution='purged'` row never survives on its own: the quarantine
    row cascades with the source it condemned.
23. **The export page size is a deployment constant, not a parameter.**
    `GET /api/labels/export` pages at a fixed 10000 rows; the pipeline
    never asks for a different size, and a client-controlled limit is a
    memory-exhaustion knob on a joined query. Tests override it through
    the handler's deps to cross the `LIMIT` boundary cheaply.

## 2. Conventions

- Postgres 16+. Additive migrations via `dbmate` (`db/migrations/`),
  never destructive; every migration is additive and re-runnable.
  One-time exception (maintainer decision, 2026-10-12): unlinking
  sources from accounts (§1.2.17) drops `sources.user_id` and
  `data_quarantine.user_id`. This is allowed because it lands before
  the first deployment, when no environment holds data. After it,
  earlier migrations can re-apply only to the schema they produced, so
  the re-runnability check is per migration: CI unrecords the newest
  migration and applies it again.
- `CREATE EXTENSION IF NOT EXISTS pgcrypto;` for `gen_random_uuid()`.
- All timestamps `TIMESTAMPTZ`, `DEFAULT now()`.
- Identifiers: `sources.id` is the deterministic 64-char lowercase hex
  digest from the client; `clips.id` is a client-minted UUIDv4 the farm
  never mints; every other PK is `gen_random_uuid()`.
- No PII columns anywhere (see §8).

## 3. Tables

```sql
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  -- Sign in with Apple `sub` claim: per-app opaque pseudonymous subject.
  -- No name, email, or other Apple profile data is stored.
  reputation  DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  -- Unused: reputation is not computed from contributions (§1.2.17, §9 Q2).
  is_blocked  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  apple_refresh_token BYTEA
  -- Apple refresh token from the sign-in code exchange (§7.1), used only
  -- to revoke the user's authorization on account deletion (§1.2.15).
  -- AES-256-GCM under APPLE_REFRESH_TOKEN_KEY with users.id as additional
  -- authenticated data, stored as 12-byte nonce || ciphertext || 16-byte
  -- tag. NULL after consent-revoked (§7.3).
);

CREATE TABLE sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- Lowercase hex SHA-256 of the session token (§7.1). The token itself
  -- is never stored, so a leaked table or backup yields no credentials.
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Refreshed at most once a day (§7.1), so reads don't become writes.
  expires_at   TIMESTAMPTZ NOT NULL
  -- Idle expiry: 90 days after last_used_at.
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE sources (
  id              CHAR(64) PRIMARY KEY,
  -- Deterministic video_id (master plan §1): SHA-256 hex of
  -- "turnip:phasset:" + PHAsset.localIdentifier (Photos videos) or of the
  -- file bytes (imports). The farm never mints source identities.
  source_key_hash CHAR(64) NOT NULL CHECK (source_key_hash ~ '^[0-9a-f]{64}$'),
  -- Lowercase hex SHA-256 of the owner's source key (§1.2.13, §7.2). Set
  -- by the first contribution, never overwritten. There is no account
  -- column: the link to an account lives in source_attribution.
  frame_count     INTEGER NOT NULL CHECK (frame_count > 0),
  -- Canonical 10 Hz frame count of the stored pose sequence. The client
  -- computes it from its analysis rate via the POSE_FORMAT.md §6 resampling map;
  -- clip windows are validated against it, so every index the API
  -- accepts is canonical.
  sample_rate     REAL NOT NULL,
  -- As-sent analysis rate, provenance only. Stored pose data is canonical
  -- 10 Hz pose format (see POSE_FORMAT.md §6).
  keypoint_format TEXT NOT NULL DEFAULT 'tkp1',
  r2_key          TEXT NOT NULL,
  -- Deterministic: poses/<id>.tkp1.gz. Holds the canonical 10 Hz blob;
  -- the as-sent upload lands on a staging key and is promoted at ingest
  -- (§1.2.10). Re-contribution overwrites.
  sha256          CHAR(64),
  -- SHA-256 of the canonical `.tkp1.gz` blob bytes as stored. Computed
  -- by the farm at ingest (POSE_FORMAT.md §6 resampling); never client-supplied;
  -- NULL until the canonical blob is stored. Distinct from `id`
  -- (digest of the asset identity).
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sources_id_hex  CHECK (id     ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sources_sha_hex CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

CREATE TABLE source_attribution (
  source_id     CHAR(64) PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The account that last wrote the source (§1.2.17): the only link
  -- between a contribution and an account, kept for anti-poisoning.
  attributed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  -- Refreshed by every contribution write (§4); the row is deleted 30
  -- days after it. The farm keeps no other record of the link.
);
CREATE INDEX source_attribution_user_id_idx ON source_attribution (user_id);
CREATE INDEX source_attribution_attributed_at_idx
  ON source_attribution (attributed_at);

CREATE TABLE clips (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Client-minted once per clip; recovered from the server after
  -- reinstall (master plan §5.1), never re-derived, never minted here.
  source_id     CHAR(64) NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  start_frame   INTEGER NOT NULL CHECK (start_frame >= 0),
  end_frame     INTEGER NOT NULL CHECK (end_frame > start_frame),
  -- Frame indices into the source's canonical 10 Hz pose sequence.
  -- end_frame <= sources.frame_count is enforced at the API layer
  -- (cross-table CHECKs are not expressible in Postgres).
  auto_detected BOOLEAN NOT NULL DEFAULT FALSE,
  proposal_model_version TEXT,
  -- models.version of the trick model that proposed this clip's window or
  -- names; NULL for the heuristic detector or a manual clip (§1.2.18).
  suggested_names TEXT[] NOT NULL DEFAULT '{}',
  -- The names that model pre-filled for the clip, kept or removed. On a
  -- blind-sample clip, the names it would have pre-filled.
  suggestions_withheld BOOLEAN NOT NULL DEFAULT FALSE,
  -- Blind sample: the client showed no model names for this clip, so its
  -- labels are independent of the model (master plan §6).
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT clips_suggestions_need_model CHECK (
    proposal_model_version IS NOT NULL OR
    (cardinality(suggested_names) = 0 AND NOT suggestions_withheld)
  )
);
CREATE INDEX clips_source_id_idx ON clips (source_id);

CREATE TABLE labels (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_id          UUID NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  trick_name       TEXT NOT NULL
                   CHECK (trick_name <> '' AND trick_name = btrim(trick_name)),
  -- Free text, stored trimmed and verbatim (casing preserved).
  -- Canonicalization happens at training-curation time via label_taxonomy.
  origin           TEXT NOT NULL DEFAULT 'typed'
                   CHECK (origin IN ('typed', 'vocabulary', 'model')),
  -- How this name was given (§1.2.18): typed by hand, picked from the
  -- vocabulary's suggestions, or pre-filled by the trick model and kept.
  taxonomy_version INTEGER NOT NULL,
  -- Vocabulary version in effect when THIS name was confirmed.
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX labels_clip_trick_uniq
  ON labels (clip_id, lower(trick_name));

CREATE TABLE label_taxonomy (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw              TEXT NOT NULL,
  canonical        TEXT NOT NULL,
  taxonomy_version INTEGER NOT NULL,
  -- Monotonic int, bumped when canonical names are added or changed.
  first_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT label_taxonomy_raw_version_uniq UNIQUE (raw, taxonomy_version)
);
CREATE INDEX label_taxonomy_lookup_idx
  ON label_taxonomy (raw, taxonomy_version DESC);

CREATE TABLE models (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version          TEXT NOT NULL UNIQUE,
  -- e.g. trick-v1.2. Immutable: a version is never re-published.
  model_type       TEXT NOT NULL DEFAULT 'trick-detection'
                   CHECK (model_type = 'trick-detection'),
  taxonomy_version INTEGER NOT NULL,
  -- Vocabulary version the model trained on.
  r2_key           TEXT NOT NULL,
  sha256           CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- Digest of the model artifact bytes; shipped in the manifest so the
  -- client can verify the download.
  byte_size        BIGINT,
  -- Artifact size in bytes; the client uses it for the download
  -- progress UI and a pre-flight storage check.
  min_client_version TEXT,
  -- Minimum client build that may install this model (OTA skip gate).
  input_desc       JSONB,
  -- Model input descriptor (feature layout, e.g. the T×52 gap-channel
  -- tensor) so the client can construct the input.
  output_desc      JSONB,
  -- Model output descriptor (segment + trick-name schema).
  holdout_report_r2_key TEXT,
  -- R2 key of the holdout evaluation report for this version.
  training_run_id  TEXT,
  -- Training-pipeline run that produced this version (provenance).
  val_metrics      JSONB NOT NULL DEFAULT '{}',
  name_metrics     JSONB NOT NULL DEFAULT '{}',
  -- Per canonical name: holdout precision and recall plus holdout_count and
  -- train_count (example counts), e.g. {"gainer": {"precision": 0.9,
  -- "recall": 0.84, "holdout_count": 31, "train_count": 412}}. Shipped in
  -- the manifest as the app's impact feedback (master plan §6).
  promoted_at      TIMESTAMPTZ,
  -- NULL = trained but not champion. The current model is the row with the
  -- greatest non-null promoted_at.
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE model_training_sources (
  model_version TEXT NOT NULL REFERENCES models(version),
  source_id     CHAR(64) NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  -- The sources a promoted model trained on (§1.2.20). No account column.
  PRIMARY KEY (source_id, model_version)
);

CREATE TABLE data_quarantine (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id      CHAR(64) NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  -- No user_id: who uploaded the bad data is read from source_attribution
  -- while it exists (§1.2.17), never copied here.
  reason         TEXT NOT NULL,
  metrics        JSONB,
  -- Snapshot of the regression metrics that triggered the quarantine.
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ,
  resolution     TEXT CHECK (resolution IN ('released', 'purged')),
  CONSTRAINT quarantine_resolution_consistent CHECK (
    (resolved_at IS NULL  AND resolution IS NULL) OR
    (resolved_at IS NOT NULL AND resolution IS NOT NULL)
  )
);
CREATE UNIQUE INDEX data_quarantine_open_uniq
  ON data_quarantine (source_id) WHERE resolved_at IS NULL;
CREATE INDEX data_quarantine_open_idx
  ON data_quarantine (quarantined_at) WHERE resolved_at IS NULL;

CREATE TABLE reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Usually the target's own contributor (§1.2.17), so a report is
  -- deleted 30 days after created_at (§4).
  target_type      TEXT NOT NULL CHECK (target_type IN ('source', 'clip', 'label')),
  target_id        TEXT NOT NULL,
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'reviewed', 'dismissed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reports_status_idx ON reports (status, created_at)
  WHERE status = 'open';
```

The seed migration inserts the version-1 taxonomy rows, e.g.:

```sql
INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES
  ('cork', 'cork', 1),
  ('corkscrew', 'cork', 1),
  ('gainer', 'gainer', 1),
  ('cartfull', 'cartfull', 1),
  ('hook', 'hook', 1),
  ('scoot', 'scoot', 1)
ON CONFLICT (raw, taxonomy_version) DO NOTHING;
```

(The real seed list comes from the standard tricking vocabulary; the
curation process itself is a separate concern — master plan §9 Q1. The
iOS app bundles the same list as its offline vocabulary seed, so it can
suggest and group names before it ever reaches the farm.)

**Renames resolve forward.** Every canonical name is also a `raw` row
mapping to itself, as in the seed. Renaming a canonical name therefore
adds, at the new version, a row for every raw string that mapped to the
old canonical — the old canonical itself included — pointing at the new
one, plus the new canonical mapping to itself. Renaming `cartfull` to
`cart full` at version 5 adds `('cartfull', 'cart full', 5)` and
`('cart full', 'cart full', 5)`, and the same for every other alias of
`cartfull`. Labels given under the old name, and the app's achievements
counted on it, then resolve to the new one through the usual
greatest-version lookup instead of falling out of the vocabulary.
Remapping only the old canonical is not enough: an alias left at its
old version still points at the old name, which the vocabulary then
lists as a canonical of its own.

## 4. Upsert semantics

Every write is keyed on a client-supplied identity, which is what makes
re-submission idempotent. No `Idempotency-Key` header is needed; the IDs
*are* the idempotency keys.

**`users`** — identity row, written only at sign-in (§7.1), keyed by the
Apple `sub`; a re-sign-in replaces only the stored Apple refresh token:

```sql
INSERT INTO users (id, apple_refresh_token) VALUES ($1, $2)
ON CONFLICT (id) DO UPDATE SET
  apple_refresh_token = EXCLUDED.apple_refresh_token,
  updated_at          = now()
RETURNING is_blocked;
```

Contribution never writes `users`. `reputation` / `is_blocked` change only
through the moderation path.

**`sessions`** — one row per sign-in; a user may hold several (one per
device or install). Sign-in purges expired rows, then inserts:

```sql
DELETE FROM sessions WHERE expires_at < now();
INSERT INTO sessions (user_id, token_hash, expires_at)
VALUES ($1, $2, now() + interval '90 days');
```

**`sources`** — full replace on re-contribution, except ownership. `$2`
is the SHA-256 hex of the presented source key:

```sql
INSERT INTO sources
  (id, source_key_hash, frame_count, sample_rate, keypoint_format, r2_key, updated_at)
VALUES ($1, $2, $3, $4, $5, 'poses/' || $1 || '.tkp1.gz', now())
ON CONFLICT (id) DO UPDATE SET
  -- source_key_hash is deliberately NOT overwritten: first writer wins (§1.2.13).
  -- sha256 is deliberately NOT overwritten: owned by ingest (§1.2.10).
  frame_count     = EXCLUDED.frame_count,
  sample_rate     = EXCLUDED.sample_rate,
  keypoint_format = EXCLUDED.keypoint_format,
  r2_key          = EXCLUDED.r2_key,
  updated_at      = now()
WHERE sources.source_key_hash = EXCLUDED.source_key_hash
RETURNING (xmax = 0) AS inserted;
-- no row → claimed under another key → 409 SOURCE_ALREADY_CLAIMED
-- inserted → 201; otherwise → 200
```

**`source_attribution`** — every contribution write (`POST /api/sources`,
`POST /api/clips`, `POST /api/clips/:id/labels`) records the caller as
the source's last writer, in the same transaction:

```sql
INSERT INTO source_attribution (source_id, user_id) VALUES ($1, $2)
ON CONFLICT (source_id) DO UPDATE SET
  user_id       = EXCLUDED.user_id,
  attributed_at = now();
```

The farm process deletes expired rows at startup and hourly, together
with reports past the same window (§1.2.17):

```sql
DELETE FROM source_attribution WHERE attributed_at < now() - interval '30 days';
DELETE FROM reports            WHERE created_at    < now() - interval '30 days';
```

Every read of `source_attribution` also filters on
`attributed_at >= now() - interval '30 days'`, so a late purge never
extends the link.

**`clips`** — batch upsert, one statement for the whole batch:

```sql
INSERT INTO clips
  (id, source_id, start_frame, end_frame, auto_detected,
   proposal_model_version, suggested_names, suggestions_withheld, updated_at)
VALUES (...), (...)
ON CONFLICT (id) DO UPDATE SET
  source_id              = EXCLUDED.source_id,
  start_frame            = EXCLUDED.start_frame,
  end_frame              = EXCLUDED.end_frame,
  auto_detected          = EXCLUDED.auto_detected,
  proposal_model_version = EXCLUDED.proposal_model_version,
  suggested_names        = EXCLUDED.suggested_names,
  suggestions_withheld   = EXCLUDED.suggestions_withheld,
  updated_at             = now();
```

The provenance columns are replaced like the window: the client's
current record of the clip is the truth (§1.2.18).

**`labels`** — never upserted per-row; the whole set per clip is replaced
(§5).

**`label_taxonomy`** — mappings are immutable per version (curation path):

```sql
INSERT INTO label_taxonomy (raw, canonical, taxonomy_version)
VALUES ($1, $2, $3)
ON CONFLICT (raw, taxonomy_version) DO NOTHING;
```

**`models`** — versions are never re-published:

```sql
INSERT INTO models
  (version, taxonomy_version, r2_key, sha256, byte_size, min_client_version,
   input_desc, output_desc, holdout_report_r2_key, training_run_id,
   val_metrics, name_metrics, promoted_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
ON CONFLICT (version) DO NOTHING;
-- rowcount 0 → 409 VERSION_EXISTS
```

**`model_training_sources`** — written in the same transaction as the
`models` insert, only when that insert added a row:

```sql
INSERT INTO model_training_sources (model_version, source_id)
SELECT $1, s.id
FROM sources s
WHERE s.id = ANY($2::char(64)[])
ON CONFLICT DO NOTHING;
-- $2 = training_source_ids from POST /api/models; ids of sources deleted
-- since the training run match no row and are skipped (§1.2.20).
```

**`data_quarantine`** — plain append-only `INSERT`; the partial unique
index rejects a second open quarantine for the same source.

## 5. Label-set replacement transaction

`POST /api/clips` (batch) and `POST /api/clips/:id/labels` converge on one
primitive: **replace the label set of a clip**. It runs inside the same
transaction as the clip upserts, so a batch is all-or-nothing:

```sql
BEGIN;

-- 1. current taxonomy version, once per transaction
SELECT max(taxonomy_version) INTO v_tax FROM label_taxonomy;

-- 2. clip upserts (§4)

-- 3. per clip in the batch; $2 is the clip's labels as sent,
--    [{"name": "cork", "origin": "vocabulary"}, ...]:
DELETE FROM labels WHERE clip_id = $1;
INSERT INTO labels (clip_id, trick_name, origin, taxonomy_version)
SELECT $1, deduped.name, deduped.origin, v_tax
FROM (
  SELECT DISTINCT ON (lower(trim(l.name))) trim(l.name) AS name, l.origin
  FROM jsonb_to_recordset($2::jsonb) AS l(name text, origin text)
  WHERE trim(l.name) <> ''
  ORDER BY lower(trim(l.name)), trim(l.name), l.origin
) AS deduped;
-- (empty array → DELETE only; the clip is left unlabeled)
-- Dedup on lower(trim(name)) BEFORE insert: the unique index on
-- (clip_id, lower(trick_name)) rejects duplicates, it does not collapse
-- them. DISTINCT ON keeps the alphabetically-first casing per group and,
-- for that casing, the alphabetically-first origin.

COMMIT;
```

Properties:

- **Idempotent.** Submitting the same set twice yields the same rows
  (same `(clip_id, lower(trick_name))`, fresh timestamps on the second
  write — timestamps are provenance, not identity).
- **Atomic.** A batch that fails validation rolls back entirely; the
  farm never holds half a contribution.
- **No merge logic.** The client is the source of truth for "what are
  this clip's names right now"; the farm does not diff.

## 6. Training-data queries (quarantine exclusion)

The training export must exclude quarantined sources. Because a purge
hard-deletes the source row (§1.2.3), "quarantined" for training purposes
means **has an open (unresolved) quarantine row**:

```sql
SELECT s.id            AS source_id,
       s.r2_key,
       s.sha256        AS blob_sha256,
       c.id            AS clip_id,
       c.start_frame,
       c.end_frame,
       c.proposal_model_version,
       c.suggested_names,
       c.suggestions_withheld,
       l.trick_name,                    -- raw; canonicalized via label_taxonomy
       l.origin,
       l.taxonomy_version,
       GREATEST(s.updated_at, c.updated_at, l.updated_at) AS row_cursor
FROM sources s
JOIN clips  c ON c.source_id = s.id
JOIN labels l ON l.clip_id   = c.id
LEFT JOIN data_quarantine q
       ON q.source_id = s.id AND q.resolved_at IS NULL
WHERE q.id IS NULL
  AND s.sha256 IS NOT NULL
  AND (GREATEST(s.updated_at, c.updated_at, l.updated_at), c.id, l.trick_name)
      > ($1, $2, $3)  -- since cursor: (row_cursor, clip_id, trick_name)
ORDER BY row_cursor ASC, clip_id ASC, trick_name ASC
LIMIT 10000;
```

Notes:

- Sources with no labels contribute no rows. (Unlabeled *regions* of
  labeled sources serve as background negatives — derived from clip
  windows, not from label-less sources.)
- Keyset is on `(row_cursor, clip_id, trick_name)`, not `row_cursor`
  alone: `row_cursor` ties are guaranteed, not rare — §5 replaces a
  clip's label set in the same transaction as the clip upserts, and
  Postgres `now()` returns the transaction start, so every row a batch
  touches shares the exact same `updated_at`. Keying on `row_cursor`
  alone with `next_cursor = max(row_cursor)` would silently skip rows
  sharing the max cursor value past the `LIMIT` boundary.
- `next_cursor` is the opaque encoding of the last returned row's
  `(row_cursor, clip_id, trick_name)`; the training job passes it back
  as `since`. It is non-null whenever `rows` is non-empty and null only
  on an empty page, so the pipeline gets an exact watermark for the cost
  of one extra empty request per pull (maintainer decision 2026-10-14
  on #19). It carries `row_cursor` at full microsecond precision,
  formatted by Postgres (`to_char(... AT TIME ZONE 'UTC', ...US"Z")`):
  `now()` stores microseconds, and a millisecond cursor would make the
  `>` predicate match the page's last row again, so the cursor would
  never advance.
- `blob_sha256` is never null in export rows: the query filters
  `s.sha256 IS NOT NULL` explicitly. Label submission already requires
  an ingested blob (`BLOB_MISSING`), so this only states it; the
  pipeline fails the run if it ever sees a null rather than training on
  a row it can't fetch (maintainer decision 2026-10-14 on #19).
- **The export carries no deletions.** A source deleted by its owner,
  by account deletion, or by a quarantine purge, and a label dropped
  when a clip's label set is replaced, simply stop appearing. An
  incremental pull never learns of them. The training job therefore
  builds every dataset from a **full pull** (no `since`) and discards
  any locally cached pose blob whose source is absent from it. `since`
  is only for cheap change detection, such as counting new labels
  before deciding to train.
- No account identifier is exported (§1.2.17). Training splits by
  source.
- Provenance (§1.2.18) rides on every row: `origin` per label, and the
  clip's `proposal_model_version`, `suggested_names` and
  `suggestions_withheld` repeated on each of its label rows. The app
  contributes a clip only once it has at least one name
  (`CONTRIBUTION_DESIGN.md` §3.3), so a clip whose suggestions were all
  removed still exports through the name the user gave instead; only a
  clip whose label set was later cleared to `[]` drops out, with its
  provenance.
- Canonicalization (`raw → canonical`) happens in the training job using
  the `taxonomy` block shipped with the export response (§7,
  `GET /api/labels/export`), not in SQL.

## 7. API

Base path `/api`. JSON request/response bodies, UTF-8. Timestamps are
RFC 3339 (`2026-10-06T07:30:00Z`).

### 7.1 Authentication

**Client sessions** (every endpoint not named below). The client signs
in once with `POST /api/auth/apple` (§7.3), the only client endpoint
that sees Apple tokens, and receives a farm session token (§1.2.14).
Every other client request sends `Authorization: Bearer <session token>`.
The farm hashes the token and looks it up:

```sql
SELECT s.id, s.user_id, s.last_used_at, u.is_blocked
FROM sessions s
JOIN users u ON u.id = s.user_id
WHERE s.token_hash = $1 AND s.expires_at > now();
```

No row → `401 UNAUTHENTICATED`; the client discards the token and signs
in again. `is_blocked` → `403 ACCOUNT_BLOCKED`, except on
`POST /api/auth/signout` and `DELETE /api/account` (§1.2.16). Otherwise
the request runs as the session's user. Account data (sessions, the
account itself) is scoped with `user_id = <session user_id>`;
contributions are reached only through source keys (§7.2), so there is
no cross-user access either way. When `last_used_at` is more than a day
old, the session slides forward:

```sql
UPDATE sessions
SET last_used_at = now(), expires_at = now() + interval '90 days'
WHERE id = $1 AND last_used_at < now() - interval '1 day';
```

A session token is 32 bytes from a CSPRNG, base64url-encoded without
padding (43 characters); the farm stores only its lowercase hex SHA-256
(`sessions.token_hash`). The token carries no claims. The row is the
source of truth, so sign-out, revoked consent, and account deletion end
sessions immediately. Sessions expire after 90 days without use; Apple
notes that "User sessions are long-lived on device".

**Pipeline** (`POST /api/models`, `GET /api/labels/export`): pre-shared
service key, `Authorization: Bearer <TURNIP_PIPELINE_KEY>`.

**Apple** (`POST /api/auth/apple/notifications`): no bearer token; the
body is a JWT signed by Apple, verified as below.

**Public** (`GET /api/models/current`, `GET /api/taxonomy/current`): no
bearer token and no user (§1.2.19). A client that has a session may
send it; the farm ignores it on these two endpoints, so a request never
ties a manifest or vocabulary fetch to an account.

**Verifying an Apple JWT.** The identity token at sign-in, the `id_token`
returned by the code exchange, and server-to-server notifications are
checked the same way: RS256 signature against Apple's JWKS
(`https://appleid.apple.com/auth/keys`; cached, key matched by `kid`,
refetched when an unknown `kid` appears), `iss = https://appleid.apple.com`,
`aud = APP_BUNDLE_ID`, and `exp` within a 60-second clock-skew leeway.
Notifications carry `iat` and `jti` but no `exp`, so `exp` is required
only on identity tokens. The farm reads only `sub` (and, for
notifications, `events`); Apple's email claims are never stored or
logged (§8).

**Apple credentials.** The code exchange and token revocation
authenticate the farm to Apple with `client_id = APP_BUNDLE_ID` and a
client secret: an ES256 JWT signed with the Sign in with Apple private
key, header `{"alg": "ES256", "kid": APPLE_KEY_ID}`, claims
`iss = APPLE_TEAM_ID`, `sub = APP_BUNDLE_ID`,
`aud = https://appleid.apple.com`, `iat` = now, and `exp` no more than
six months later (Apple's limit). Configuration: `APP_BUNDLE_ID`,
`APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (the `.p8` PEM), and
`APPLE_REFRESH_TOKEN_KEY` (32 random bytes, base64: the AES-256-GCM key
for `users.apple_refresh_token`).

**Client contract** (turnip-ios):

- Per sign-in attempt, generate a random raw nonce, set
  `ASAuthorizationAppleIDRequest.nonce` to its lowercase hex SHA-256, and
  send the raw nonce with `identityToken` and `authorizationCode` to
  `POST /api/auth/apple`. The code is single-use and valid for five
  minutes, so send it right away.
- Keep the session token in the Keychain with
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so background
  uploads can read it and it never migrates to another device.
- On launch, call `getCredentialState(forUserID:)`. On `.revoked` or
  `.notFound`, call `POST /api/auth/signout`, delete the token, and show
  the signed-out state. Also observe `credentialRevokedNotification`.
- On any `401`, delete the token and sign in again.
- When a source is first contributed, generate its source key (§7.2)
  and keep it in the Keychain under its `video_id`, with the same
  accessibility as the session token. Keychain items survive app
  deletion and reinstall on current iOS, but Apple doesn't guarantee
  it, so a lost key is an expected state, not an error.
- Account deletion: delete every source the app holds a key for, then
  call `DELETE /api/account`, then delete the local keys and session
  token (§7.3).
- Disclosure, shown at contribution consent and again at account
  deletion: contributions stay linked to the account for 30 days after
  the last edit, and after that are kept without any link to it.
  Deleting the account removes every contribution the app can still
  find. The rest can't be traced back to the user and remain in the
  training data. The consent copy also asks users to contribute only
  clips of themselves, or of people who agreed: the person in a clip
  may not be the account holder.

### 7.2 Conventions

- **Idempotency** comes from client-supplied IDs (§4); no extra headers.
- **Errors** share one shape:

  ```json
  {"error": {"code": "VALIDATION_ERROR", "message": "...", "details": {}}}
  ```

  Codes: `UNAUTHENTICATED` (401), `ACCOUNT_BLOCKED` (403), `NOT_FOUND`
  (404), `NO_MODEL` (404), `VALIDATION_ERROR` (422), `UNSUPPORTED_FORMAT` (422),
  `BLOB_MISSING` (422), `BLOB_DIGEST_MISMATCH` (422),
  `SOURCE_ALREADY_CLAIMED` (409), `VERSION_EXISTS` (409),
  `RATE_LIMITED` (429), `INTERNAL` (500), `APPLE_UNAVAILABLE` (503:
  Apple's token or revocation endpoint is unreachable or answered 5xx;
  retry later).
- **Source keys** prove ownership of a source (§1.2.13).
  - **What a key is:** 32 random bytes the client generates once per
    source when it first contributes it, sent base64url-encoded without
    padding (43 characters). The farm stores only its SHA-256 hex
    (`sources.source_key_hash`).
  - **How it travels:**
    - the `source_key` field on `POST /api/sources` and
      `POST /api/clips/:id/labels`;
    - a per-clip `source_key` in the `POST /api/clips` batch;
    - a `Source-Key` header on `GET /api/sources/:id`,
      `GET /api/sources/:id/pose` and `DELETE /api/sources/:id`.
  - **Two credentials:** contribution endpoints need both a session and
    the key. The session is for rate limiting, blocking, and attribution
    (§1.2.17); the key is for ownership.
  - **Losing it:** a client that loses a key (e.g. its Keychain is
    gone) can no longer manage that source. It treats the source as
    contributed but unmanageable.
- **Ownership privacy:** a missing or wrong source key gets
  `404 NOT_FOUND` (not 403) on reads, deletes, and clip writes, so
  resource IDs are not usable as an ownership oracle. Registration is
  the one exception: a `video_id` already claimed under another key
  gets `409 SOURCE_ALREADY_CLAIMED`.
- **Rate limiting:** per-user token bucket on POST endpoints
  (suggested: 60 requests/minute; `429 RATE_LIMITED` with
  `Retry-After`). `POST /api/auth/apple` has no user yet, so it is
  limited per client IP (suggested: 10 requests/minute), and so are
  the two public endpoints (suggested: 30 requests/minute; both are
  cacheable, see §7.3). The client IP is the socket peer's address,
  with IPv6 limited per /64, unless the peer is a trusted proxy:
  loopback (a reverse proxy on the same host), or an address in the
  optional `TRUSTED_PROXIES` setting, a comma-separated list of
  addresses and CIDR ranges (a container network's subnet, a CDN's
  ranges). From a trusted peer, the client is read from
  `X-Forwarded-For`, last entry first: the first address that is not
  itself a trusted proxy. Each proxy appends the address it saw, so a
  client can add entries only to the left of the ones trusted proxies
  appended, and the walk never reaches them. A missing or malformed
  entry ends the walk at the last trusted address. Trusting a range
  trusts everything that can connect from it, so it must hold only
  proxies.

### 7.3 Endpoints

#### `POST /api/auth/apple` — sign in, get a session token

No session required. Request:

```json
{
  "identity_token": "<ASAuthorizationAppleIDCredential.identityToken>",
  "authorization_code": "<ASAuthorizationAppleIDCredential.authorizationCode>",
  "nonce": "<raw nonce; its SHA-256 hex was set on the Apple request>"
}
```

Behavior, in order:

1. Verify `identity_token` as an Apple JWT (§7.1), and require its
   `nonce` claim to equal the lowercase hex SHA-256 of the request's
   `nonce`. Any failure → `401 UNAUTHENTICATED`.
2. Exchange the code: `POST https://appleid.apple.com/auth/token`, form
   fields `client_id`, `client_secret` (§7.1), `code`,
   `grant_type=authorization_code` (no `redirect_uri` for a native app).
   Apple's `invalid_grant` (code expired, already used, or revoked) →
   `401 UNAUTHENTICATED`. Unreachable, timeout, or 5xx →
   `503 APPLE_UNAVAILABLE`. Any other error (e.g. `invalid_client`)
   means the farm is misconfigured → `500 INTERNAL`.
3. Verify the response's `id_token` as an Apple JWT (§7.1); its `sub`
   must equal the identity token's `sub`, else `401 UNAUTHENTICATED`.
4. In one transaction: upsert the user with the encrypted
   `refresh_token`, purge expired sessions, and insert the new session
   (§4).

A blocked user still gets a session (§1.2.16); every other endpoint
then answers `403 ACCOUNT_BLOCKED`.

Response `200`:

```json
{"session_token": "<43-char base64url>", "expires_at": "2027-01-04T07:00:00Z"}
```

#### `POST /api/auth/signout` — end this session

Deletes the session whose `token_hash` matches the bearer token, if
any. `204` whether or not a session matched, so a client can always
sign out cleanly. Allowed for blocked users.

#### `DELETE /api/account` — delete my account

App Review guideline 5.1.1(v). Session required; allowed for blocked
users.

**Client first.** Contributions are not linked to the account beyond
the attribution window (§1.2.17), so the farm cannot find them all.
Before calling this endpoint, the app deletes every source it holds a
key for, with `DELETE /api/sources/:id`. The farm cannot enforce this
step. Contributions whose keys the app no longer holds, and that are
past the window, remain as training data that no record links to the
user. The app says so when the user contributes and again when they
delete the account (§7.1, §8).

**Then the server**, in order, so a retry after a partial failure
finishes the job:

1. If `users.apple_refresh_token` is set, decrypt it and revoke it:
   `POST https://appleid.apple.com/auth/revoke`, form fields
   `client_id`, `client_secret` (§7.1), `token`,
   `token_type_hint=refresh_token`. Apple answers `200` both when it
   revokes the token and when the token was already invalid.
   Unreachable, timeout, or 5xx → `503 APPLE_UNAVAILABLE` with nothing
   deleted. Any other error is logged and deletion proceeds: the user's
   right to delete does not depend on Apple's answer.
2. Delete every source still attributed to the user (within the
   window, §4): first its R2 blob and any staged upload, then the row.
   Clips, labels, quarantine rows, and attribution cascade.
3. `DELETE FROM users WHERE id = $1`. Sessions, reports, and any
   remaining attribution rows cascade.

Response `204`. A retry after success gets `401` (the session is gone).

#### `POST /api/auth/apple/notifications` — Apple server-to-server notifications

Apple posts here when a user changes their Sign in with Apple account;
the URL is registered for the App ID in the Apple Developer account
(§9). No session; authenticity comes from Apple's signature. Body:

```json
{"payload": "<JWT signed by Apple>"}
```

Verify `payload` as an Apple JWT (§7.1); failure → `401`. The `events`
claim is documented as an object; parse it if it arrives as a
JSON-encoded string instead. Apple's documented shape:

```json
{
  "iss": "https://appleid.apple.com",
  "aud": "<APP_BUNDLE_ID>",
  "iat": 1508184845,
  "jti": "abede...67890",
  "events": {
    "type": "consent-revoked",
    "sub": "820417.faa325acbc78e1be1668ba852d492d8a.0219",
    "event_time": 1508184845
  }
}
```

By `events.type`, for the user `events.sub`:

- `consent-revoked` (the user stopped using Sign in with Apple for the
  app): delete all their sessions and set `apple_refresh_token = NULL`
  (Apple has already invalidated it). Contributions stay; the user can
  sign in again, or delete the account.
- `account-deleted` (the user deleted their Apple Account; Apple has
  invalidated all their tokens, and they can never sign in again to
  delete their data): run `DELETE /api/account` steps 2 and 3. Sources
  past the attribution window are not linked to the account and stay.
- `email-enabled`, `email-disabled`: ignored. These events carry an
  email address, which the farm never stores or logs.

An unknown `sub` or `type` is a no-op. Response `200` once handled;
`500` on a transient failure (e.g. R2 unreachable), since whether Apple
redelivers is undocumented (§9).

#### `POST /api/sources` — register a source, get the blob upload URL

Request:

```json
{
  "video_id": "<64-char lowercase hex>",
  "source_key": "<43-char base64url; generated by the client for this source>",
  "frame_count": 600,
  "sample_rate": 10.0,
  "keypoint_format": "tkp1"
}
```

Validation: `video_id` matches `^[0-9a-f]{64}$`; `source_key` is 43
base64url characters (§7.2); `frame_count > 0`; `sample_rate` in
`1..30` Hz (the normative client analysis range, POSE_FORMAT.md §6);
`keypoint_format` must be `tkp1` (anything else →
`422 UNSUPPORTED_FORMAT`).

Behavior: upserts the source row per §4 (`r2_key =
poses/<video_id>.tkp1.gz`; `source_key_hash` set on insert and never
overwritten; `sha256` left for ingest), and records the caller in
`source_attribution` (§4). If the `video_id` is already claimed under a
different key → `409 SOURCE_ALREADY_CLAIMED` (the farm already holds
this source).

Response (`201` new, `200` re-registered):

```json
{
  "source_id": "<video_id>",
  "r2_key": "poses/<video_id>.tkp1.gz",
  "upload_url": "<presigned R2 PUT, 15-minute expiry>",
  "upload_expires_at": "2026-10-06T08:00:00Z",
  "blob_present": false
}
```

`blob_present` is true when the canonical blob is stored
(`sources.sha256 IS NOT NULL`); the client skips the PUT and goes
straight to clip submission. `frame_count` is the canonical 10 Hz count
(client computes it per POSE_FORMAT.md §6); clip windows submitted later are
validated against it, so the whole API speaks canonical indices.

The client then `PUT`s the `.tkp1.gz` blob to `upload_url` with
`Content-Type: application/gzip` and a `Content-MD5` (or
`x-amz-checksum-sha256`) checksum header — the URL rejects a checksum
mismatch at write time, which is the transport-integrity layer
(§1.2.10). The upload lands on a staging key; the ingest worker
resamples it to canonical 10 Hz, stores it at `r2_key`, sets
`sources.sha256`, and deletes the staged object. The client waits for
ingest (poll registration until `blob_present`, or retry clip
submission), then submits clips (§7.3 `POST /api/clips`). A source row
with no ingested blob yet is a harmless dangling row; it self-heals
when the client re-registers and uploads.

#### `POST /api/clips` — batch upsert clips + replace their label sets

Request:

```json
{
  "clips": [
    {
      "clip_id": "<uuidv4, client-minted>",
      "source_id": "<64-char hex>",
      "source_key": "<the source's key>",
      "start_frame": 120,
      "end_frame": 175,
      "auto_detected": true,
      "proposal_model_version": "trick-v1.3",
      "suggested_names": ["cork", "gainer"],
      "suggestions_withheld": false,
      "labels": [{"name": "cork", "origin": "model"}]
    }
  ]
}
```

`proposal_model_version` (default `null`), `suggested_names` (default
`[]`) and `suggestions_withheld` (default `false`) are the clip's
provenance (§1.2.18). Each `labels` entry is an object; `origin` is
required, one of `typed | vocabulary | model`.

Behavior, in a single transaction:

1. For each clip: the source must exist, its `source_key` must match,
   and an existing `clip_id` must already belong to that source (clips
   never move between sources). Otherwise the whole batch fails with
   `404 NOT_FOUND`.
2. `0 <= start_frame < end_frame <= source.frame_count`, else
   `422 VALIDATION_ERROR` (with the batch index and field in `details`).
   Also `422`: an `origin` outside the three values; a non-empty
   `suggested_names`, `suggestions_withheld: true`, or a label with
   `origin: "model"` on a clip with no `proposal_model_version`; or a
   label with `origin: "model"` on a clip with
   `suggestions_withheld: true` (nothing was shown to keep).
3. **Blob verification** (once per distinct source in the batch): the
   canonical blob must be ingested — `sources.sha256 IS NULL` →
   `422 BLOB_MISSING` (the client waits for ingest, re-uploads via
   `POST /api/sources`, and retries). Otherwise fetch the R2 object at
   `r2_key` and compare its SHA-256 against `sources.sha256`; a
   mismatch → `422 BLOB_DIGEST_MISMATCH`.
4. Upsert the clip rows (§4).
5. Replace each clip's label set (§5); `labels` is optional per clip and
   may be `[]` (clears the set).
6. Record the caller in `source_attribution` for each distinct source
   (§4).

Response `200`:

```json
{
  "clips": [
    {"clip_id": "<uuid>", "labels": [{"name": "cork", "origin": "model"}], "taxonomy_version": 3}
  ]
}
```

`labels` entries are trimmed; blank entries are dropped;
case-insensitive duplicates are deduped before insert (§5).

#### `POST /api/clips/:id/labels` — replace one clip's label set

Request:

```json
{
  "source_key": "<the key of the clip's source>",
  "labels": [
    {"name": "hook", "origin": "vocabulary"},
    {"name": "scoot", "origin": "vocabulary"},
    {"name": "gainer", "origin": "typed"},
    {"name": "cartfull", "origin": "vocabulary"}
  ]
}
```

Behavior: the clip must exist and `source_key` must match its source
(`404` otherwise); labels validate as in `POST /api/clips` against the
clip's stored provenance; runs the §5 replacement for that clip only
and records the caller in `source_attribution` (§4). Idempotent:
submitting the current set is a no-op semantically.

Response `200`:

```json
{"clip_id": "<uuid>", "labels": [{"name": "hook", "origin": "vocabulary"}, "..."], "taxonomy_version": 3}
```

There is no "list my sources" endpoint: the farm doesn't know which
sources are whose (§1.2.17). The client knows, from the source keys it
holds.

#### `GET /api/sources/:id` — source with confirmed clips + labels

`Source-Key` header required. Response `200` (`404` if missing or the
key doesn't match):

```json
{
  "source": {
    "id": "<video_id>",
    "frame_count": 600,
    "sample_rate": 10.0,
    "keypoint_format": "tkp1",
    "sha256": "<canonical blob digest; null until ingested>",
    "trained_in": ["trick-v1.3", "trick-v1.4"],
    "created_at": "2026-10-06T07:00:00Z",
    "updated_at": "2026-10-06T07:00:00Z"
  },
  "clips": [
    {
      "id": "<uuid>",
      "start_frame": 120,
      "end_frame": 175,
      "auto_detected": true,
      "proposal_model_version": "trick-v1.3",
      "suggested_names": ["cork", "gainer"],
      "suggestions_withheld": false,
      "labels": [
        {"name": "cork", "origin": "model", "taxonomy_version": 3, "created_at": "..."}
      ]
    }
  ]
}
```

This is the reinstall-reconciliation read. The client reads the source
keys left in its Keychain (stored per `video_id`), recomputes the
`video_id`s of the videos it still has, and pulls each matching
source's clips + labels, adopting the server's clip IDs into its
rebuilt local state (master plan §5.1).

It is also the impact read. `trained_in` lists the promoted model
versions whose training set held this source (`model_training_sources`,
§1.2.20), oldest first; `[]` until a model trains on it. The app reads
it for the sources it holds keys for, to tell the user which models
their contributions went into.

#### `GET /api/sources/:id/pose` — owner-only pose blob download

`Source-Key` header required. Response `200` (`404` if missing or the
key doesn't match):

```json
{
  "url": "<presigned R2 GET for poses/<id>.tkp1.gz, 15-minute expiry>",
  "expires_at": "2026-10-06T08:00:00Z"
}
```

Used by a device that no longer holds the local video but still holds
the key (e.g. reinstall restore) to render skeleton previews from
keypoints alone. Presigned per request, scoped to the single blob; the
key requirement is what keeps one contributor's pose sequences from
ever being downloadable by another.

#### `DELETE /api/sources/:id` — owner-only hard delete

`Source-Key` header required. Deletes the R2 blob and the source row;
clips, labels, quarantine rows, and attribution cascade. `204` on
success (`404` if missing or the key doesn't match). This is the "keep
forever, user-deletable" retention posture (master plan §4): deletable
by whoever holds the key.

#### `GET /api/models/current` — trick-model manifest

Public: no session (§7.1). Response `200`:

```json
{
  "version": "trick-v1.2",
  "model_type": "trick-detection",
  "taxonomy_version": 3,
  "r2_key": "models/trick-v1.2.mlmodelc.zip",
  "url": "<presigned R2 GET, 15-minute expiry>",
  "sha256": "<64-char hex of the artifact bytes>",
  "byte_size": 48203110,
  "min_client_version": "2.4.0",
  "input_desc": {"layout": "T×52", "channels": "gap-channel pose features", "rate_hz": 10},
  "output_desc": {"segments": "source-frame coordinates", "trick_names": "string[]", "name_scores": "number[]", "is_combo": "derived"},
  "holdout_report_r2_key": "reports/trick-v1.2-holdout.json",
  "training_run_id": "run-20261006-01",
  "val_metrics": {"seg_map_05": 0.62, "name_accuracy": 0.81},
  "name_metrics": {
    "cork": {"precision": 0.88, "recall": 0.79, "holdout_count": 24, "train_count": 310},
    "gainer": {"precision": 0.9, "recall": 0.84, "holdout_count": 31, "train_count": 412}
  },
  "vocabulary": [
    {"canonical": "cork", "aliases": ["cork", "corkscrew"]},
    {"canonical": "gainer", "aliases": ["gainer"]}
  ],
  "promoted_at": "2026-10-06T06:00:00Z"
}
```

`vocabulary` is built from `label_taxonomy` at the model's
`taxonomy_version`: one entry per canonical name, `aliases` = every raw
string mapped to it. `name_metrics` is the `models` column as published
(§3): per canonical name the model knows, holdout precision and recall
and the holdout and training example counts — the app's "how well the
model knows this trick", and its list of tricks the model is still
learning. The client verifies the download against `sha256` before
installing. `404 NO_MODEL` when nothing has been promoted yet.

The response is the same for every caller until the next promotion, so
it is served with an `ETag` of the model `version` and
`Cache-Control: max-age=300`. The presigned `url` inside it is valid
for 15 minutes, longer than the cache lifetime.

#### `GET /api/taxonomy/current` — the current vocabulary

Public: no session (§7.1). The vocabulary at the farm's current
`taxonomy_version` (§1.2.8), independent of any model, so the app can
suggest and group names before the first promotion and pick up
curation between promotions. Response `200`:

```json
{
  "taxonomy_version": 7,
  "vocabulary": [
    {"canonical": "cork", "aliases": ["cork", "corkscrew"]},
    {"canonical": "gainer", "aliases": ["gainer"]}
  ]
}
```

Same entry shape as the manifest's `vocabulary`, assembled the same way:
each raw string resolves through its greatest `taxonomy_version`
mapping (so a renamed canonical lists its old name as an alias, §3).
Served with an `ETag` of the `taxonomy_version` and
`Cache-Control: max-age=3600`. Always `200`: the seed migration defines
version 1.

#### `POST /api/models` — pipeline publishes the champion (service key)

Request:

```json
{
  "version": "trick-v1.2",
  "taxonomy_version": 3,
  "r2_key": "models/trick-v1.2.mlmodelc.zip",
  "sha256": "<64-char hex>",
  "byte_size": 48203110,
  "min_client_version": "2.4.0",
  "input_desc": {"layout": "T×52", "channels": "gap-channel pose features", "rate_hz": 10},
  "output_desc": {"segments": "source-frame coordinates", "trick_names": "string[]", "name_scores": "number[]", "is_combo": "derived"},
  "holdout_report_r2_key": "reports/trick-v1.2-holdout.json",
  "training_run_id": "run-20261006-01",
  "val_metrics": {"seg_map_05": 0.62, "name_accuracy": 0.81},
  "name_metrics": {
    "gainer": {"precision": 0.9, "recall": 0.84, "holdout_count": 31, "train_count": 412}
  },
  "training_source_ids": ["<64-char hex>", "..."]
}
```

Behavior: inserts per §4 with `promoted_at = now()`, and in the same
transaction records `training_source_ids` in `model_training_sources`
(§4), skipping ids whose source no longer exists. An existing
`version` → `409 VERSION_EXISTS` (bump the version instead), with
nothing recorded. A rollback publish (`TRAINING_DESIGN.md` §8) sends
the re-promoted champion's own source list. Response `201`:
`{"id": "<uuid>", "version": "...", "promoted_at": "...",
"training_sources_recorded": 1287}`.

#### `GET /api/labels/export?since=` — training pull (service key)

`since` is the opaque cursor from the previous response's `next_cursor`
(the §6 `(row_cursor, clip_id, trick_name)` triple, encoded opaquely);
omit for a full pull. Returns label-granular rows (one per label row), quarantined
sources excluded, ordered by cursor ascending, `limit` 10000:

```json
{
  "rows": [
    {
      "source_id": "<video_id>",
      "r2_key": "poses/<video_id>.tkp1.gz",
      "blob_sha256": "<64-char hex>",
      "clip_id": "<uuid>",
      "start_frame": 120,
      "end_frame": 175,
      "proposal_model_version": "trick-v1.3",
      "suggested_names": ["cork", "gainer"],
      "suggestions_withheld": false,
      "trick_name": "cork",
      "origin": "model",
      "taxonomy_version": 3
    }
  ],
  "taxonomy": [
    {"raw": "corkscrew", "canonical": "cork", "taxonomy_version": 3}
  ],
  "next_cursor": "<opaque>"  // non-null when rows is non-empty; null only on an empty page
}
```

`taxonomy` carries the whole `label_taxonomy` table (`raw → canonical`
per version), so the training job canonicalizes without a second call.
Shipping only "the versions present in `rows`" would silently unmap a
raw string whose labels all sit at an old version (versions are
append-only: a bump adds only new or changed mappings, which the
`(raw, taxonomy_version DESC)` lookup assumes). The table is small; it
ships on every page. The training job pins to the greatest version in
it, so curation applies at the next run (maintainer decision 2026-10-14
on #19). The training job resolves each row's `r2_key` to pose bytes
itself (R2 access, verifying `blob_sha256`).

#### `POST /api/quarantine` — pipeline reports regressing sources (service key)

Request:

```json
{
  "source_ids": ["<64-char hex>", "..."],
  "reason": "fixture regression: challenger 0.61 < champion 0.66",
  "metrics": {"challenger": 0.61, "champion": 0.66}
}
```

Inserts one `data_quarantine` row per id (`reason`, `metrics` JSONB
snapshot; the farm assigns `id` and `quarantined_at`). Ids that already
have an open quarantine are skipped — the `data_quarantine_open_uniq`
partial index makes resubmission a no-op, not an error
(`ON CONFLICT ... DO NOTHING`). Unknown source ids are reported, not
fatal: a source can be owner-deleted between the pipeline's export pull
and this call, and quarantining a deleted source is meaningless.
Response `200`:

```json
{"quarantined": ["<id>", "..."], "already_open": ["<id>"], "unknown": ["<id>"]}
```

The id list is explicit, not a farm-side time window: the pipeline
builds it from a `since=<watermark>` export pull taken after the
dataset pull (every source with a label row changed since the
watermark, including relabels of old sources — `TRAINING_DESIGN.md`
§7). The farm doesn't know the pipeline's watermark, and the Discord
alert and the quarantine list must be the same list (maintainer
decision 2026-10-14 on #19).

#### `POST /api/quarantine/:source_id/release` — maintainer releases (service key)

The review queue marks a row released (good data): sets `resolved_at =
now()`, `resolution = 'released'` on the open quarantine row, and the
source rejoins the export on the next pull. `404` when no open
quarantine row exists for the source. Response `200`:
`{"source_id": "<id>", "resolution": "released"}`.

#### `POST /api/quarantine/:source_id/purge` — maintainer purges (service key)

The review queue marks a row purged (bad data): sets `resolved_at =
now()`, `resolution = 'purged'`, then hard-deletes the source row —
cascades to clips/labels, and the R2 blob is deleted too (§1.2.3), so
poisoned data is gone entirely rather than merely excluded. R2 is
deleted before the row (the `DELETE /api/sources/:id` order); if
either delete throws, the source row survives so the call can be
retried. `404` when no open quarantine row exists. Response `204`.

#### `POST /api/reports` — report a bad label/clip

Request:

```json
{"target_type": "clip", "target_id": "<uuid>", "reason": "wrong trick name"}
```

`target_type` ∈ `source | clip | label`. Response `201`:
`{"id": "<report uuid>"}`. Reports are a moderation queue for future
use; they do not change training data by themselves. A report is
deleted 30 days after it is filed (§1.2.17, §4), reviewed or not.

## 8. What the farm never accepts or stores

Restating the privacy boundary (master plan §1) as an implementation
checklist:

- No video pixels, audio, thumbnails, or contact sheets — in any table,
  blob, log, or error payload.
- No location, EXIF, photo-library identifiers, or device identifiers.
  The `PHAsset.localIdentifier` **never leaves the device**; the farm
  sees only its SHA-256-derived digest, which it cannot reverse.
- No Apple profile data beyond the `sub` claim: no name, no email.
  Identity tokens and email notifications carry an email address; it is
  discarded unread.
- No app profile state: no achievements, levels, progress, scores,
  gallery grouping, highlights, favorites, spots, or which clips show
  the user (§1.2.21). Provenance fields (§1.2.18) say how a label was
  made, never who made it.
- R2 keys contain only the opaque source ID
  (`poses/<video_id>.tkp1.gz`); presigned URLs are per-request,
  single-blob, short-lived.
- Credentials are stored only in protected form: session tokens as
  SHA-256 hashes, Apple refresh tokens AES-256-GCM encrypted (§3).
- Request logs and error payloads never contain Apple identity tokens,
  authorization codes, refresh tokens, session tokens, source keys, or
  pose data.
- Contributions carry no account identifier. The only link is
  `source_attribution`, deleted 30 days after a source's last write
  (§1.2.17), and nothing may outlive it:
  - **Logs:** request logs never record a user ID or session ID next to
    a source or clip ID. The farm's logs and the reverse proxy's access
    logs are kept 30 days at most.
  - **Backups:** database backups are kept 30 days at most.
  - **Alerts:** anti-poisoning alerts name sources and counts, never
    accounts. The maintainer reads attribution from the database while
    it exists.
  - **Exports:** nothing exported to training carries an account
    identifier (§6).
  - **Reports:** deleted 30 days after they are filed, since the
    reporter is usually the target's contributor (§1.2.17).
- Account deletion (§7.3) removes the account, its sessions, and every
  contribution still attributed to it or still keyed on the device.
  Contributions the device can no longer find stay, unlinked; users are
  told so at consent and at deletion. Deleted data leaves the next
  training dataset, because training rebuilds from a full pull (§6).
  Models already trained on it are treated as anonymous, pending the
  assessment in §9 Q8.

## 9. Open questions

1. **Pipeline key management.** Who issues and rotates
   `TURNIP_PIPELINE_KEY`, and where is it stored? (Ops decision.)
2. **Reputation formula.** *Settled by §1.2.17:* reputation is not
   computed from contributions, which keep no lasting account link, and
   `users.reputation` stays unused. Any future per-account signal has
   to come from account-level events, such as confirmed reports.
3. **Apple token verification cost.** *Resolved:* identity tokens are
   verified once, at sign-in; requests carry farm session tokens
   (§1.2.14, §7.1).
4. **R2 topology.** Bucket, region, and presigned-URL TTL policy are ops
   details not specified here (15-minute TTLs assumed above).
5. **Taxonomy curation.** Who canonicalizes new free-text names and
   bumps `taxonomy_version` (master plan §9 Q1) — the versioning
   mechanics are specified here; the human process is not.
6. **Apple key and secret management.** Where `APPLE_PRIVATE_KEY` and
   `APPLE_REFRESH_TOKEN_KEY` live, and how the latter rotates. A
   rotation needs a key ID on the stored ciphertext, which §3 does not
   have yet. (Ops decision.)
7. **Server-to-server notifications.** The endpoint URL must be
   registered for the App ID in the Apple Developer account, and Apple
   does not document redelivery. A missed `account-deleted` leaves that
   user's data until an operator removes it. (Ops decision.)
8. **Trained-model anonymity.** Every device receives the model, so
   treating it as anonymous needs a documented assessment (EDPB Opinion
   28/2024): a membership-inference check in the holdout evaluation,
   and confirmation that no pose sequences ship inside model artifacts.
   Owned by the training design.
9. **Residual linkage.** Unlinked contributions can still be matched
   against a public video of the person in them, and an imported
   file's `video_id` can be recomputed by anyone holding the file
   (§1.2.17). Counsel should confirm whether that leaves them personal
   data. The answer is now also a reopen trigger for unlinking itself:
   if unlinked pose sequences are personal data anyway, linking may be
   the better trade (§1.2.17).
10. **Log and backup retention.** §8 caps logs and database backups at
    30 days; the deployment runbook has to implement that for Postgres
    backups, the farm's logs, and the reverse proxy's access logs.
11. **Landed or bailed.** An optional per-clip `outcome`
    (`landed | bailed`) is undecided (master plan §9 Q4). It would be
    one more nullable `clips` column and one more optional field on
    `POST /api/clips`, additive whenever it lands.
