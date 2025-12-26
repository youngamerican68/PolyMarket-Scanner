-- 004_position_sync_final_hardening.sql
-- Phase 10.3: Final Production Hardening for Safe State Model
--
-- Fixes:
-- 1. Normalize any invalid position_state values to 'unknown' BEFORE constraint validation
-- 2. Re-add CHECK constraint using NOT VALID + VALIDATE approach (production-safe)
-- 3. COALESCE-based idempotent backfill for partial nulls
-- 4. Ensure data integrity across all last_known_* fields

-- =============================================================================
-- Step 1: Normalize any invalid position_state values FIRST
-- =============================================================================
-- This must run BEFORE adding/validating the CHECK constraint
-- Handles any rows that somehow have invalid position_state values

UPDATE position_sync_overlay
SET position_state = 'unknown'
WHERE position_state IS NULL
   OR position_state NOT IN ('open', 'not_found_in_sync', 'closed_confirmed', 'redeemed_confirmed', 'unknown');

-- =============================================================================
-- Step 2: Handle CHECK constraint using NOT VALID + VALIDATE approach
-- =============================================================================
-- This is production-safe: NOT VALID adds constraint without scanning table,
-- then VALIDATE CONSTRAINT does a separate scan without holding exclusive lock

-- First, drop the existing constraint if it exists (it may have been added without NOT VALID)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_position_state'
  ) THEN
    ALTER TABLE position_sync_overlay DROP CONSTRAINT chk_position_state;
  END IF;
END $$;

-- Now add with NOT VALID (instant, no table scan)
ALTER TABLE position_sync_overlay
ADD CONSTRAINT chk_position_state
CHECK (position_state IN ('open', 'not_found_in_sync', 'closed_confirmed', 'redeemed_confirmed', 'unknown'))
NOT VALID;

-- Validate separately (allows concurrent reads, doesn't hold ACCESS EXCLUSIVE lock entire time)
ALTER TABLE position_sync_overlay VALIDATE CONSTRAINT chk_position_state;

-- =============================================================================
-- Step 3: COALESCE-based idempotent backfill for partial nulls
-- =============================================================================
-- Previous migrations only filled when ALL last_known_* were NULL
-- This handles partial nulls: if any last_known_* field is NULL but synced_* has data, fill it

UPDATE position_sync_overlay
SET
  -- For each field: if last_known is NULL but synced has data, use synced value
  last_known_position_size = COALESCE(last_known_position_size,
    CASE WHEN synced_position_size IS NOT NULL AND synced_position_size > 0
         THEN synced_position_size
         ELSE NULL
    END),
  last_known_avg_price = COALESCE(last_known_avg_price, synced_avg_price),
  last_known_current_value = COALESCE(last_known_current_value, synced_current_value),
  last_known_payout_if_wins = COALESCE(last_known_payout_if_wins,
    CASE WHEN synced_payout_if_wins IS NOT NULL AND synced_payout_if_wins > 0
         THEN synced_payout_if_wins
         ELSE NULL
    END),
  -- Also ensure last_nonzero_at is set if we have position data
  last_nonzero_at = COALESCE(last_nonzero_at,
    CASE WHEN synced_position_size IS NOT NULL AND synced_position_size > 0
         THEN synced_at
         ELSE NULL
    END)
WHERE
  -- Only update rows that actually need backfill (idempotent)
  (
    (last_known_position_size IS NULL AND synced_position_size IS NOT NULL AND synced_position_size > 0)
    OR (last_known_avg_price IS NULL AND synced_avg_price IS NOT NULL)
    OR (last_known_current_value IS NULL AND synced_current_value IS NOT NULL)
    OR (last_known_payout_if_wins IS NULL AND synced_payout_if_wins IS NOT NULL AND synced_payout_if_wins > 0)
    OR (last_nonzero_at IS NULL AND synced_position_size IS NOT NULL AND synced_position_size > 0)
  );

-- =============================================================================
-- Step 4: Ensure position_state consistency with sync_status
-- =============================================================================
-- If we have synced data with non-zero position, state should be 'open'
-- If sync_status = 'not_found', state should be 'not_found_in_sync' (unless confirmed)

UPDATE position_sync_overlay
SET position_state = 'open'
WHERE sync_status = 'synced'
  AND synced_position_size IS NOT NULL
  AND synced_position_size > 0
  AND position_state = 'unknown';

UPDATE position_sync_overlay
SET position_state = 'not_found_in_sync'
WHERE sync_status = 'not_found'
  AND position_state = 'unknown';

-- =============================================================================
-- Step 5: Add comment documenting timestamp semantics
-- =============================================================================
COMMENT ON COLUMN position_sync_overlay.synced_at IS 'When this sync batch started (consistent across all rows in batch). Updates on every sync attempt.';
COMMENT ON COLUMN position_sync_overlay.last_nonzero_at IS 'When we last saw a non-zero position. Only updates when position_size > 0 is found.';

-- ANALYZE for query planner
ANALYZE position_sync_overlay;
