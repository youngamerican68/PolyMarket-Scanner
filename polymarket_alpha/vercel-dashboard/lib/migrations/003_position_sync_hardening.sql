-- 003_position_sync_hardening.sql
-- Phase 10.2: Hardening for Safe State Model
--
-- Fixes:
-- 1. More robust backfill: populate last_known_* from synced_* where last_known_* is NULL
-- 2. Add CHECK constraint for sync_status
-- 3. Ensure data integrity with proper constraints

-- Step 1: Add CHECK constraint for sync_status (allowed: synced, not_found, error)
-- Using DO block for idempotency
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_sync_status'
  ) THEN
    ALTER TABLE position_sync_overlay
    ADD CONSTRAINT chk_sync_status
    CHECK (sync_status IN ('synced', 'not_found', 'error'));
  END IF;
END $$;

-- Step 2: Robust backfill - populate last_known_* from synced_* where:
-- - last_known_* is NULL AND synced_* has meaningful data
-- This catches rows missed by the original migration (where position_state was already set)
UPDATE position_sync_overlay
SET
  last_known_position_size = synced_position_size,
  last_known_avg_price = synced_avg_price,
  last_known_current_value = synced_current_value,
  last_known_payout_if_wins = synced_payout_if_wins,
  last_nonzero_at = COALESCE(last_nonzero_at, synced_at)
WHERE
  last_known_position_size IS NULL
  AND synced_position_size IS NOT NULL
  AND synced_position_size > 0;

-- Step 3: For rows in not_found_in_sync state that somehow have NULL last_known_*
-- but had non-zero synced_* before (edge case recovery)
-- Look at sync_status = 'synced' in the past (we can't directly access history,
-- but we can at least ensure any row with position_state='open' has last_known set)
UPDATE position_sync_overlay
SET
  last_known_position_size = synced_position_size,
  last_known_avg_price = synced_avg_price,
  last_known_current_value = synced_current_value,
  last_known_payout_if_wins = synced_payout_if_wins,
  last_nonzero_at = synced_at
WHERE
  position_state = 'open'
  AND last_known_position_size IS NULL
  AND synced_position_size IS NOT NULL;

-- Step 4: Ensure position_state is consistent with sync_status
-- If sync_status = 'synced' and we have position data, state should be 'open'
-- If sync_status = 'not_found', state should be 'not_found_in_sync' (unless confirmed)
UPDATE position_sync_overlay
SET position_state = 'open'
WHERE sync_status = 'synced'
  AND synced_position_size IS NOT NULL
  AND synced_position_size > 0
  AND position_state NOT IN ('open', 'closed_confirmed', 'redeemed_confirmed');

UPDATE position_sync_overlay
SET position_state = 'not_found_in_sync'
WHERE sync_status = 'not_found'
  AND position_state NOT IN ('not_found_in_sync', 'closed_confirmed', 'redeemed_confirmed');

-- ANALYZE for query planner
ANALYZE position_sync_overlay;
