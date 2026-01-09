// /app/api/watchlist/route.ts
// API for managing radar watchlist - save/list/delete trades

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

interface WatchlistItem {
  id: number;
  wallet: string;
  conditionId: string;
  outcome: string;
  title: string | null;
  fillPrice: number | null;
  positionCost: number | null;
  potentialPayout: number | null;
  insiderScore: number | null;
  notes: string | null;
  savedAt: string;
  resolvedAt: string | null;
  resolutionOutcome: string | null;
  // Joined from market_status
  marketResolved: boolean;
  winningOutcome: string | null;
  // Live position data from position_sync_overlay
  currentValue: number | null;
  currentPositionSize: number | null;
  syncedAt: string | null;
  isSold: boolean;
  // Wallet stats
  walletFirstSeen: string | null;
  walletPositionCount: number | null;
}

// GET - List all watchlist items
export async function GET() {
  try {
    const result = await sql`
      WITH wallet_stats AS (
        SELECT
          wallet,
          MIN(fill_timestamp) as first_seen
        FROM alert_events
        GROUP BY wallet
      ),
      wallet_positions AS (
        SELECT
          wallet,
          COUNT(*) as position_count
        FROM position_sync_overlay
        WHERE synced_position_size > 0
        GROUP BY wallet
      )
      SELECT
        w.id,
        w.wallet,
        w.condition_id,
        w.outcome,
        w.title,
        w.fill_price,
        w.position_cost,
        w.potential_payout,
        w.insider_score,
        w.notes,
        w.saved_at,
        w.resolved_at,
        w.resolution_outcome,
        COALESCE(ms.market_resolved, FALSE) as market_resolved,
        ms.winning_outcome,
        -- Live position data from position_sync_overlay
        pso.synced_current_value,
        pso.synced_position_size,
        pso.synced_at,
        -- Wallet stats
        ws.first_seen as wallet_first_seen,
        COALESCE(wp.position_count, 0)::int as wallet_position_count
      FROM radar_watchlist w
      LEFT JOIN market_status ms ON w.condition_id = ms.condition_id
      LEFT JOIN position_sync_overlay pso
        ON w.wallet = pso.wallet
        AND w.condition_id = pso.condition_id
        AND w.outcome = pso.outcome
      LEFT JOIN wallet_stats ws ON w.wallet = ws.wallet
      LEFT JOIN wallet_positions wp ON w.wallet = wp.wallet
      ORDER BY w.saved_at DESC
    `;

    const items: WatchlistItem[] = result.rows.map(row => {
      const currentPositionSize = row.synced_position_size ? parseFloat(row.synced_position_size) : null;
      return {
        id: row.id,
        wallet: row.wallet,
        conditionId: row.condition_id,
        outcome: row.outcome,
        title: row.title,
        fillPrice: row.fill_price ? parseFloat(row.fill_price) : null,
        positionCost: row.position_cost ? parseFloat(row.position_cost) : null,
        potentialPayout: row.potential_payout ? parseFloat(row.potential_payout) : null,
        insiderScore: row.insider_score,
        notes: row.notes,
        savedAt: row.saved_at,
        resolvedAt: row.resolved_at,
        resolutionOutcome: row.resolution_outcome,
        marketResolved: row.market_resolved ?? false,
        winningOutcome: row.winning_outcome,
        // Live position data
        currentValue: row.synced_current_value ? parseFloat(row.synced_current_value) : null,
        currentPositionSize,
        syncedAt: row.synced_at || null,
        isSold: currentPositionSize !== null && currentPositionSize === 0,
        // Wallet stats
        walletFirstSeen: row.wallet_first_seen || null,
        walletPositionCount: row.wallet_position_count ?? null,
      };
    });

    return NextResponse.json({
      items,
      count: items.length,
    }, { headers: NO_CACHE_HEADERS });

  } catch (err) {
    console.error('[api/watchlist] GET failed:', err);
    return NextResponse.json(
      { error: 'Failed to fetch watchlist', details: String(err).slice(0, 200) },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}

// POST - Add item to watchlist
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      wallet,
      conditionId,
      outcome,
      title,
      fillPrice,
      positionCost,
      potentialPayout,
      insiderScore,
      notes,
    } = body;

    if (!wallet || !conditionId || !outcome) {
      return NextResponse.json(
        { error: 'Missing required fields: wallet, conditionId, outcome' },
        { status: 400, headers: NO_CACHE_HEADERS }
      );
    }

    // Upsert - if already exists, update the notes and score
    const result = await sql`
      INSERT INTO radar_watchlist (
        wallet, condition_id, outcome, title, fill_price,
        position_cost, potential_payout, insider_score, notes
      ) VALUES (
        ${wallet.toLowerCase()}, ${conditionId}, ${outcome}, ${title || null},
        ${fillPrice || null}, ${positionCost || null}, ${potentialPayout || null},
        ${insiderScore || null}, ${notes || null}
      )
      ON CONFLICT (wallet, condition_id, outcome)
      DO UPDATE SET
        notes = COALESCE(EXCLUDED.notes, radar_watchlist.notes),
        insider_score = COALESCE(EXCLUDED.insider_score, radar_watchlist.insider_score),
        position_cost = COALESCE(EXCLUDED.position_cost, radar_watchlist.position_cost),
        potential_payout = COALESCE(EXCLUDED.potential_payout, radar_watchlist.potential_payout)
      RETURNING id
    `;

    return NextResponse.json({
      success: true,
      id: result.rows[0]?.id,
      message: 'Added to watchlist',
    }, { headers: NO_CACHE_HEADERS });

  } catch (err) {
    console.error('[api/watchlist] POST failed:', err);
    return NextResponse.json(
      { error: 'Failed to save to watchlist', details: String(err).slice(0, 200) },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}

// DELETE - Remove item from watchlist
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const wallet = searchParams.get('wallet');
    const conditionId = searchParams.get('conditionId');
    const outcome = searchParams.get('outcome');

    if (id) {
      // Delete by ID
      await sql`DELETE FROM radar_watchlist WHERE id = ${parseInt(id)}`;
    } else if (wallet && conditionId && outcome) {
      // Delete by composite key
      await sql`
        DELETE FROM radar_watchlist
        WHERE wallet = ${wallet.toLowerCase()}
          AND condition_id = ${conditionId}
          AND outcome = ${outcome}
      `;
    } else {
      return NextResponse.json(
        { error: 'Missing id or (wallet, conditionId, outcome)' },
        { status: 400, headers: NO_CACHE_HEADERS }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Removed from watchlist',
    }, { headers: NO_CACHE_HEADERS });

  } catch (err) {
    console.error('[api/watchlist] DELETE failed:', err);
    return NextResponse.json(
      { error: 'Failed to remove from watchlist', details: String(err).slice(0, 200) },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}
