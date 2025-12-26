-- 005_position_sync_ultra_hardening.sql
-- Phase 10.4: Ultra Production Hardening
--
-- Goals:
-- 1. Make all constraints rerunnable (DROP IF EXISTS before ADD)
-- 2. Ensure backfill only sets last_nonzero_at from meaningful non-zero snapshots
-- 3. Add CHECK constraint ensuring last_nonzero_at implies meaningful last_known_* data
-- 4. Deterministic constraint names to avoid collisions

-- =============================================================================
-- Step 1: Ensure CHECK constraints are rerunnable
-- =============================================================================
-- Drop and re-add with deterministic names to ensure idempotency

-- Drop existing constraints if they exist (safe re-run)
DO $$
BEGIN
  -- Drop position_state constraint
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_position_state') THEN
    ALTER TABLE position_sync_overlay DROP CONSTRAINT chk_position_state;
  END IF;

  -- Drop sync_status constraint
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_sync_status') THEN
    ALTER TABLE position_sync_overlay DROP CONSTRAINT chk_sync_status;
  END IF;
END $$;

-- Re-add position_state CHECK constraint with NOT VALID + VALIDATE (production-safe)
ALTER TABLE position_sync_overlay
ADD CONSTRAINT chk_position_state
CHECK (position_state IN ('open', 'not_found_in_sync', 'closed_confirmed', 'redeemed_confirmed', 'unknown'))
NOT VALID;

ALTER TABLE position_sync_overlay VALIDATE CONSTRAINT chk_position_state;

-- Re-add sync_status CHECK constraint with NOT VALID + VALIDATE (production-safe)
ALTER TABLE position_sync_overlay
ADD CONSTRAINT chk_sync_status
CHECK (sync_status IN ('synced', 'not_found', 'error'))
NOT VALID;

ALTER TABLE position_sync_overlay VALIDATE CONSTRAINT chk_sync_status;

-- =============================================================================
-- Step 2: Fix any rows where last_nonzero_at is set but last_known_* are all NULL/zero
-- =============================================================================
-- This shouldn't happen, but clean up any bad data from previous migrations

UPDATE position_sync_overlay
SET last_nonzero_at = NULL
WHERE last_nonzero_at IS NOT NULL
  AND (
    last_known_position_size IS NULL OR last_known_position_size <= 0
  )
  AND (
    last_known_payout_if_wins IS NULL OR last_known_payout_if_wins <= 0
  );

-- =============================================================================
-- Step 3: Ensure backfill only sets last_nonzero_at from meaningful non-zero snapshots
-- =============================================================================
-- Idempotent COALESCE-based backfill that only fills from positive synced values
-- This is a safety re-run of the backfill with stricter conditions

UPDATE position_sync_overlay
SET
  -- Only fill last_known_position_size if NULL and synced value is positive
  last_known_position_size = COALESCE(
    last_known_position_size,
    CASE WHEN synced_position_size > 0 THEN synced_position_size ELSE NULL END
  ),
  -- Only fill last_known_avg_price if NULL and we have synced avg_price with a positive position
  last_known_avg_price = COALESCE(
    last_known_avg_price,
    CASE WHEN synced_position_size > 0 AND synced_avg_price IS NOT NULL THEN synced_avg_price ELSE NULL END
  ),
  -- Only fill last_known_current_value if NULL and synced value is positive
  last_known_current_value = COALESCE(
    last_known_current_value,
    CASE WHEN synced_current_value > 0 THEN synced_current_value ELSE NULL END
  ),
  -- Only fill last_known_payout_if_wins if NULL and synced value is positive
  last_known_payout_if_wins = COALESCE(
    last_known_payout_if_wins,
    CASE WHEN synced_payout_if_wins > 0 THEN synced_payout_if_wins ELSE NULL END
  ),
  -- Only set last_nonzero_at if NULL and we have a meaningful positive position
  last_nonzero_at = COALESCE(
    last_nonzero_at,
    CASE WHEN synced_position_size > 0 AND synced_payout_if_wins > 0 THEN synced_at ELSE NULL END
  )
WHERE
  -- Only update rows that actually need backfill (idempotent)
  (
    (last_known_position_size IS NULL AND synced_position_size > 0)
    OR (last_known_avg_price IS NULL AND synced_position_size > 0 AND synced_avg_price IS NOT NULL)
    OR (last_known_current_value IS NULL AND synced_current_value > 0)
    OR (last_known_payout_if_wins IS NULL AND synced_payout_if_wins > 0)
    OR (last_nonzero_at IS NULL AND synced_position_size > 0 AND synced_payout_if_wins > 0)
  );

-- =============================================================================
-- Step 4: Add CHECK constraint for last_nonzero_at integrity
-- =============================================================================
-- Constraint: if last_nonzero_at is set, at least one of last_known_position_size
-- or last_known_payout_if_wins must be non-null and positive

-- Drop if exists (safe re-run)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_last_nonzero_at_integrity') THEN
    ALTER TABLE position_sync_overlay DROP CONSTRAINT chk_last_nonzero_at_integrity;
  END IF;
END $$;

-- Add constraint: last_nonzero_at implies meaningful last_known data exists
ALTER TABLE position_sync_overlay
ADD CONSTRAINT chk_last_nonzero_at_integrity
CHECK (
  last_nonzero_at IS NULL
  OR last_known_position_size > 0
  OR last_known_payout_if_wins > 0
)
NOT VALID;

ALTER TABLE position_sync_overlay VALIDATE CONSTRAINT chk_last_nonzero_at_integrity;

-- =============================================================================
-- Step 5: Add index for quality-based concurrency lookups
-- =============================================================================
-- Index to support the quality-based tie-breaker WHERE clause efficiently

CREATE INDEX IF NOT EXISTS idx_position_sync_overlay_concurrency
  ON position_sync_overlay (wallet, condition_id, outcome, synced_at, sync_status);

-- =============================================================================
-- Step 6: Document the quality-based tie-breaker semantics
-- =============================================================================
COMMENT ON COLUMN position_sync_overlay.sync_status IS
  'Sync result quality: synced (highest - found), not_found (medium), error (lowest). Used for tie-breaking at equal timestamps.';

-- ANALYZE for query planner
ANALYZE position_sync_overlay;
