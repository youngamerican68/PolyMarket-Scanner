-- 002_position_sync_safe_state.sql
-- Phase 10.1: Safe State Model for Position Sync Overlay
-- Fixes bug where sync-empty overwrites last-known values with zeros
--
-- Key changes:
-- 1. Add last_known_* columns to preserve non-zero values
-- 2. Add position_state enum to track: open, not_found_in_sync, closed_confirmed, redeemed_confirmed, unknown
-- 3. Add last_nonzero_at timestamp for "as of" display

-- Step 1: Add position_state column
-- Values: 'open' | 'not_found_in_sync' | 'closed_confirmed' | 'redeemed_confirmed' | 'unknown'
ALTER TABLE position_sync_overlay
ADD COLUMN IF NOT EXISTS position_state TEXT NOT NULL DEFAULT 'unknown';

-- Step 2: Add last_known_* columns (preserve non-zero values)
ALTER TABLE position_sync_overlay
ADD COLUMN IF NOT EXISTS last_known_position_size NUMERIC;

ALTER TABLE position_sync_overlay
ADD COLUMN IF NOT EXISTS last_known_avg_price NUMERIC;

ALTER TABLE position_sync_overlay
ADD COLUMN IF NOT EXISTS last_known_current_value NUMERIC;

ALTER TABLE position_sync_overlay
ADD COLUMN IF NOT EXISTS last_known_payout_if_wins NUMERIC;

-- Step 3: Add timestamp for when we last saw non-zero position
ALTER TABLE position_sync_overlay
ADD COLUMN IF NOT EXISTS last_nonzero_at TIMESTAMPTZ;

-- Step 4: Add CHECK constraint for valid position states
-- Using DO block for idempotency (constraint may already exist)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_position_state'
  ) THEN
    ALTER TABLE position_sync_overlay
    ADD CONSTRAINT chk_position_state
    CHECK (position_state IN ('open', 'not_found_in_sync', 'closed_confirmed', 'redeemed_confirmed', 'unknown'));
  END IF;
END $$;

-- Step 5: Backfill existing rows
-- Rows with sync_status='synced' and synced_position_size > 0 → position_state='open'
-- Rows with sync_status='not_found' → position_state='not_found_in_sync'
-- Also populate last_known_* from current synced_* where synced values exist
UPDATE position_sync_overlay
SET
  position_state = CASE
    WHEN sync_status = 'synced' AND synced_position_size IS NOT NULL AND synced_position_size > 0 THEN 'open'
    WHEN sync_status = 'not_found' THEN 'not_found_in_sync'
    ELSE 'unknown'
  END,
  -- Populate last_known_* from synced_* where they have non-zero values
  last_known_position_size = CASE
    WHEN synced_position_size IS NOT NULL AND synced_position_size > 0 THEN synced_position_size
    ELSE last_known_position_size
  END,
  last_known_avg_price = CASE
    WHEN synced_avg_price IS NOT NULL THEN synced_avg_price
    ELSE last_known_avg_price
  END,
  last_known_current_value = CASE
    WHEN synced_current_value IS NOT NULL THEN synced_current_value
    ELSE last_known_current_value
  END,
  last_known_payout_if_wins = CASE
    WHEN synced_payout_if_wins IS NOT NULL AND synced_payout_if_wins > 0 THEN synced_payout_if_wins
    ELSE last_known_payout_if_wins
  END,
  -- Set last_nonzero_at to synced_at for rows that have position data
  last_nonzero_at = CASE
    WHEN synced_position_size IS NOT NULL AND synced_position_size > 0 THEN synced_at
    ELSE last_nonzero_at
  END
WHERE position_state = 'unknown' OR position_state IS NULL;

-- Step 6: Create index for efficient filtering by position_state
CREATE INDEX IF NOT EXISTS idx_position_sync_overlay_state
  ON position_sync_overlay (position_state);

-- Step 7: Create index for querying not_found positions
CREATE INDEX IF NOT EXISTS idx_position_sync_overlay_not_found
  ON position_sync_overlay (position_state, last_nonzero_at DESC)
  WHERE position_state = 'not_found_in_sync';

-- ANALYZE for query planner
ANALYZE position_sync_overlay;
