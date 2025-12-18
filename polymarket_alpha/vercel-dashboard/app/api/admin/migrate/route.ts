// /app/api/admin/migrate/route.ts
// Secure migration endpoint for Phases 1-4
// POST-only, protected by middleware Basic Auth
// Additionally requires ENABLE_ADMIN_MIGRATIONS=true env var

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // 1. Check ENABLE_ADMIN_MIGRATIONS env var (additional safety gate)
  if (process.env.ENABLE_ADMIN_MIGRATIONS !== 'true') {
    return NextResponse.json(
      { error: 'Admin migrations disabled. Set ENABLE_ADMIN_MIGRATIONS=true' },
      { status: 403 }
    );
  }

  // 2. Auth is handled by middleware (Basic Auth for /api/admin/*)
  // Verify middleware passed the request through
  const middlewareAuth = request.headers.get('x-middleware-auth');
  if (middlewareAuth !== 'passed') {
    // In case middleware didn't run (shouldn't happen), deny access
    console.warn('[migrate] Request reached route without middleware auth');
    return NextResponse.json(
      { error: 'Unauthorized - use Basic Auth' },
      { status: 401 }
    );
  }

  // 3. Run idempotent migrations
  try {
    console.log('[migrate] Starting migrations (Phases 1-4)...');

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
    console.log('[migrate] Created job_runs indexes');

    // Post-migration: run ANALYZE on touched tables for query planner
    try {
      await sql`ANALYZE outcome_price_cache`;
      await sql`ANALYZE job_runs`;
      console.log('[migrate] ANALYZE completed on cache and job tables');
    } catch (err) {
      console.warn('[migrate] ANALYZE failed (non-critical):', String(err).slice(0, 100));
    }

    console.log('[migrate] Migration complete');

    return NextResponse.json({
      success: true,
      message: 'Phases 1-4 migration complete (hardened)',
      tables: ['alert_events', 'outcome_price_cache', 'job_runs'],
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
      ],
      constraints: [
        'outcome_price_cache PRIMARY KEY (condition_id, outcome)',
        'outcome_price_cache CHECK (price >= 0 AND price <= 1)',
      ],
    });
  } catch (err) {
    console.error('[migrate] Migration failed:', err);
    return NextResponse.json(
      { error: 'Migration failed', details: String(err) },
      { status: 500 }
    );
  }
}

// Only allow POST
export async function GET() {
  return NextResponse.json(
    { error: 'Method not allowed. Use POST.' },
    { status: 405 }
  );
}
