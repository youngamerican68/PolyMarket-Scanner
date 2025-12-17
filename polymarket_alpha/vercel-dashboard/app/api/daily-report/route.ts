// /app/api/daily-report/route.ts
// Phase 1: Query alert_events only, no external API calls

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const dynamic = 'force-dynamic';

interface AlertEvent {
  id: string;
  created_at: string;
  trade_dedupe_id: string;
  transaction_hash: string | null;
  fill_timestamp: string;
  side: string;
  fill_price: number;
  fill_size: number;
  fill_value_usd: number;
  wallet: string;
  trader_name: string | null;
  trader_pseudonym: string | null;
  asset: string;
  condition_id: string;
  outcome: string;
  outcome_index: number;
  title: string | null;
  slug: string | null;
  event_slug: string | null;
  position_size: number | null;
  position_avg_price: number | null;
  position_cur_price: number | null;
  position_initial_value: number | null;
  position_current_value: number | null;
  position_cash_pnl: number | null;
  position_snapshot_at: string | null;
  longshot_threshold: number;
  min_position_threshold: number;
  qualifies_longshot: boolean;
  qualifies_min_position: boolean;
  threshold_value_used: number | null;
  threshold_source: string | null;
  is_whale: boolean;
  whale_label: string | null;
  whale_tier: string | null;
  whale_category: string | null;
}

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

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const hoursParam = searchParams.get('hours');
    const hours = hoursParam ? parseInt(hoursParam) : 24;

    // Query alert_events for last N hours
    const result = await sql`
      SELECT *
      FROM alert_events
      WHERE fill_timestamp >= NOW() - INTERVAL '1 hour' * ${hours}
      ORDER BY fill_timestamp DESC
      LIMIT 500
    `;

    const alerts: AlertEvent[] = result.rows.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      trade_dedupe_id: row.trade_dedupe_id,
      transaction_hash: row.transaction_hash,
      fill_timestamp: row.fill_timestamp,
      side: row.side,
      fill_price: Number(row.fill_price),
      fill_size: Number(row.fill_size),
      fill_value_usd: Number(row.fill_value_usd),
      wallet: row.wallet,
      trader_name: row.trader_name,
      trader_pseudonym: row.trader_pseudonym,
      asset: row.asset,
      condition_id: row.condition_id,
      outcome: row.outcome,
      outcome_index: row.outcome_index,
      title: row.title,
      slug: row.slug,
      event_slug: row.event_slug,
      position_size: row.position_size !== null ? Number(row.position_size) : null,
      position_avg_price: row.position_avg_price !== null ? Number(row.position_avg_price) : null,
      position_cur_price: row.position_cur_price !== null ? Number(row.position_cur_price) : null,
      position_initial_value: row.position_initial_value !== null ? Number(row.position_initial_value) : null,
      position_current_value: row.position_current_value !== null ? Number(row.position_current_value) : null,
      position_cash_pnl: row.position_cash_pnl !== null ? Number(row.position_cash_pnl) : null,
      position_snapshot_at: row.position_snapshot_at,
      longshot_threshold: Number(row.longshot_threshold),
      min_position_threshold: Number(row.min_position_threshold),
      qualifies_longshot: row.qualifies_longshot,
      qualifies_min_position: row.qualifies_min_position,
      threshold_value_used: row.threshold_value_used !== null ? Number(row.threshold_value_used) : null,
      threshold_source: row.threshold_source,
      is_whale: row.is_whale,
      whale_label: row.whale_label,
      whale_tier: row.whale_tier,
      whale_category: row.whale_category,
    }));

    // Calculate summary stats
    const uniqueWallets = new Set(alerts.map((a) => a.wallet));
    const totalValue = alerts.reduce((sum, a) => sum + a.fill_value_usd, 0);
    const totalPotential = alerts.reduce((sum, a) => sum + a.fill_size, 0);

    // Get time range from data
    const timestamps = alerts.map((a) => new Date(a.fill_timestamp).getTime());
    const earliestMs = timestamps.length > 0 ? Math.min(...timestamps) : null;
    const latestMs = timestamps.length > 0 ? Math.max(...timestamps) : null;
    const hoursOfData = earliestMs && latestMs
      ? Math.round((latestMs - earliestMs) / (1000 * 60 * 60) * 10) / 10
      : 0;

    // Format alerts for response
    const formattedAlerts = alerts.map((a) => ({
      id: a.id,
      fillTimestamp: a.fill_timestamp,
      wallet: a.wallet,
      traderName: a.trader_name || a.trader_pseudonym || 'Anonymous',
      title: a.title || 'Unknown Market',
      outcome: a.outcome,
      eventSlug: a.event_slug,
      // Fill data (this trade)
      fillPrice: a.fill_price,
      fillPriceFormatted: formatOdds(a.fill_price),
      fillSize: a.fill_size,
      fillValueUsd: a.fill_value_usd,
      fillValueFormatted: formatMoney(a.fill_value_usd),
      // Position snapshot (from ingestion time)
      positionSize: a.position_size,
      positionSizeFormatted: a.position_size !== null ? formatMoney(a.position_size) : 'N/A',
      positionAvgPrice: a.position_avg_price,
      positionAvgPriceFormatted: formatOdds(a.position_avg_price),
      positionCurrentValue: a.position_current_value,
      positionCurrentValueFormatted: formatMoney(a.position_current_value),
      positionInitialValue: a.position_initial_value,
      positionInitialValueFormatted: formatMoney(a.position_initial_value),
      positionCashPnl: a.position_cash_pnl,
      positionCashPnlFormatted: formatMoney(a.position_cash_pnl),
      positionSnapshotAt: a.position_snapshot_at,
      // Threshold info
      thresholdValueUsed: a.threshold_value_used,
      thresholdSource: a.threshold_source,
      // Whale metadata
      isWhale: a.is_whale,
      whaleLabel: a.whale_label,
      whaleTier: a.whale_tier,
      whaleCategory: a.whale_category,
    }));

    // Separate whale alerts from regular alerts
    const whaleAlerts = formattedAlerts.filter((a) => a.isWhale);
    const regularAlerts = formattedAlerts.filter((a) => !a.isWhale);

    // Get count of whale alerts
    const whaleCount = whaleAlerts.length;

    return NextResponse.json({
      summary: {
        totalAlerts: alerts.length,
        whaleAlerts: whaleCount,
        uniqueWallets: uniqueWallets.size,
        totalValue,
        totalValueFormatted: formatMoney(totalValue),
        totalPotential,
        totalPotentialFormatted: formatMoney(totalPotential),
        hoursOfData,
        dataStartTime: earliestMs ? new Date(earliestMs).toISOString() : null,
        dataEndTime: latestMs ? new Date(latestMs).toISOString() : null,
      },
      // Top longshots by position value (descending)
      topLongshots: regularAlerts
        .sort((a, b) => (b.positionCurrentValue ?? 0) - (a.positionCurrentValue ?? 0))
        .slice(0, 50),
      // Whale trades
      whaleTrades: whaleAlerts
        .sort((a, b) => new Date(b.fillTimestamp).getTime() - new Date(a.fillTimestamp).getTime())
        .slice(0, 50),
      // All alerts for detailed view
      allAlerts: formattedAlerts,
    });
  } catch (err) {
    console.error('[daily-report] Error:', err);
    return NextResponse.json(
      { error: 'Failed to generate daily report', details: String(err) },
      { status: 500 }
    );
  }
}
