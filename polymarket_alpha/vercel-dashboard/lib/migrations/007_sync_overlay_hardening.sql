-- Migration 007: Sync Overlay Hardening
-- Addresses: stub rows, schema constraints, observability tables, perf indexes
--
-- Run via Neon SQL Editor.
-- IMPORTANT: CREATE INDEX CONCURRENTLY cannot run inside a transaction.
-- Split into sections and run each section separately.

-- ============================================================
-- SECTION 0 (optional): EXTENSIONS
-- ============================================================
-- Needed for gen_random_uuid(); if already installed, this is a no-op.
-- If your environment disallows extensions, remove this and supply UUIDs in app code.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- SECTION 1: DATA CLEANUP (run FIRST)
-- Fix/delete invalid rows so constraints + unique index can be added safely.
-- ============================================================

-- 1a) Normalize empty/whitespace-only strings to NULL for key columns
-- Uses btrim() to catch whitespace-only values like '   ' that would otherwise pass NOT NULL
UPDATE position_sync_overlay
SET
  wallet       = NULLIF(btrim(wallet), ''),
  condition_id = NULLIF(btrim(condition_id), ''),
  outcome      = NULLIF(btrim(outcome), '')
WHERE
  wallet IS NOT NULL AND wallet <> btrim(wallet)
  OR condition_id IS NOT NULL AND condition_id <> btrim(condition_id)
  OR outcome IS NOT NULL AND outcome <> btrim(outcome)
  OR wallet = '' OR condition_id = '' OR outcome = '';

-- 1b) DELETE irreparable rows missing business key
-- Rationale: if (wallet/condition_id/outcome) is NULL, we cannot safely recover/identify the position row.
DELETE FROM position_sync_overlay
WHERE wallet IS NULL OR condition_id IS NULL OR outcome IS NULL;

-- 1c) Fix invalid/NULL sync_status values to something explicit
UPDATE position_sync_overlay
SET sync_status = CASE
  WHEN sync_status IN ('pending', 'synced', 'not_found', 'error') THEN sync_status
  WHEN sync_status IS NULL AND synced_at IS NULL THEN 'pending'
  ELSE 'error'
END
WHERE sync_status IS NULL
   OR sync_status NOT IN ('pending', 'synced', 'not_found', 'error');

-- 1d) Ensure synced rows have synced_at (do NOT flip them to error)
UPDATE position_sync_overlay
SET synced_at = COALESCE(synced_at, last_nonzero_at, NOW())
WHERE sync_status = 'synced' AND synced_at IS NULL;

-- 1e) Mark "stubby" rows (key exists but all business fields missing) as error (keeps audit trail)
-- Tune the predicate if you have other required columns.
UPDATE position_sync_overlay
SET
  sync_status = 'error',
  sync_error  = COALESCE(sync_error, 'incomplete overlay row detected during migration 007'),
  synced_at   = COALESCE(synced_at, NOW())
WHERE
  sync_status <> 'synced'
  AND synced_position_size IS NULL
  AND synced_avg_price IS NULL
  AND synced_current_value IS NULL
  AND synced_payout_if_wins IS NULL
  AND last_known_position_size IS NULL
  AND last_known_avg_price IS NULL
  AND last_known_current_value IS NULL
  AND last_known_payout_if_wins IS NULL
  AND sync_error IS NULL; -- only tag ones that aren't already explained

-- 1f) Dedupe rows before adding uniqueness (keep "best" row per (wallet, condition_id, outcome))
-- Keeps the most recently synced row; if none synced, keeps the most recently nonzero.
WITH ranked AS (
  SELECT
    ctid,
    ROW_NUMBER() OVER (
      PARTITION BY wallet, condition_id, outcome
      ORDER BY
        synced_at DESC NULLS LAST,
        last_nonzero_at DESC NULLS LAST
    ) AS rn
  FROM position_sync_overlay
)
DELETE FROM position_sync_overlay p
USING ranked r
WHERE p.ctid = r.ctid AND r.rn > 1;

-- ============================================================
-- SECTION 2: SCHEMA HARDENING (run AFTER Section 1)
-- ============================================================

-- 2a) Enforce key columns not null
ALTER TABLE position_sync_overlay
  ALTER COLUMN wallet SET NOT NULL,
  ALTER COLUMN condition_id SET NOT NULL,
  ALTER COLUMN outcome SET NOT NULL;

-- 2b) sync_status default + not null
ALTER TABLE position_sync_overlay
  ALTER COLUMN sync_status SET DEFAULT 'pending',
  ALTER COLUMN sync_status SET NOT NULL;

-- 2c) Validate allowed sync_status values
ALTER TABLE position_sync_overlay DROP CONSTRAINT IF EXISTS chk_sync_status;
ALTER TABLE position_sync_overlay
  ADD CONSTRAINT chk_sync_status
  CHECK (sync_status IN ('pending', 'synced', 'not_found', 'error'));

-- 2d) synced_at must be present when sync_status='synced'
ALTER TABLE position_sync_overlay DROP CONSTRAINT IF EXISTS chk_synced_at_required;
ALTER TABLE position_sync_overlay
  ADD CONSTRAINT chk_synced_at_required
  CHECK (sync_status <> 'synced' OR synced_at IS NOT NULL);

