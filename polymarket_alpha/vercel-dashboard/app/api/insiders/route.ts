// /app/api/insiders/route.ts
// Query API for the /insiders dashboard page.
// Returns confirmed insider candidates with market status joined from market_status.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

interface Row {
  alert_event_id: string;
  wallet: string;
  condition_id: string;
  outcome: string;
  fill_price: string;
  fill_value_usd: string;
  fill_timestamp: string;
  title: string | null;
  event_slug: string | null;
  slug: string | null;
  polymarket_lifetime_trades: number | null;
  polymarket_first_trade_at: string | null;
  verified_at: string | null;
  market_resolved: boolean | null;
  winning_outcome: string | null;
  verification_status: string;
  lifetime_trades_at_fill: number | null;
  history_truncated: boolean | null;
  corroborated: boolean | null;
  corroborating_title: string | null;
  corroborating_avg_price: string | null;
  corroborating_value_usd: string | null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const includeResolved = searchParams.get('includeResolved') === 'true';
  const sinceDays = Math.max(1, Math.min(90, parseInt(searchParams.get('sinceDays') || '30', 10)));
  const limit = Math.max(1, Math.min(500, parseInt(searchParams.get('limit') || '100', 10)));

  try {
    const { rows } = await sql<Row>`
      SELECT
        ic.alert_event_id,
        ic.wallet,
        ic.condition_id,
        ic.outcome,
        ic.fill_price::text,
        ic.fill_value_usd::text,
        ic.fill_timestamp::text,
        ic.title,
        ic.event_slug,
        ic.slug,
        ic.polymarket_lifetime_trades,
        ic.polymarket_first_trade_at::text,
        ic.verified_at::text,
        ic.verification_status,
        ic.lifetime_trades_at_fill,
        ic.history_truncated,
        ic.corroborated,
        ic.corroborating_title,
        ic.corroborating_avg_price::text,
        ic.corroborating_value_usd::text,
        ms.market_resolved,
        ms.winning_outcome
      FROM insider_candidates ic
      LEFT JOIN market_status ms ON ms.condition_id = ic.condition_id
      WHERE ic.verification_status IN ('confirmed', 'watch')
        AND ic.fill_timestamp >= NOW() - (INTERVAL '1 day' * ${sinceDays})
        AND (${includeResolved}::boolean OR COALESCE(ms.market_resolved, FALSE) = FALSE)
      ORDER BY
        COALESCE(ms.market_resolved, FALSE) ASC,           -- open markets first
        (ic.verification_status = 'confirmed') DESC,        -- confirmed above watch
        COALESCE(ic.corroborated, FALSE) DESC,             -- corroborated above plain
        ic.fill_timestamp DESC
      LIMIT ${limit}
    `;

    const signals = rows.map(r => {
      const fillPrice = parseFloat(r.fill_price);
      const fillValueUsd = parseFloat(r.fill_value_usd);
      const shares = fillPrice > 0 ? fillValueUsd / fillPrice : 0;
      const potentialPayout = shares * 1; // each winning token pays $1
      const won = r.market_resolved && r.winning_outcome
        ? r.outcome.toLowerCase() === r.winning_outcome.toLowerCase()
        : null;

      return {
        alertEventId: r.alert_event_id,
        wallet: r.wallet,
        conditionId: r.condition_id,
        outcome: r.outcome,
        title: r.title,
        eventSlug: r.event_slug,
        slug: r.slug,
        fillPrice,
        fillPriceFormatted: `${(fillPrice * 100).toFixed(1)}%`,
        fillValueUsd,
        fillValueFormatted: `$${Math.round(fillValueUsd).toLocaleString()}`,
        fillTimestamp: r.fill_timestamp,
        tier: r.verification_status === 'confirmed' ? 'confirmed' : 'watch',
        lifetimeTradesAtFill: r.lifetime_trades_at_fill,
        historyTruncated: Boolean(r.history_truncated),
        corroborated: Boolean(r.corroborated),
        corroboratingTitle: r.corroborating_title,
        corroboratingAvgPriceFormatted: r.corroborating_avg_price
          ? `${(parseFloat(r.corroborating_avg_price) * 100).toFixed(1)}%`
          : null,
        corroboratingValueFormatted: r.corroborating_value_usd
          ? `$${Math.round(parseFloat(r.corroborating_value_usd)).toLocaleString()}`
          : null,
        polymarketLifetimeTrades: r.polymarket_lifetime_trades,
        polymarketFirstTradeAt: r.polymarket_first_trade_at,
        verifiedAt: r.verified_at,
        potentialPayoutUsd: potentialPayout,
        potentialPayoutFormatted: `$${Math.round(potentialPayout).toLocaleString()}`,
        marketResolved: r.market_resolved ?? false,
        winningOutcome: r.winning_outcome,
        won,
      };
    });

    return NextResponse.json(
      { signals, count: signals.length, generatedAt: new Date().toISOString() },
      { headers: NO_CACHE_HEADERS }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: msg, signals: [], count: 0 },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}
