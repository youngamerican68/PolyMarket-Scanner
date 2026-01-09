// /app/api/debug-position/route.ts
// Debug endpoint to see position data for a specific wallet
// Usage: GET /api/debug-position?wallet=0x4128...

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { fetchPositionsWithRetry } from '@/lib/polymarket';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get('wallet');

  if (!wallet) {
    return NextResponse.json({ error: 'wallet parameter required' }, { status: 400 });
  }

  const walletLower = wallet.toLowerCase();

  try {
    // 1. Get alert_events rows for this wallet
    const alertEvents = await sql`
      SELECT
        id,
        condition_id,
        outcome,
        outcome_index,
        title,
        fill_price::text,
        fill_timestamp::text,
        position_size::text,
        position_avg_price::text,
        position_current_value::text,
        threshold_source
      FROM alert_events
      WHERE wallet = ${walletLower}
      ORDER BY fill_timestamp DESC
      LIMIT 20
    `;

    // 2. Get position_sync_overlay rows for this wallet
    const overlayRows = await sql`
      SELECT
        condition_id,
        outcome,
        synced_position_size::text,
        synced_avg_price::text,
        synced_current_value::text,
        synced_payout_if_wins::text,
        last_known_position_size::text,
        last_known_avg_price::text,
        last_known_current_value::text,
        synced_at::text,
        sync_status,
        position_state
      FROM position_sync_overlay
      WHERE wallet = ${walletLower}
      ORDER BY synced_at DESC
      LIMIT 20
    `;

    // 3. Get wallet_sync_state
    const syncState = await sql`
      SELECT
        last_synced_at::text,
        last_sync_status,
        positions_count,
        last_sync_error,
        last_sync_duration_ms
      FROM wallet_sync_state
      WHERE wallet = ${walletLower}
    `;

    // 4. Fetch live positions from Polymarket API
    let livePositions: any[] = [];
    let liveError: string | null = null;
    try {
      const { positions } = await fetchPositionsWithRetry(walletLower, 100);
      livePositions = positions.map(p => ({
        conditionId: p.conditionId,
        outcome: p.outcome,
        outcomeIndex: p.outcomeIndex,
        size: p.size,
        avgPrice: p.avgPrice,
        curPrice: p.curPrice,
        currentValue: p.currentValue,
        title: p.title,
      }));
    } catch (err) {
      liveError = err instanceof Error ? err.message : String(err);
    }

    return NextResponse.json({
      wallet: walletLower,
      alertEvents: alertEvents.rows,
      overlayRows: overlayRows.rows,
      syncState: syncState.rows[0] || null,
      livePositions,
      liveError,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    return NextResponse.json(
      { error: 'Debug query failed', details: String(err) },
      { status: 500 }
    );
  }
}
