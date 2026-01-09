// /app/api/wallet-check/route.ts
// Public endpoint to check if a wallet is in our database
// Usage: GET /api/wallet-check?wallet=0x...

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get('wallet');

  if (!wallet) {
    return NextResponse.json({ error: 'wallet parameter required' }, { status: 400, headers: NO_CACHE_HEADERS });
  }

  const walletLower = wallet.toLowerCase();

  try {
    // Check alert_events for this wallet
    const alertEvents = await sql`
      SELECT
        condition_id,
        outcome,
        title,
        fill_price::text,
        fill_timestamp::text,
        position_size::text,
        position_current_value::text,
        threshold_source
      FROM alert_events
      WHERE wallet = ${walletLower}
      ORDER BY fill_timestamp DESC
      LIMIT 20
    `;

    // Check position_sync_overlay
    const overlayRows = await sql`
      SELECT
        condition_id,
        outcome,
        synced_position_size::text,
        synced_current_value::text,
        synced_at::text,
        sync_status
      FROM position_sync_overlay
      WHERE wallet = ${walletLower}
      ORDER BY synced_at DESC
      LIMIT 20
    `;

    const inDatabase = alertEvents.rows.length > 0;

    return NextResponse.json({
      wallet: walletLower,
      inDatabase,
      alertEventsCount: alertEvents.rows.length,
      alertEvents: alertEvents.rows,
      overlayCount: overlayRows.rows.length,
      overlayRows: overlayRows.rows,
      message: inDatabase
        ? `Found ${alertEvents.rows.length} positions for this wallet`
        : 'Wallet not in database. It will be detected when: (1) collect-trades captures a $100+ trade, or (2) scan-positions runs and finds $2,500+ longshot positions.',
      timestamp: new Date().toISOString(),
    }, { headers: NO_CACHE_HEADERS });

  } catch (err) {
    return NextResponse.json(
      { error: 'Query failed', details: String(err) },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}
