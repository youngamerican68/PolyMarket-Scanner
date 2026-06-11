-- Migration 006: Indexes for sync-positions unified wallet sourcing
-- These indexes optimize the wallet selection and position lookup queries
-- that combine alert_events and wallet_position_snapshot sources.
--
-- Run via: POST /api/admin/migrate with ENABLE_ADMIN_MIGRATIONS=true
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
-- Ensure your migration runner executes this migration without wrapping it
-- in BEGIN/COMMIT.

-- ============================================================
-- ALERT_EVENTS INDEXES
-- ============================================================

-- idx_alert_events_fill_ts_condition was dropped 2026-06-11: pg_stat showed
-- zero scans and EXPLAIN confirmed the planner satisfies the 72h-window
-- DISTINCT condition_id query with idx_alert_events_fill_timestamp instead.
DROP INDEX CONCURRENTLY IF EXISTS idx_alert_events_fill_ts_condition;

-- Index for per-wallet lookups with 72h filter
-- Used by: alert_wallets CTE, getDashboardRowsForWallet
-- Query pattern: WHERE wallet = $w AND fill_timestamp >= $cutoff AND condition_id IN (...)
-- Existing idx_alert_events_wallet_timestamp covers (wallet, fill_timestamp DESC)
-- This adds condition_id for covering index benefit on the IN clause
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_alert_events_wallet_fill_condition
  ON alert_events (wallet, fill_timestamp DESC, condition_id)
  WHERE condition_id IS NOT NULL;

-- ============================================================
-- WALLET_POSITION_SNAPSHOT INDEXES
-- ============================================================

-- Index for condition_id lookups (for unresolved_conditions CTE)
-- Query pattern: SELECT DISTINCT condition_id FROM wallet_position_snapshot
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_position_snapshot_condition
  ON wallet_position_snapshot (condition_id)
  WHERE condition_id IS NOT NULL;

-- Composite index for wallet + condition_id lookups
-- Used by: getDashboardRowsForWallet, snapshot_wallets CTE
-- Query pattern: WHERE wallet = $wallet AND condition_id IN (...)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_position_snapshot_wallet_condition
  ON wallet_position_snapshot (wallet, condition_id);

-- ============================================================
-- MARKET_STATUS INDEXES
-- ============================================================

-- Index for unresolved market checks (NOT EXISTS pattern)
-- Query pattern: WHERE condition_id = $cid AND market_resolved = TRUE AND ...
-- Partial index only includes resolved markets to make NOT EXISTS fast
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_market_status_resolved
  ON market_status (condition_id)
  WHERE market_resolved = TRUE
    AND winning_outcome IS NOT NULL
    AND TRIM(winning_outcome) != '';

-- ============================================================
-- WALLET_SYNC_STATE INDEXES
-- ============================================================

-- wallet is already PK, but we need last_synced_at for staleness checks
-- Query pattern: LEFT JOIN wallet_sync_state, ORDER BY priority (based on last_synced_at)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_sync_state_last_synced
  ON wallet_sync_state (wallet, last_synced_at DESC);

-- ============================================================
-- POSITION_SYNC_OVERLAY INDEXES
-- ============================================================

-- Index for reconciliation check (countUnresolvedSnapshotWalletsNotInOverlay)
-- Query pattern: WHERE wallet = $w AND condition_id = $c AND outcome = $o AND synced_at >= $ts
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_position_sync_overlay_reconciliation
  ON position_sync_overlay (wallet, condition_id, outcome, synced_at DESC);

-- ============================================================
-- VERIFICATION QUERIES
-- ============================================================

-- After running this migration, verify indexes exist:
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE tablename IN (
--   'alert_events',
--   'wallet_position_snapshot',
--   'market_status',
--   'wallet_sync_state',
--   'position_sync_overlay'
-- )
-- ORDER BY tablename, indexname;
