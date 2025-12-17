// /app/api/whale-trades/route.ts
// Phase 1: Query whale trades from alert_events only

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const dynamic = 'force-dynamic';

function formatMoney(value: number | null): string {
  if (value === null || value === undefined) return 'N/A';
  if (Math.abs(value) >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`;
  }
  return `$${value.toFixed(0)}`;
}

function formatOdds(price: number | null): string {
  if (price === null || price === undefined) return 'N/A';
  return `${(price * 100).toFixed(1)}%`;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const tier = searchParams.get('tier');
    const category = searchParams.get('category');
    const limit = Math.min(Number(searchParams.get('limit')) || 100, 500);

    // Query whale trades from alert_events
    const result = await sql`
      SELECT *
      FROM alert_events
      WHERE is_whale = TRUE
      ORDER BY fill_timestamp DESC
      LIMIT ${limit}
    `;

    // Apply optional filters in memory (tier and category)
    let filteredRows = result.rows;
    if (tier) {
      filteredRows = filteredRows.filter((r) => r.whale_tier === tier);
    }
    if (category) {
      filteredRows = filteredRows.filter((r) => r.whale_category === category);
    }

    // Format trades
    const trades = filteredRows.map((row) => ({
      id: row.id,
      wallet: row.wallet,
      traderName: row.trader_name || row.trader_pseudonym || 'Anonymous',
      tier: row.whale_tier,
      category: row.whale_category,
      whaleLabel: row.whale_label,
      // Market info
      conditionId: row.condition_id,
      eventSlug: row.event_slug,
      title: row.title || 'Unknown Market',
      outcome: row.outcome,
      // Trade/fill data
      fillTimestamp: row.fill_timestamp,
      fillPrice: Number(row.fill_price),
      fillPriceFormatted: formatOdds(Number(row.fill_price)),
      fillSize: Number(row.fill_size),
      fillValueUsd: Number(row.fill_value_usd),
      fillValueFormatted: formatMoney(Number(row.fill_value_usd)),
      // Position snapshot
      positionSize: row.position_size !== null ? Number(row.position_size) : null,
      positionAvgPrice: row.position_avg_price !== null ? Number(row.position_avg_price) : null,
      positionAvgPriceFormatted: formatOdds(row.position_avg_price !== null ? Number(row.position_avg_price) : null),
      positionCurrentValue: row.position_current_value !== null ? Number(row.position_current_value) : null,
      positionCurrentValueFormatted: formatMoney(row.position_current_value !== null ? Number(row.position_current_value) : null),
      positionInitialValue: row.position_initial_value !== null ? Number(row.position_initial_value) : null,
      positionInitialValueFormatted: formatMoney(row.position_initial_value !== null ? Number(row.position_initial_value) : null),
      positionCashPnl: row.position_cash_pnl !== null ? Number(row.position_cash_pnl) : null,
      positionCashPnlFormatted: formatMoney(row.position_cash_pnl !== null ? Number(row.position_cash_pnl) : null),
      positionSnapshotAt: row.position_snapshot_at,
    }));

    // Get stats from alert_events
    const statsResult = await sql`
      SELECT
        COUNT(*) as total_trades,
        COUNT(DISTINCT wallet) as unique_whales,
        SUM(fill_value_usd) as total_value,
        COUNT(CASE WHEN whale_tier = 'whale' THEN 1 END) as whale_tier_count,
        COUNT(CASE WHEN whale_tier = 'shark' THEN 1 END) as shark_tier_count,
        COUNT(CASE WHEN whale_tier = 'dolphin' THEN 1 END) as dolphin_tier_count
      FROM alert_events
      WHERE is_whale = TRUE
    `;
    const stats = statsResult.rows[0];

    // Get watchlist stats
    let watchlistStats = {
      total: 0,
      withWallet: 0,
      pendingWallet: 0,
      whales: 0,
      sharks: 0,
      dolphins: 0,
    };

    try {
      const watchlistResult = await sql`
        SELECT
          COUNT(*) as total_watchlist,
          COUNT(wallet) as with_wallet,
          COUNT(*) - COUNT(wallet) as pending_wallet,
          COUNT(CASE WHEN tier = 'whale' THEN 1 END) as whales,
          COUNT(CASE WHEN tier = 'shark' THEN 1 END) as sharks,
          COUNT(CASE WHEN tier = 'dolphin' THEN 1 END) as dolphins
        FROM whale_watchlist
      `;
      const wlRow = watchlistResult.rows[0];
      watchlistStats = {
        total: Number(wlRow.total_watchlist),
        withWallet: Number(wlRow.with_wallet),
        pendingWallet: Number(wlRow.pending_wallet),
        whales: Number(wlRow.whales),
        sharks: Number(wlRow.sharks),
        dolphins: Number(wlRow.dolphins),
      };
    } catch {
      // whale_watchlist table may not exist
    }

    return NextResponse.json({
      trades,
      stats: {
        totalTrades: Number(stats.total_trades),
        uniqueWhales: Number(stats.unique_whales),
        totalValue: Number(stats.total_value || 0),
        totalValueFormatted: formatMoney(Number(stats.total_value || 0)),
        whaleTierCount: Number(stats.whale_tier_count),
        sharkTierCount: Number(stats.shark_tier_count),
        dolphinTierCount: Number(stats.dolphin_tier_count),
      },
      watchlist: watchlistStats,
      filters: { tier, category },
      timestamp: new Date().toISOString(),
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (err) {
    console.error('[whale-trades] Error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch whale trades', details: String(err) },
      { status: 500 }
    );
  }
}
