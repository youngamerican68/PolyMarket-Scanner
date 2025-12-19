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
  // Verify middleware passed the request through
  const middlewareAuth = request.headers.get('x-middleware-auth');
  if (middlewareAuth !== 'passed') {
    // In case middleware didn't run (shouldn't happen), deny access
    auditLog('blocked', { requestId, reason: 'no_middleware_auth', clientIp });
    return NextResponse.json(
      { error: 'Unauthorized - use Basic Auth' },
      { status: 401, headers: NO_CACHE_HEADERS }
    );
  }

  // 3. Audit log: migration started
  auditLog('started', { requestId, clientIp });

  // 4. Run idempotent migrations
  try {
    console.log('[migrate] Starting migrations (Phases 1-5)...');

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

    // Post-migration: run ANALYZE on touched tables for query planner
    try {
      await sql`ANALYZE outcome_price_cache`;
      await sql`ANALYZE job_runs`;
      await sql`ANALYZE wallet_trade_size_baselines`;
      await sql`ANALYZE conviction_anomalies`;
      console.log('[migrate] ANALYZE completed on all tables');
    } catch (err) {
      console.warn('[migrate] ANALYZE failed (non-critical):', String(err).slice(0, 100));
    }

    console.log('[migrate] Migration complete');
    auditLog('completed', { requestId, clientIp, success: true });

    return NextResponse.json({
      success: true,
      message: 'Phases 1-5 migration complete (includes conviction anomalies)',
      tables: ['alert_events', 'outcome_price_cache', 'job_runs', 'wallet_trade_size_baselines', 'conviction_anomalies'],
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
      ],
      constraints: [
        'outcome_price_cache PRIMARY KEY (condition_id, outcome)',
        'outcome_price_cache CHECK (price >= 0 AND price <= 1)',
        'wallet_trade_size_baselines PRIMARY KEY (wallet)',
        'conviction_anomalies REFERENCES alert_events(id)',
      ],
      columnsAdded: [
        'conviction_anomalies.severity',
        'conviction_anomalies.last_seen_at',
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
