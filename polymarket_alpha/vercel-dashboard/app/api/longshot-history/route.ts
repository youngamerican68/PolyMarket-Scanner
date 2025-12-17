// /app/api/longshot-history/route.ts
// Phase 1: Query all longshot alerts from alert_events

import { NextRequest, NextResponse } from 'next/server';
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

function formatShares(shares: number | null): string {
  if (shares === null || shares === undefined) return 'N/A';
  if (Math.abs(shares) >= 1000) {
    return `${(shares / 1000).toFixed(1)}K`;
  }
  return shares.toFixed(0);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get('limit')) || 500, 500);
    const offset = Number(searchParams.get('offset')) || 0;

    // Query all alerts from alert_events with pagination
    const result = await sql`
      SELECT *
      FROM alert_events
      WHERE qualifies_longshot = TRUE
      ORDER BY fill_timestamp DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `;

    console.log('[longshot-history] Query returned', result.rows.length, 'rows');

    // Format alerts for response
    const alerts = result.rows.map((row) => ({
      id: row.id,
      wallet: row.wallet,
      traderName: row.trader_name || row.trader_pseudonym || 'Anonymous',
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
      // Position snapshot (from ingestion time)
      positionSize: row.position_size !== null ? Number(row.position_size) : null,
      positionSizeFormatted: formatShares(row.position_size !== null ? Number(row.position_size) : null),
      positionAvgPrice: row.position_avg_price !== null ? Number(row.position_avg_price) : null,
      positionAvgPriceFormatted: formatOdds(row.position_avg_price !== null ? Number(row.position_avg_price) : null),
      positionCurrentValue: row.position_current_value !== null ? Number(row.position_current_value) : null,
      positionCurrentValueFormatted: formatMoney(row.position_current_value !== null ? Number(row.position_current_value) : null),
      positionInitialValue: row.position_initial_value !== null ? Number(row.position_initial_value) : null,
      positionInitialValueFormatted: formatMoney(row.position_initial_value !== null ? Number(row.position_initial_value) : null),
      positionCashPnl: row.position_cash_pnl !== null ? Number(row.position_cash_pnl) : null,
      positionCashPnlFormatted: formatMoney(row.position_cash_pnl !== null ? Number(row.position_cash_pnl) : null),
      positionSnapshotAt: row.position_snapshot_at,
      // Potential win: profit if position resolves correctly
      potentialWin: row.position_size !== null && row.position_avg_price !== null
        ? Number(row.position_size) * (1 - Number(row.position_avg_price))
        : null,
      potentialWinFormatted: row.position_size !== null && row.position_avg_price !== null
        ? formatMoney(Number(row.position_size) * (1 - Number(row.position_avg_price)))
        : 'N/A',
      // Threshold info
      thresholdValueUsed: row.threshold_value_used !== null ? Number(row.threshold_value_used) : null,
      thresholdSource: row.threshold_source,
      // Whale metadata
      isWhale: row.is_whale,
      whaleLabel: row.whale_label,
      whaleTier: row.whale_tier,
      whaleCategory: row.whale_category,
      // Created timestamp
      createdAt: row.created_at,
    }));

    // Get summary stats
    const statsResult = await sql`
      SELECT
        COUNT(*) as total_alerts,
        COUNT(DISTINCT wallet) as unique_wallets,
        SUM(fill_value_usd) as total_value,
        COUNT(CASE WHEN is_whale = TRUE THEN 1 END) as whale_alerts
      FROM alert_events
      WHERE qualifies_longshot = TRUE
    `;

    const stats = statsResult.rows[0];

    console.log('[longshot-history] Returning', alerts.length, 'alerts, stats:', stats);

    return NextResponse.json({
      alerts,
      stats: {
        totalAlerts: Number(stats.total_alerts),
        uniqueWallets: Number(stats.unique_wallets),
        totalValue: Number(stats.total_value || 0),
        totalValueFormatted: formatMoney(Number(stats.total_value || 0)),
        whaleAlerts: Number(stats.whale_alerts),
      },
      pagination: {
        limit,
        offset,
        hasMore: alerts.length === limit,
      },
      timestamp: new Date().toISOString(),
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (err) {
    console.error('[longshot-history] Error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch history', details: String(err) },
      { status: 500 }
    );
  }
}
