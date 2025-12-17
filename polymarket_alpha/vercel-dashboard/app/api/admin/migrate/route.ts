// /app/api/admin/migrate/route.ts
// Secure migration endpoint for Phase 1
// POST-only, requires ADMIN_SECRET header and ENABLE_ADMIN_MIGRATIONS=true

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // 1. Check ENABLE_ADMIN_MIGRATIONS env var
  if (process.env.ENABLE_ADMIN_MIGRATIONS !== 'true') {
    return NextResponse.json(
      { error: 'Admin migrations disabled. Set ENABLE_ADMIN_MIGRATIONS=true' },
      { status: 403 }
    );
  }

  // 2. Verify ADMIN_SECRET header
  const secret = request.headers.get('x-admin-secret');
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json(
      { error: 'Invalid admin secret' },
      { status: 401 }
    );
  }

  // 3. Run idempotent migrations
  try {
    console.log('[migrate] Starting Phase 1 migration...');

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
    console.log('[migrate] Created alert_events indexes');

    // Add whale_watchlist lowercase index (may fail if table doesn't exist)
    try {
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_whale_watchlist_wallet_lower ON whale_watchlist (LOWER(wallet))`;
      console.log('[migrate] Created whale_watchlist index');
    } catch (err) {
      console.warn('[migrate] Could not create whale_watchlist index (table may not exist):', err);
    }

    console.log('[migrate] Migration complete');

    return NextResponse.json({
      success: true,
      message: 'Phase 1 migration complete',
      tables: ['alert_events'],
      indexes: [
        'idx_alert_events_fill_timestamp',
        'idx_alert_events_wallet_timestamp',
        'idx_alert_events_event_slug',
        'idx_alert_events_condition_outcome',
        'idx_alert_events_asset',
        'idx_alert_events_is_whale',
        'idx_alert_events_qualifies_longshot',
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