-- 2e) Prevent empty/whitespace-only key columns (btrim catches '   ')
-- These complement NOT NULL to ensure keys are meaningful, not just "technically non-null"
ALTER TABLE position_sync_overlay DROP CONSTRAINT IF EXISTS chk_wallet_nonempty;
ALTER TABLE position_sync_overlay
  ADD CONSTRAINT chk_wallet_nonempty
  CHECK (btrim(wallet) <> '');

ALTER TABLE position_sync_overlay DROP CONSTRAINT IF EXISTS chk_condition_id_nonempty;
ALTER TABLE position_sync_overlay
  ADD CONSTRAINT chk_condition_id_nonempty
  CHECK (btrim(condition_id) <> '');

ALTER TABLE position_sync_overlay DROP CONSTRAINT IF EXISTS chk_outcome_nonempty;
ALTER TABLE position_sync_overlay
  ADD CONSTRAINT chk_outcome_nonempty
  CHECK (btrim(outcome) <> '');

-- ============================================================
-- SECTION 3: UNIQUENESS + PERFORMANCE INDEXES (CONCURRENTLY)
-- Run these statements separately (no transaction).
-- ============================================================

-- 3a) Enforce uniqueness for true key (use UNIQUE INDEX; safer than adding PK in a busy system)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_pso_wallet_condition_outcome
  ON position_sync_overlay (wallet, condition_id, outcome);

-- 3b) For backlog queries: fast existence check of successfully synced rows
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pso_wallet_condition_outcome_synced
  ON position_sync_overlay (wallet, condition_id, outcome)
  WHERE sync_status = 'synced';

-- 3c) If you frequently filter by wallet then status/time
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pso_wallet_status_syncedat
  ON position_sync_overlay (wallet, sync_status, synced_at DESC);

-- 3d) Snapshot helper index for lag checks
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wps_wallet_updated
  ON wallet_position_snapshot (wallet, updated_at DESC);

-- ============================================================
-- SECTION 4: OBSERVABILITY TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS position_sync_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'error')),
  wallets_requested INT NOT NULL DEFAULT 0,
  wallets_synced INT NOT NULL DEFAULT 0,
  wallets_failed INT NOT NULL DEFAULT 0,
  positions_upserted INT NOT NULL DEFAULT 0,
  positions_not_found INT NOT NULL DEFAULT 0,
  backlog_wallets_selected INT NOT NULL DEFAULT 0,
  lagging_wallets_selected INT NOT NULL DEFAULT 0,
  error_message TEXT,
  metrics JSONB
);

CREATE TABLE IF NOT EXISTS position_sync_run_wallet (
  run_id UUID NOT NULL REFERENCES position_sync_run(id) ON DELETE CASCADE,
  wallet TEXT NOT NULL,
  selection_reason TEXT NOT NULL CHECK (selection_reason IN ('backlog', 'lagging', 'stale', 'alert_events', 'snapshot', 'other')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'synced', 'error', 'skipped')),
  positions_synced INT,
  positions_not_found INT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, wallet)
);

CREATE INDEX IF NOT EXISTS idx_position_sync_run_started
  ON position_sync_run (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_position_sync_run_wallet_wallet
  ON position_sync_run_wallet (wallet);

-- ============================================================
-- SECTION 5: VERIFY
-- ============================================================

-- 5a) Stub rows should be gone or explicitly error/pending; no NULL status
-- SELECT COUNT(*) AS null_status FROM position_sync_overlay WHERE sync_status IS NULL;

-- 5b) No duplicate keys
-- SELECT wallet, condition_id, outcome, COUNT(*)
-- FROM position_sync_overlay
-- GROUP BY 1,2,3
-- HAVING COUNT(*) > 1;

-- 5c) No empty/whitespace-only keys
-- SELECT COUNT(*) AS empty_keys
-- FROM position_sync_overlay
-- WHERE btrim(wallet) = '' OR btrim(condition_id) = '' OR btrim(outcome) = '';

-- 5d) No "fake synced" rows (synced without synced_at)
-- SELECT COUNT(*) AS bad_synced
-- FROM position_sync_overlay
-- WHERE sync_status = 'synced' AND synced_at IS NULL;

-- 5e) Constraints
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'position_sync_overlay'::regclass;

-- 5f) Unique index valid
-- SELECT c.relname AS index_name, i.indisunique, i.indisvalid, i.indisready
-- FROM pg_index i
-- JOIN pg_class c ON c.oid = i.indexrelid
-- JOIN pg_class t ON t.oid = i.indrelid
-- WHERE t.relname = 'position_sync_overlay'
--   AND c.relname = 'uq_pso_wallet_condition_outcome';

-- 5g) Observability tables exist
-- SELECT tablename FROM pg_tables WHERE tablename LIKE 'position_sync_run%';

-- 5h) Backlog count (should decrease over time after deploy)
-- SELECT COUNT(DISTINCT s.wallet) AS wallets_with_missing_synced_overlay
-- FROM wallet_position_snapshot s
-- WHERE s.shares > 0
--   AND NOT EXISTS (
--     SELECT 1
--     FROM position_sync_overlay o
--     WHERE o.wallet = s.wallet
--       AND o.condition_id = s.condition_id
--       AND o.outcome = s.outcome
--       AND o.sync_status = 'synced'
--       AND o.synced_at IS NOT NULL
--   );
