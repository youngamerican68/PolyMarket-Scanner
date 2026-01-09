// /app/api/admin/migrate/route.ts
// Secure migration endpoint for Phases 1-5
// POST-only, protected by middleware Basic Auth
// Additionally requires ENABLE_ADMIN_MIGRATIONS=true env var
//
// SECURITY NOTES (production deployment):
// - Keep ENABLE_ADMIN_MIGRATIONS unset or 'false' in prod by default
// - Only set ENABLE_ADMIN_MIGRATIONS=true temporarily when running migrations
// - Consider running migrations via CLI/CI instead of HTTP endpoint
// - Never log secrets; this endpoint logs execution but not auth details

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Response headers to prevent caching (admin endpoints + caches are dangerous)
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

// Audit log helper (no secrets)
function auditLog(event: string, details?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({
    event: `migrate:${event}`,
    timestamp,
    ...details,
  }));
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID().slice(0, 8);
  const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

  // 1. Check ENABLE_ADMIN_MIGRATIONS env var (additional safety gate)
  if (process.env.ENABLE_ADMIN_MIGRATIONS !== 'true') {
    auditLog('blocked', { requestId, reason: 'migrations_disabled', clientIp });
    return NextResponse.json(
      { error: 'Admin migrations disabled. Set ENABLE_ADMIN_MIGRATIONS=true' },
      { status: 403, headers: NO_CACHE_HEADERS }
    );
  }

  // 2. Auth is handled by middleware (Basic Auth for /api/admin/*)
  // Middleware matcher includes /api/admin/* so if we get here, auth passed
  // No need to check for x-middleware-auth header (removed as spoofable)

  // 3. Audit log: migration started
  auditLog('started', { requestId, clientIp });

  // 4. Run idempotent migrations
  try {
    console.log('[migrate] Starting migrations (Phases 1-7)...');

    // Create alert_events table
    await sql`
      CREATE TABLE IF NOT EXISTS alert_events (
        id UUID PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        trade_dedupe_id TEXT NOT NULL UNIQUE,
        transaction_hash TEXT NULL,
        fill_timestamp TIMESTAMPTZ NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
        fill_price NUMERIC NOT NULL,
        fill_size NUMERIC NOT NULL,
        fill_value_usd NUMERIC NOT NULL,
        wallet TEXT NOT NULL CONSTRAINT alert_events_wallet_lower CHECK (wallet = LOWER(wallet)),
        trader_name TEXT NULL,
        trader_pseudonym TEXT NULL,
        asset TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        outcome_index INT NOT NULL,
        title TEXT NULL,
        slug TEXT NULL,
        event_slug TEXT NULL,
        position_size NUMERIC NULL,
        position_avg_price NUMERIC NULL,
        position_cur_price NUMERIC NULL,
        position_initial_value NUMERIC NULL,
        position_current_value NUMERIC NULL,
        position_cash_pnl NUMERIC NULL,
        position_snapshot_at TIMESTAMPTZ NULL,
        longshot_threshold NUMERIC NOT NULL DEFAULT 0.25,
        min_position_threshold NUMERIC NOT NULL DEFAULT 2500,
        qualifies_longshot BOOLEAN NOT NULL,
        qualifies_min_position BOOLEAN NOT NULL,
        threshold_value_used NUMERIC NULL,
        threshold_source TEXT NULL,
        is_whale BOOLEAN NOT NULL DEFAULT FALSE,
        whale_label TEXT NULL,
        whale_tier TEXT NULL,
        whale_category TEXT NULL
      )
    `;
    console.log('[migrate] Created alert_events table');

    // Create indexes
    await sql`CREATE INDEX IF NOT EXISTS idx_alert_events_fill_timestamp ON alert_events (fill_timestamp DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_alert_events_wallet_timestamp ON alert_events (wallet, fill_timestamp DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_alert_events_event_slug ON alert_events (event_slug)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_alert_events_condition_outcome ON alert_events (condition_id, outcome_index)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_alert_events_asset ON alert_events (asset)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_alert_events_is_whale ON alert_events (is_whale) WHERE is_whale = TRUE`;
    await sql`CREATE INDEX IF NOT EXISTS idx_alert_events_qualifies_longshot ON alert_events (qualifies_longshot) WHERE qualifies_longshot = TRUE`;

    // Phase 2: Convergence detection indexes
    // Covers GROUP BY (condition_id, outcome) with wallet deduplication and time ordering
    await sql`CREATE INDEX IF NOT EXISTS idx_alert_events_convergence
      ON alert_events (condition_id, outcome, wallet, fill_timestamp DESC)`;
    // Composite for filtered convergence queries (fill_price filter + time window)
    // Uses INCLUDE for index-only scans on commonly accessed columns
    await sql`CREATE INDEX IF NOT EXISTS idx_alert_events_convergence_filtered
      ON alert_events (fill_timestamp DESC, fill_price)
      INCLUDE (position_current_value, condition_id, outcome, wallet, is_whale, whale_category)
      WHERE position_current_value IS NOT NULL`;
    console.log('[migrate] Created alert_events indexes (including Phase 2 convergence)');

    // Add whale_watchlist lowercase index (may fail if table doesn't exist)
    try {
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_whale_watchlist_wallet_lower ON whale_watchlist (LOWER(wallet))`;
      console.log('[migrate] Created whale_watchlist index');
    } catch (err) {
      console.warn('[migrate] Could not create whale_watchlist index (table may not exist):', err);
    }

    // =========================================================================
    // Phase 3: Price Cache table
    // =========================================================================
    await sql`
      CREATE TABLE IF NOT EXISTS outcome_price_cache (
        condition_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        price NUMERIC(10, 6) NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source TEXT,
        PRIMARY KEY (condition_id, outcome)
      )
    `;
    console.log('[migrate] Created outcome_price_cache table');

    // Add CHECK constraint for valid price range (0-1 inclusive)
    // Using try/catch for idempotency since ALTER TABLE ADD CONSTRAINT is not IF NOT EXISTS
    try {
      await sql`
        ALTER TABLE outcome_price_cache
        ADD CONSTRAINT chk_price_range CHECK (price >= 0 AND price <= 1)
      `;
      console.log('[migrate] Added price range constraint');
    } catch (err) {
      // Constraint likely already exists
      console.log('[migrate] Price range constraint already exists or failed:', String(err).slice(0, 100));
    }

    // Deduplicate any existing rows (keep newest by fetched_at)
    // This handles any historical duplicates before the PK was enforced
    try {
      const dedupeResult = await sql`
        WITH duplicates AS (
          SELECT condition_id, outcome, fetched_at,
                 ROW_NUMBER() OVER (PARTITION BY condition_id, outcome ORDER BY fetched_at DESC) as rn
          FROM outcome_price_cache
        )
        DELETE FROM outcome_price_cache
        WHERE (condition_id, outcome, fetched_at) IN (
          SELECT condition_id, outcome, fetched_at FROM duplicates WHERE rn > 1
        )
      `;
      if (dedupeResult.rowCount && dedupeResult.rowCount > 0) {
        console.log(`[migrate] Removed ${dedupeResult.rowCount} duplicate price cache rows`);
      }
    } catch (err) {
      console.log('[migrate] Deduplication skipped (PK already enforces uniqueness)');
    }

    await sql`CREATE INDEX IF NOT EXISTS idx_outcome_price_cache_fetched_at ON outcome_price_cache (fetched_at DESC)`;
    console.log('[migrate] Created outcome_price_cache indexes');

    // =========================================================================
    // Phase 4: Job Runs table for tracking cron jobs
    // =========================================================================
    await sql`
      CREATE TABLE IF NOT EXISTS job_runs (
        id TEXT PRIMARY KEY,
        job_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        duration_ms INTEGER,
        metrics JSONB,
        error TEXT
      )
    `;
    console.log('[migrate] Created job_runs table');

    await sql`CREATE INDEX IF NOT EXISTS idx_job_runs_job_name_started ON job_runs (job_name, started_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs (status) WHERE status = 'running'`;
    // Heartbeat monitoring: index for efficient last success/error lookups per job
    await sql`CREATE INDEX IF NOT EXISTS idx_job_runs_heartbeat ON job_runs (job_name, status, finished_at DESC)`;
    console.log('[migrate] Created job_runs indexes (including heartbeat)');

    // =========================================================================
    // Phase 5: Conviction Sizing Anomaly Detection
    // =========================================================================

    // Table 1: wallet_trade_size_baselines - cached baseline stats per wallet
    await sql`
      CREATE TABLE IF NOT EXISTS wallet_trade_size_baselines (
        wallet TEXT PRIMARY KEY CONSTRAINT baseline_wallet_lower CHECK (wallet = LOWER(wallet)),
        trade_count INTEGER NOT NULL,
        median_notional NUMERIC(18, 6) NOT NULL,
        mad NUMERIC(18, 6) NOT NULL,
        lookback_start TIMESTAMPTZ NOT NULL,
        lookback_end TIMESTAMPTZ NOT NULL,
        computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    console.log('[migrate] Created wallet_trade_size_baselines table');

    // Index for finding stale baselines
    await sql`CREATE INDEX IF NOT EXISTS idx_baselines_computed_at ON wallet_trade_size_baselines (computed_at)`;
    console.log('[migrate] Created wallet_trade_size_baselines indexes');

    // Table 2: conviction_anomalies - detected anomaly events
    await sql`
      CREATE TABLE IF NOT EXISTS conviction_anomalies (
        id UUID PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        alert_event_id UUID NOT NULL REFERENCES alert_events(id),
        trade_dedupe_id TEXT NOT NULL UNIQUE,
        wallet TEXT NOT NULL CONSTRAINT anomaly_wallet_lower CHECK (wallet = LOWER(wallet)),
        fill_timestamp TIMESTAMPTZ NOT NULL,
        trade_notional NUMERIC(18, 6) NOT NULL,
        baseline_median NUMERIC(18, 6) NOT NULL,
        baseline_mad NUMERIC(18, 6) NOT NULL,
        baseline_trade_count INTEGER NOT NULL,
        ratio_to_median NUMERIC(10, 4) NOT NULL,
        robust_z NUMERIC(10, 4) NULL,
        condition_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        title TEXT NULL,
        slug TEXT NULL,
        side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
        fill_price NUMERIC NOT NULL,
        is_whale BOOLEAN NOT NULL DEFAULT FALSE,
        trader_name TEXT NULL
      )
    `;
    console.log('[migrate] Created conviction_anomalies table');

    // Phase 5 Hardening: Add severity column for ranking anomalies
    // severity = ln(1 + notional) * ln(1 + ratio) - monotonic, bounded-ish
    try {
      await sql`ALTER TABLE conviction_anomalies ADD COLUMN severity NUMERIC(12, 4) NOT NULL DEFAULT 0`;
      console.log('[migrate] Added severity column to conviction_anomalies');
    } catch (err) {
      console.log('[migrate] severity column already exists or failed:', String(err).slice(0, 80));
    }

    // Phase 5 Hardening: Add last_seen_at for dedupe tracking
    try {
      await sql`ALTER TABLE conviction_anomalies ADD COLUMN last_seen_at TIMESTAMPTZ NULL`;
      console.log('[migrate] Added last_seen_at column to conviction_anomalies');
    } catch (err) {
      console.log('[migrate] last_seen_at column already exists or failed:', String(err).slice(0, 80));
    }

    // Backfill severity for existing rows: severity = ln(1 + notional) * ln(1 + ratio)
    try {
      const backfillResult = await sql`
        UPDATE conviction_anomalies
        SET severity = LN(1 + trade_notional) * LN(1 + ratio_to_median)
        WHERE severity = 0 OR severity IS NULL
      `;
      if (backfillResult.rowCount && backfillResult.rowCount > 0) {
        console.log(`[migrate] Backfilled severity for ${backfillResult.rowCount} anomaly rows`);
      }
    } catch (err) {
      console.log('[migrate] Severity backfill skipped:', String(err).slice(0, 80));
    }

    // Indexes for conviction_anomalies
    await sql`CREATE INDEX IF NOT EXISTS idx_conviction_anomalies_fill_timestamp ON conviction_anomalies (fill_timestamp DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_conviction_anomalies_wallet ON conviction_anomalies (wallet, fill_timestamp DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_conviction_anomalies_ratio ON conviction_anomalies (ratio_to_median DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_conviction_anomalies_alert_event ON conviction_anomalies (alert_event_id)`;

    // Phase 5 Hardening: Add severity index for sorting
    await sql`CREATE INDEX IF NOT EXISTS idx_conviction_anomalies_severity ON conviction_anomalies (severity DESC, created_at DESC)`;

    // Phase 5 Hardening: Add dedupe index for wallet + condition_id lookups within time window
    // Uses COALESCE(last_seen_at, created_at) to support "continuing event" merging
    await sql`CREATE INDEX IF NOT EXISTS idx_conviction_anomalies_dedupe ON conviction_anomalies (wallet, condition_id, COALESCE(last_seen_at, created_at) DESC)`;

    console.log('[migrate] Created conviction_anomalies indexes (including severity + dedupe)');

    // =========================================================================
    // Phase 6: Market Resolution Status Tracking
    // =========================================================================

    await sql`
      CREATE TABLE IF NOT EXISTS market_status (
        condition_id TEXT PRIMARY KEY,
        market_closed BOOLEAN NOT NULL DEFAULT FALSE,
        market_closed_first_seen_at TIMESTAMPTZ,
        market_resolved BOOLEAN NOT NULL DEFAULT FALSE,
        market_resolved_first_seen_at TIMESTAMPTZ,
        winning_outcome TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    console.log('[migrate] Created market_status table');

    // Index for filtering resolved markets in report queries
    await sql`CREATE INDEX IF NOT EXISTS idx_market_status_resolved ON market_status (market_resolved, updated_at DESC)`;
    // Partial index for EXISTS lookups by condition_id (only resolved markets with known winners)
    await sql`CREATE INDEX IF NOT EXISTS idx_market_status_resolved_winner ON market_status (condition_id) WHERE market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != ''`;
    console.log('[migrate] Created market_status indexes');

    // =========================================================================
    // Phase 7: Longshot Position Archive (raw snapshots only)
    // =========================================================================

    await sql`
      CREATE TABLE IF NOT EXISTS trade_history_longshot_positions (
        id BIGSERIAL PRIMARY KEY,
        dedupe_key TEXT UNIQUE NOT NULL,
        wallet TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        fill_price NUMERIC(10, 6) NOT NULL,
        pos_avg_entry NUMERIC(10, 6),
        position_value_usd NUMERIC(18, 2) NOT NULL,
        potential_win_usd NUMERIC(18, 2),
        observed_at TIMESTAMPTZ NOT NULL,
        source TEXT NOT NULL DEFAULT 'large_single_bet',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    console.log('[migrate] Created trade_history_longshot_positions table');

    // Indexes for leaderboard queries
    await sql`CREATE INDEX IF NOT EXISTS idx_longshot_positions_wallet_observed
      ON trade_history_longshot_positions (wallet, observed_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_longshot_positions_condition
      ON trade_history_longshot_positions (condition_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_longshot_positions_observed
      ON trade_history_longshot_positions (observed_at DESC)`;
    console.log('[migrate] Created trade_history_longshot_positions indexes');

    // =========================================================================
    // Phase 8: Final P&L on Market Resolution
    // =========================================================================

    // Table: market_final_pnl - stores final P&L per wallet/outcome when market resolves
    await sql`
      CREATE TABLE IF NOT EXISTS market_final_pnl (
        condition_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        outcome TEXT NOT NULL,
        position_found BOOLEAN NOT NULL DEFAULT FALSE,
        shares NUMERIC,
        avg_price NUMERIC,
        potential_win NUMERIC,
        cost_basis NUMERIC,
        final_pnl NUMERIC,
        winning_outcome TEXT NOT NULL,
        finalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (condition_id, wallet, outcome)
      )
    `;
    console.log('[migrate] Created market_final_pnl table');

    // Indexes for market_final_pnl
    await sql`CREATE INDEX IF NOT EXISTS idx_market_final_pnl_condition ON market_final_pnl (condition_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_market_final_pnl_wallet ON market_final_pnl (wallet)`;
    console.log('[migrate] Created market_final_pnl indexes');

    // Add finalized_at column to market_status for idempotency
    try {
      await sql`ALTER TABLE market_status ADD COLUMN finalized_at TIMESTAMPTZ`;
      console.log('[migrate] Added finalized_at column to market_status');
    } catch (err) {
      console.log('[migrate] finalized_at column already exists or failed:', String(err).slice(0, 80));
    }

    // =========================================================================
    // Phase 9: Position Snapshots + Estimated P&L tracking
    // =========================================================================

    // Table: wallet_position_snapshot - stores latest open position snapshots
    // Used to estimate P&L when positions disappear after market resolution
    await sql`
      CREATE TABLE IF NOT EXISTS wallet_position_snapshot (
        wallet TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        shares DOUBLE PRECISION NOT NULL,
        avg_price DOUBLE PRECISION NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (wallet, condition_id, outcome)
      )
    `;
    console.log('[migrate] Created wallet_position_snapshot table');

    // Index for efficient lookups by condition_id
    await sql`CREATE INDEX IF NOT EXISTS idx_wallet_position_snapshot_condition ON wallet_position_snapshot (condition_id)`;
    console.log('[migrate] Created wallet_position_snapshot index');

    // Add estimate tracking columns to market_final_pnl
    try {
      await sql`ALTER TABLE market_final_pnl ADD COLUMN is_estimated BOOLEAN NOT NULL DEFAULT FALSE`;
      console.log('[migrate] Added is_estimated column to market_final_pnl');
    } catch (err) {
      console.log('[migrate] is_estimated column already exists or failed:', String(err).slice(0, 80));
    }

    try {
      await sql`ALTER TABLE market_final_pnl ADD COLUMN estimate_source TEXT`;
      console.log('[migrate] Added estimate_source column to market_final_pnl');
    } catch (err) {
      console.log('[migrate] estimate_source column already exists or failed:', String(err).slice(0, 80));
    }

    try {
      await sql`ALTER TABLE market_final_pnl ADD COLUMN estimate_as_of TIMESTAMPTZ`;
      console.log('[migrate] Added estimate_as_of column to market_final_pnl');
    } catch (err) {
      console.log('[migrate] estimate_as_of column already exists or failed:', String(err).slice(0, 80));
    }

    // =========================================================================
    // Phase 10: Position Sync Overlay (on-demand position refresh)
    // Feature flag: ENABLE_POSITION_SYNC
    // Additive only - does NOT modify existing snapshot fields
    // =========================================================================

    // Table: position_sync_overlay - stores current position data overlay
    // Keyed by (wallet, condition_id, outcome) to match dashboard rows
    await sql`
      CREATE TABLE IF NOT EXISTS position_sync_overlay (
        wallet TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        synced_position_size NUMERIC,
        synced_avg_price NUMERIC,
        synced_current_value NUMERIC,
        synced_payout_if_wins NUMERIC,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sync_status TEXT NOT NULL DEFAULT 'synced',
        sync_error TEXT,
        PRIMARY KEY (wallet, condition_id, outcome)
      )
    `;
    console.log('[migrate] Created position_sync_overlay table');

    // Indexes for efficient lookups
    await sql`CREATE INDEX IF NOT EXISTS idx_position_sync_overlay_wallet ON position_sync_overlay (wallet)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_position_sync_overlay_synced_at ON position_sync_overlay (synced_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_position_sync_overlay_condition ON position_sync_overlay (condition_id)`;
    console.log('[migrate] Created position_sync_overlay indexes');

    // Table: wallet_sync_state - TTL cache for wallet-level sync tracking
    // Prevents re-syncing the same wallet within TTL window
    await sql`
      CREATE TABLE IF NOT EXISTS wallet_sync_state (
        wallet TEXT PRIMARY KEY,
        last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_sync_status TEXT NOT NULL DEFAULT 'success',
        positions_count INTEGER NOT NULL DEFAULT 0,
        last_sync_error TEXT,
        last_sync_duration_ms INTEGER
      )
    `;
    console.log('[migrate] Created wallet_sync_state table');

    // Index for TTL queries
    await sql`CREATE INDEX IF NOT EXISTS idx_wallet_sync_state_last_synced ON wallet_sync_state (last_synced_at DESC)`;
    console.log('[migrate] Created wallet_sync_state index');

    // =========================================================================
    // Phase 10.1: Safe State Model for Position Sync Overlay
    // Fixes bug where sync-empty overwrites last-known values with zeros
    // =========================================================================

    // Add position_state column
    try {
      await sql`ALTER TABLE position_sync_overlay ADD COLUMN position_state TEXT NOT NULL DEFAULT 'unknown'`;
      console.log('[migrate] Added position_state column to position_sync_overlay');
    } catch (err) {
      console.log('[migrate] position_state column already exists or failed:', String(err).slice(0, 80));
    }

    // Add last_known_* columns
    try {
      await sql`ALTER TABLE position_sync_overlay ADD COLUMN last_known_position_size NUMERIC`;
      console.log('[migrate] Added last_known_position_size column');
    } catch (err) {
      console.log('[migrate] last_known_position_size column already exists');
    }

    try {
      await sql`ALTER TABLE position_sync_overlay ADD COLUMN last_known_avg_price NUMERIC`;
      console.log('[migrate] Added last_known_avg_price column');
    } catch (err) {
      console.log('[migrate] last_known_avg_price column already exists');
    }

    try {
      await sql`ALTER TABLE position_sync_overlay ADD COLUMN last_known_current_value NUMERIC`;
      console.log('[migrate] Added last_known_current_value column');
    } catch (err) {
      console.log('[migrate] last_known_current_value column already exists');
    }

    try {
      await sql`ALTER TABLE position_sync_overlay ADD COLUMN last_known_payout_if_wins NUMERIC`;
      console.log('[migrate] Added last_known_payout_if_wins column');
    } catch (err) {
      console.log('[migrate] last_known_payout_if_wins column already exists');
    }

    try {
      await sql`ALTER TABLE position_sync_overlay ADD COLUMN last_nonzero_at TIMESTAMPTZ`;
      console.log('[migrate] Added last_nonzero_at column');
    } catch (err) {
      console.log('[migrate] last_nonzero_at column already exists');
    }

    // Add CHECK constraint for valid position states
    try {
      await sql`ALTER TABLE position_sync_overlay ADD CONSTRAINT chk_position_state CHECK (position_state IN ('open', 'not_found_in_sync', 'closed_confirmed', 'redeemed_confirmed', 'unknown'))`;
      console.log('[migrate] Added position_state constraint');
    } catch (err) {
      console.log('[migrate] position_state constraint already exists');
    }

    // Backfill existing rows
    try {
      const backfillResult = await sql`
        UPDATE position_sync_overlay
        SET
          position_state = CASE
            WHEN sync_status = 'synced' AND synced_position_size IS NOT NULL AND synced_position_size > 0 THEN 'open'
            WHEN sync_status = 'not_found' THEN 'not_found_in_sync'
            ELSE 'unknown'
          END,
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
          last_nonzero_at = CASE
            WHEN synced_position_size IS NOT NULL AND synced_position_size > 0 THEN synced_at
            ELSE last_nonzero_at
          END
        WHERE position_state = 'unknown' OR last_known_position_size IS NULL
      `;
      if (backfillResult.rowCount && backfillResult.rowCount > 0) {
        console.log(`[migrate] Backfilled ${backfillResult.rowCount} position_sync_overlay rows`);
      }
    } catch (err) {
      console.log('[migrate] Backfill skipped:', String(err).slice(0, 80));
    }

    // Create indexes for position_state queries
    await sql`CREATE INDEX IF NOT EXISTS idx_position_sync_overlay_state ON position_sync_overlay (position_state)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_position_sync_overlay_not_found ON position_sync_overlay (position_state, last_nonzero_at DESC) WHERE position_state = 'not_found_in_sync'`;
    console.log('[migrate] Created position_sync_overlay safe state indexes');

    // =========================================================================
    // Phase 10.2: Hardening for Safe State Model
    // Fixes: robust backfill, CHECK constraint for sync_status, data integrity
    // =========================================================================

    // Add CHECK constraint for sync_status
    try {
      await sql`ALTER TABLE position_sync_overlay ADD CONSTRAINT chk_sync_status CHECK (sync_status IN ('synced', 'not_found', 'error'))`;
      console.log('[migrate] Added sync_status constraint');
    } catch (err) {
      console.log('[migrate] sync_status constraint already exists');
    }

    // Robust backfill: populate last_known_* from synced_* where last_known_* is NULL
    try {
      const backfill1 = await sql`
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
          AND synced_position_size > 0
      `;
      if (backfill1.rowCount && backfill1.rowCount > 0) {
        console.log(`[migrate] Hardening backfill 1: populated ${backfill1.rowCount} rows with last_known values`);
      }
    } catch (err) {
      console.log('[migrate] Hardening backfill 1 skipped:', String(err).slice(0, 80));
    }

    // Ensure open positions have last_known set
    try {
      const backfill2 = await sql`
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
          AND synced_position_size IS NOT NULL
      `;
      if (backfill2.rowCount && backfill2.rowCount > 0) {
        console.log(`[migrate] Hardening backfill 2: fixed ${backfill2.rowCount} open positions with missing last_known`);
      }
    } catch (err) {
      console.log('[migrate] Hardening backfill 2 skipped:', String(err).slice(0, 80));
    }

    // Ensure position_state is consistent with sync_status
    try {
      await sql`
        UPDATE position_sync_overlay
        SET position_state = 'open'
        WHERE sync_status = 'synced'
          AND synced_position_size IS NOT NULL
          AND synced_position_size > 0
          AND position_state NOT IN ('open', 'closed_confirmed', 'redeemed_confirmed')
      `;
      await sql`
        UPDATE position_sync_overlay
        SET position_state = 'not_found_in_sync'
        WHERE sync_status = 'not_found'
          AND position_state NOT IN ('not_found_in_sync', 'closed_confirmed', 'redeemed_confirmed')
      `;
      console.log('[migrate] Hardening: ensured position_state consistency');
    } catch (err) {
      console.log('[migrate] Hardening state consistency skipped:', String(err).slice(0, 80));
    }

    // =========================================================================
    // Phase 10.3: Final Production Hardening
    // NOT VALID + VALIDATE for CHECK constraints, COALESCE-based partial backfill
    // =========================================================================

    // Step 1: Normalize any invalid position_state values FIRST
    try {
      const normalizeResult = await sql`
        UPDATE position_sync_overlay
        SET position_state = 'unknown'
        WHERE position_state IS NULL
           OR position_state NOT IN ('open', 'not_found_in_sync', 'closed_confirmed', 'redeemed_confirmed', 'unknown')
      `;
      if (normalizeResult.rowCount && normalizeResult.rowCount > 0) {
        console.log(`[migrate] Phase 10.3: Normalized ${normalizeResult.rowCount} invalid position_state values`);
      }
    } catch (err) {
      console.log('[migrate] Phase 10.3: Normalization skipped:', String(err).slice(0, 80));
    }

    // Step 2: Drop and re-add constraints with NOT VALID + VALIDATE
    try {
      // Drop existing constraints if they exist
      await sql`ALTER TABLE position_sync_overlay DROP CONSTRAINT IF EXISTS chk_position_state`;
      await sql`ALTER TABLE position_sync_overlay DROP CONSTRAINT IF EXISTS chk_sync_status`;
      console.log('[migrate] Phase 10.3: Dropped existing constraints (if any)');

      // Re-add with NOT VALID (instant, no table scan)
      await sql`ALTER TABLE position_sync_overlay ADD CONSTRAINT chk_position_state CHECK (position_state IN ('open', 'not_found_in_sync', 'closed_confirmed', 'redeemed_confirmed', 'unknown')) NOT VALID`;
      await sql`ALTER TABLE position_sync_overlay VALIDATE CONSTRAINT chk_position_state`;
      console.log('[migrate] Phase 10.3: Added and validated chk_position_state');

      await sql`ALTER TABLE position_sync_overlay ADD CONSTRAINT chk_sync_status CHECK (sync_status IN ('synced', 'not_found', 'error')) NOT VALID`;
      await sql`ALTER TABLE position_sync_overlay VALIDATE CONSTRAINT chk_sync_status`;
      console.log('[migrate] Phase 10.3: Added and validated chk_sync_status');
    } catch (err) {
      console.log('[migrate] Phase 10.3: Constraint setup issue:', String(err).slice(0, 100));
    }

    // Step 3: COALESCE-based idempotent backfill for partial nulls
    try {
      const coalesceResult = await sql`
        UPDATE position_sync_overlay
        SET
          last_known_position_size = COALESCE(last_known_position_size,
            CASE WHEN synced_position_size > 0 THEN synced_position_size ELSE NULL END),
          last_known_avg_price = COALESCE(last_known_avg_price,
            CASE WHEN synced_position_size > 0 AND synced_avg_price IS NOT NULL THEN synced_avg_price ELSE NULL END),
          last_known_current_value = COALESCE(last_known_current_value,
            CASE WHEN synced_current_value > 0 THEN synced_current_value ELSE NULL END),
          last_known_payout_if_wins = COALESCE(last_known_payout_if_wins,
            CASE WHEN synced_payout_if_wins > 0 THEN synced_payout_if_wins ELSE NULL END),
          last_nonzero_at = COALESCE(last_nonzero_at,
            CASE WHEN synced_position_size > 0 AND synced_payout_if_wins > 0 THEN synced_at ELSE NULL END)
        WHERE
          (last_known_position_size IS NULL AND synced_position_size > 0)
          OR (last_known_avg_price IS NULL AND synced_position_size > 0 AND synced_avg_price IS NOT NULL)
          OR (last_known_current_value IS NULL AND synced_current_value > 0)
          OR (last_known_payout_if_wins IS NULL AND synced_payout_if_wins > 0)
          OR (last_nonzero_at IS NULL AND synced_position_size > 0 AND synced_payout_if_wins > 0)
      `;
      if (coalesceResult.rowCount && coalesceResult.rowCount > 0) {
        console.log(`[migrate] Phase 10.3: COALESCE backfill updated ${coalesceResult.rowCount} rows`);
      }
    } catch (err) {
      console.log('[migrate] Phase 10.3: COALESCE backfill skipped:', String(err).slice(0, 80));
    }

    // =========================================================================
    // Phase 10.4: Ultra Production Hardening
    // last_nonzero_at integrity, concurrency index
    // =========================================================================

    // Step 1: Fix any rows where last_nonzero_at is set but last_known_* are all NULL/zero
    try {
      const fixIntegrityResult = await sql`
        UPDATE position_sync_overlay
        SET last_nonzero_at = NULL
        WHERE last_nonzero_at IS NOT NULL
          AND (last_known_position_size IS NULL OR last_known_position_size <= 0)
          AND (last_known_payout_if_wins IS NULL OR last_known_payout_if_wins <= 0)
      `;
      if (fixIntegrityResult.rowCount && fixIntegrityResult.rowCount > 0) {
        console.log(`[migrate] Phase 10.4: Fixed ${fixIntegrityResult.rowCount} rows with orphaned last_nonzero_at`);
      }
    } catch (err) {
      console.log('[migrate] Phase 10.4: Integrity fix skipped:', String(err).slice(0, 80));
    }

    // Step 2: Add CHECK constraint for last_nonzero_at integrity
    try {
      await sql`ALTER TABLE position_sync_overlay DROP CONSTRAINT IF EXISTS chk_last_nonzero_at_integrity`;
      await sql`ALTER TABLE position_sync_overlay ADD CONSTRAINT chk_last_nonzero_at_integrity CHECK (last_nonzero_at IS NULL OR last_known_position_size > 0 OR last_known_payout_if_wins > 0) NOT VALID`;
      await sql`ALTER TABLE position_sync_overlay VALIDATE CONSTRAINT chk_last_nonzero_at_integrity`;
      console.log('[migrate] Phase 10.4: Added and validated chk_last_nonzero_at_integrity');
    } catch (err) {
      console.log('[migrate] Phase 10.4: Integrity constraint issue:', String(err).slice(0, 100));
    }

    // Step 3: Add index for quality-based concurrency lookups
    await sql`CREATE INDEX IF NOT EXISTS idx_position_sync_overlay_concurrency ON position_sync_overlay (wallet, condition_id, outcome, synced_at, sync_status)`;
    console.log('[migrate] Phase 10.4: Created concurrency index');

    // Step 4: Add column comment for sync_status quality semantics
    try {
      await sql`COMMENT ON COLUMN position_sync_overlay.sync_status IS 'Sync result quality: synced (highest - found), not_found (medium), error (lowest). Used for tie-breaking at equal timestamps.'`;
      console.log('[migrate] Phase 10.4: Added sync_status column comment');
    } catch (err) {
      console.log('[migrate] Phase 10.4: Column comment skipped');
    }

    console.log('[migrate] Phase 10.3 + 10.4 hardening complete');

    // =========================================================================
    // Phase 12: Trade Ingest Watermark for Robust Pagination
    // Stores composite watermark (timestamp + trade_id) to ensure no trades missed
    // =========================================================================

    await sql`
      CREATE TABLE IF NOT EXISTS trade_ingest_watermark (
        id TEXT PRIMARY KEY DEFAULT 'default',
        last_timestamp BIGINT NOT NULL DEFAULT 0,
        last_trade_dedupe_id TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    console.log('[migrate] Created trade_ingest_watermark table');

    // Insert default watermark seeded to now - 2 minutes (lookback window)
    // This ensures first run captures going-forward only, not unbounded history
    await sql`
      INSERT INTO trade_ingest_watermark (id, last_timestamp, last_trade_dedupe_id)
      VALUES (
        'default',
        EXTRACT(EPOCH FROM NOW())::bigint - 120,
        ''
      )
      ON CONFLICT (id) DO NOTHING
    `;
    console.log('[migrate] Initialized default watermark to now - 120s');

    // =========================================================================
    // Phase 11: Watchlist for Radar Trades
    // Allows users to save interesting trades to track for later
    // =========================================================================

    await sql`
      CREATE TABLE IF NOT EXISTS radar_watchlist (
        id SERIAL PRIMARY KEY,
        wallet TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        title TEXT,
        fill_price NUMERIC,
        position_cost NUMERIC,
        potential_payout NUMERIC,
        insider_score INTEGER,
        notes TEXT,
        saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        resolution_outcome TEXT,
        UNIQUE (wallet, condition_id, outcome)
      )
    `;
    console.log('[migrate] Created radar_watchlist table');

    // Indexes for watchlist
    await sql`CREATE INDEX IF NOT EXISTS idx_radar_watchlist_saved_at ON radar_watchlist (saved_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_radar_watchlist_condition ON radar_watchlist (condition_id)`;
    console.log('[migrate] Created radar_watchlist indexes');

    // =========================================================================
    // Phase 13: Pending Longshot Wallets
    // Tracks wallets that made longshot trades but were skipped due to position < $2,500
    // Re-scanned periodically by scan-pending job to capture once threshold met
    // =========================================================================

    await sql`
      CREATE TABLE IF NOT EXISTS pending_longshot_wallets (
        wallet TEXT PRIMARY KEY CONSTRAINT pending_longshot_wallets_lower CHECK (wallet = LOWER(wallet)),
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_trade_at TIMESTAMPTZ NOT NULL,
        last_condition_id TEXT NOT NULL,
        last_trade_price NUMERIC NOT NULL,
        last_trade_size NUMERIC NOT NULL,
        last_position_value NUMERIC NULL,
        times_skipped INT NOT NULL DEFAULT 1,
        last_scanned_at TIMESTAMPTZ NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'captured', 'expired'))
      )
    `;
    console.log('[migrate] Created pending_longshot_wallets table');

    // Index for re-scan job to find pending wallets
    await sql`CREATE INDEX IF NOT EXISTS idx_pending_longshot_wallets_status ON pending_longshot_wallets(status) WHERE status = 'pending'`;
    // Index for cleanup of old entries
    await sql`CREATE INDEX IF NOT EXISTS idx_pending_longshot_wallets_first_seen ON pending_longshot_wallets(first_seen_at)`;
    console.log('[migrate] Created pending_longshot_wallets indexes');

    // Post-migration: run ANALYZE on touched tables for query planner
    try {
      await sql`ANALYZE outcome_price_cache`;
      await sql`ANALYZE job_runs`;
      await sql`ANALYZE wallet_trade_size_baselines`;
      await sql`ANALYZE conviction_anomalies`;
      await sql`ANALYZE market_status`;
      await sql`ANALYZE trade_history_longshot_positions`;
      await sql`ANALYZE market_final_pnl`;
      await sql`ANALYZE wallet_position_snapshot`;
      await sql`ANALYZE position_sync_overlay`;
      await sql`ANALYZE wallet_sync_state`;
      await sql`ANALYZE radar_watchlist`;
      await sql`ANALYZE trade_ingest_watermark`;
      await sql`ANALYZE pending_longshot_wallets`;
      console.log('[migrate] ANALYZE completed on all tables');
    } catch (err) {
      console.warn('[migrate] ANALYZE failed (non-critical):', String(err).slice(0, 100));
    }

    console.log('[migrate] Migration complete');
    auditLog('completed', { requestId, clientIp, success: true });

    return NextResponse.json({
      success: true,
      message: 'Phases 1-13 migration complete (includes pending_longshot_wallets)',
      tables: ['alert_events', 'outcome_price_cache', 'job_runs', 'wallet_trade_size_baselines', 'conviction_anomalies', 'market_status', 'trade_history_longshot_positions', 'market_final_pnl', 'wallet_position_snapshot', 'position_sync_overlay', 'wallet_sync_state', 'radar_watchlist', 'trade_ingest_watermark', 'pending_longshot_wallets'],
      indexes: [
        'idx_alert_events_fill_timestamp',
        'idx_alert_events_wallet_timestamp',
        'idx_alert_events_event_slug',
        'idx_alert_events_condition_outcome',
        'idx_alert_events_asset',
        'idx_alert_events_is_whale',
        'idx_alert_events_qualifies_longshot',
        'idx_alert_events_convergence',
        'idx_alert_events_convergence_filtered',
        'idx_outcome_price_cache_fetched_at',
        'idx_job_runs_job_name_started',
        'idx_job_runs_status',
        'idx_job_runs_heartbeat',
        'idx_baselines_computed_at',
        'idx_conviction_anomalies_fill_timestamp',
        'idx_conviction_anomalies_wallet',
        'idx_conviction_anomalies_ratio',
        'idx_conviction_anomalies_alert_event',
        'idx_conviction_anomalies_severity',
        'idx_conviction_anomalies_dedupe',
        'idx_market_status_resolved',
        'idx_longshot_positions_wallet_observed',
        'idx_longshot_positions_condition',
        'idx_longshot_positions_observed',
        'idx_market_final_pnl_condition',
        'idx_market_final_pnl_wallet',
        'idx_wallet_position_snapshot_condition',
        'idx_position_sync_overlay_wallet',
        'idx_position_sync_overlay_synced_at',
        'idx_position_sync_overlay_condition',
        'idx_position_sync_overlay_state',
        'idx_position_sync_overlay_not_found',
        'idx_position_sync_overlay_concurrency',
        'idx_wallet_sync_state_last_synced',
        'idx_pending_longshot_wallets_status',
        'idx_pending_longshot_wallets_first_seen',
      ],
      constraints: [
        'outcome_price_cache PRIMARY KEY (condition_id, outcome)',
        'outcome_price_cache CHECK (price >= 0 AND price <= 1)',
        'wallet_trade_size_baselines PRIMARY KEY (wallet)',
        'conviction_anomalies REFERENCES alert_events(id)',
        'market_status PRIMARY KEY (condition_id)',
        'market_final_pnl PRIMARY KEY (condition_id, wallet, outcome)',
        'wallet_position_snapshot PRIMARY KEY (wallet, condition_id, outcome)',
        'position_sync_overlay PRIMARY KEY (wallet, condition_id, outcome)',
        'position_sync_overlay CHECK chk_position_state (open, not_found_in_sync, closed_confirmed, redeemed_confirmed, unknown)',
        'position_sync_overlay CHECK chk_sync_status (synced, not_found, error)',
        'position_sync_overlay CHECK chk_last_nonzero_at_integrity',
        'wallet_sync_state PRIMARY KEY (wallet)',
        'pending_longshot_wallets PRIMARY KEY (wallet)',
        'pending_longshot_wallets CHECK status IN (pending, captured, expired)',
      ],
      columnsAdded: [
        'conviction_anomalies.severity',
        'conviction_anomalies.last_seen_at',
        'market_status.finalized_at',
        'market_final_pnl.is_estimated',
        'market_final_pnl.estimate_source',
        'market_final_pnl.estimate_as_of',
        'position_sync_overlay.position_state',
        'position_sync_overlay.last_known_position_size',
        'position_sync_overlay.last_known_avg_price',
        'position_sync_overlay.last_known_current_value',
        'position_sync_overlay.last_known_payout_if_wins',
        'position_sync_overlay.last_nonzero_at',
      ],
    }, { headers: NO_CACHE_HEADERS });
  } catch (err) {
    console.error('[migrate] Migration failed:', err);
    auditLog('failed', { requestId, clientIp, error: String(err).slice(0, 200) });
    return NextResponse.json(
      { error: 'Migration failed', details: String(err) },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}

// Only allow POST
export async function GET() {
  return NextResponse.json(
    { error: 'Method not allowed. Use POST.' },
    { status: 405, headers: NO_CACHE_HEADERS }
  );
}
