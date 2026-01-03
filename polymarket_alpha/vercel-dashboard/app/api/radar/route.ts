// app/api/radar/route.ts
// Long-Shot Radar: Surfaces "insider-looking" trades
// Detects: new wallets making large bets on extreme long-shots

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseIntParam(value: string | null, defaultValue: number, min: number, max: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return clamp(parsed, min, max);
}

function parseFloatParam(value: string | null, defaultValue: number, min: number, max: number): number {
  if (!value) return defaultValue;
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return clamp(parsed, min, max);
}

// Scoring functions (each returns 0-25 points)

// Wallet freshness: newer = higher score
// First seen < 7 days ago = 25pts, < 30 days = 20pts, < 90 days = 10pts, else 0
function scoreWalletFreshness(daysOld: number): number {
  if (daysOld <= 7) return 25;
  if (daysOld <= 14) return 22;
  if (daysOld <= 30) return 18;
  if (daysOld <= 60) return 10;
  if (daysOld <= 90) return 5;
  return 0;
}

// Wallet activity: fewer trades = higher score (more "purpose-built")
// 1-3 trades = 25pts, 4-10 = 18pts, 11-25 = 10pts, 26-50 = 5pts, else 0
function scoreWalletActivity(tradeCount: number): number {
  if (tradeCount <= 3) return 25;
  if (tradeCount <= 10) return 18;
  if (tradeCount <= 25) return 10;
  if (tradeCount <= 50) return 5;
  return 0;
}

// Odds extremity: lower odds = higher score
// <5% = 25pts, <10% = 22pts, <15% = 18pts, <20% = 12pts, <25% = 5pts
function scoreOddsExtremity(fillPrice: number): number {
  if (fillPrice <= 0.05) return 25;
  if (fillPrice <= 0.10) return 22;
  if (fillPrice <= 0.15) return 18;
  if (fillPrice <= 0.20) return 12;
  if (fillPrice <= 0.25) return 5;
  return 0;
}

// Bet size: larger = higher score
// >$10k = 25pts, >$5k = 22pts, >$2k = 18pts, >$1k = 12pts, >$500 = 5pts
function scoreBetSize(valueUsd: number): number {
  if (valueUsd >= 10000) return 25;
  if (valueUsd >= 5000) return 22;
  if (valueUsd >= 2000) return 18;
  if (valueUsd >= 1000) return 12;
  if (valueUsd >= 500) return 5;
  return 0;
}

// Potential payout: higher = higher score
// >$50k = 25pts, >$20k = 22pts, >$10k = 18pts, >$5k = 12pts, >$2k = 5pts
function scorePotentialPayout(payoutUsd: number): number {
  if (payoutUsd >= 50000) return 25;
  if (payoutUsd >= 20000) return 22;
  if (payoutUsd >= 10000) return 18;
  if (payoutUsd >= 5000) return 12;
  if (payoutUsd >= 2000) return 5;
  return 0;
}

interface RadarSignal {
  // Trade identity
  id: string;
  fillTimestamp: string;
  wallet: string;
  traderName: string | null;

  // Market info
  conditionId: string;
  title: string | null;
  outcome: string;
  eventSlug: string | null;
  slug: string | null;

  // Trade details
  fillPrice: number;
  fillPriceFormatted: string;
  fillValueUsd: number;
  fillValueFormatted: string;

  // Position details
  positionSize: number | null;
  positionValueUsd: number | null;
  positionValueFormatted: string;
  potentialPayout: number | null;
  potentialPayoutFormatted: string;

  // Wallet stats (for scoring)
  walletFirstSeen: string;
  walletDaysOld: number;
  walletTradeCount: number;

  // Scoring breakdown
  scores: {
    freshness: number;
    activity: number;
    odds: number;
    betSize: number;
    payout: number;
    total: number;
  };

  // Market status
  marketResolved: boolean;
  winningOutcome: string | null;

  // Whale info
  isWhale: boolean;
  whaleLabel: string | null;
}

interface DbRow {
  id: string;
  fill_timestamp: string;
  wallet: string;
  trader_name: string | null;
  condition_id: string;
  title: string | null;
  outcome: string;
  event_slug: string | null;
  slug: string | null;
  fill_price: string;
  fill_value_usd: string;
  position_size: string | null;
  position_current_value: string | null;
  wallet_first_seen: string;
  wallet_days_old: string;
  wallet_trade_count: string;
  market_resolved: boolean | null;
  winning_outcome: string | null;
  is_whale: boolean;
  whale_label: string | null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Parse parameters
  const maxOdds = parseFloatParam(searchParams.get('maxOdds'), 0.20, 0.01, 0.50);
  const minBet = parseFloatParam(searchParams.get('minBet'), 500, 0, 100000);
  const sinceDays = parseIntParam(searchParams.get('sinceDays'), 7, 1, 90);
  const minScore = parseIntParam(searchParams.get('minScore'), 50, 0, 125);
  const limit = parseIntParam(searchParams.get('limit'), 50, 1, 200);
  const includeResolved = searchParams.get('includeResolved') === 'true';

  try {
    // Main query: find long-shot BUY trades with wallet stats
    // Note: We always fetch all data and filter resolved in JS for simplicity
    const result = await sql<DbRow>`
      WITH wallet_stats AS (
        -- Get first seen date and trade count for each wallet
        SELECT
          wallet,
          MIN(fill_timestamp) as first_seen,
          COUNT(*)::int as trade_count
        FROM alert_events
        GROUP BY wallet
      ),
      radar_candidates AS (
        SELECT
          ae.id,
          ae.fill_timestamp,
          ae.wallet,
          COALESCE(ae.trader_name, ae.trader_pseudonym) as trader_name,
          ae.condition_id,
          ae.title,
          ae.outcome,
          ae.event_slug,
          ae.slug,
          ae.fill_price,
          ae.fill_value_usd,
          ae.position_size,
          ae.position_current_value,
          ws.first_seen as wallet_first_seen,
          EXTRACT(DAY FROM (NOW() - ws.first_seen))::int as wallet_days_old,
          ws.trade_count as wallet_trade_count,
          ms.market_resolved,
          ms.winning_outcome,
          ae.is_whale,
          ae.whale_label
        FROM alert_events ae
        INNER JOIN wallet_stats ws ON ae.wallet = ws.wallet
        LEFT JOIN market_status ms ON ae.condition_id = ms.condition_id
        WHERE ae.side = 'BUY'
          AND ae.fill_price <= ${maxOdds}
          AND ae.fill_value_usd >= ${minBet}
          AND ae.fill_timestamp >= NOW() - INTERVAL '1 day' * ${sinceDays}
      )
      SELECT
        id,
        fill_timestamp::text,
        wallet,
        trader_name,
        condition_id,
        title,
        outcome,
        event_slug,
        slug,
        fill_price::text,
        fill_value_usd::text,
        position_size::text,
        position_current_value::text,
        wallet_first_seen::text,
        wallet_days_old::text,
        wallet_trade_count::text,
        market_resolved,
        winning_outcome,
        is_whale,
        whale_label
      FROM radar_candidates
      ORDER BY fill_timestamp DESC
      LIMIT 500
    `;

    // Process rows and compute scores
    const signals: RadarSignal[] = [];

    for (const row of result.rows) {
      // Filter resolved markets if requested
      const isResolved = row.market_resolved ?? false;
      if (!includeResolved && isResolved) continue;

      const fillPrice = parseFloat(row.fill_price) || 0;
      const fillValueUsd = parseFloat(row.fill_value_usd) || 0;
      const positionSize = row.position_size ? parseFloat(row.position_size) : null;
      const positionValue = row.position_current_value ? parseFloat(row.position_current_value) : null;
      const potentialPayout = positionSize ? positionSize * 1.0 : null; // Each share pays $1
      const walletDaysOld = parseInt(row.wallet_days_old) || 0;
      const walletTradeCount = parseInt(row.wallet_trade_count) || 0;

      // Compute scores
      const freshnessScore = scoreWalletFreshness(walletDaysOld);
      const activityScore = scoreWalletActivity(walletTradeCount);
      const oddsScore = scoreOddsExtremity(fillPrice);
      const betSizeScore = scoreBetSize(fillValueUsd);
      const payoutScore = scorePotentialPayout(potentialPayout || 0);

      const totalScore = freshnessScore + activityScore + oddsScore + betSizeScore + payoutScore;

      // Filter by minimum score
      if (totalScore < minScore) continue;

      signals.push({
        id: row.id,
        fillTimestamp: row.fill_timestamp,
        wallet: row.wallet,
        traderName: row.trader_name,
        conditionId: row.condition_id,
        title: row.title,
        outcome: row.outcome,
        eventSlug: row.event_slug,
        slug: row.slug,
        fillPrice,
        fillPriceFormatted: `${(fillPrice * 100).toFixed(1)}%`,
        fillValueUsd,
        fillValueFormatted: `$${fillValueUsd.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
        positionSize,
        positionValueUsd: positionValue,
        positionValueFormatted: positionValue
          ? `$${positionValue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
          : '-',
        potentialPayout,
        potentialPayoutFormatted: potentialPayout
          ? `$${potentialPayout.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
          : '-',
        walletFirstSeen: row.wallet_first_seen,
        walletDaysOld,
        walletTradeCount,
        scores: {
          freshness: freshnessScore,
          activity: activityScore,
          odds: oddsScore,
          betSize: betSizeScore,
          payout: payoutScore,
          total: totalScore,
        },
        marketResolved: row.market_resolved ?? false,
        winningOutcome: row.winning_outcome,
        isWhale: row.is_whale,
        whaleLabel: row.whale_label,
      });
    }

    // Sort by total score (highest first)
    signals.sort((a, b) => b.scores.total - a.scores.total);

    // Limit results
    const limitedSignals = signals.slice(0, limit);

    return NextResponse.json({
      metadata: {
        maxOdds,
        minBet,
        sinceDays,
        minScore,
        limit,
        includeResolved,
        totalCandidates: result.rows.length,
        filteredCount: signals.length,
        returnedCount: limitedSignals.length,
        scoringModel: {
          freshness: '0-25 pts: newer wallet = higher',
          activity: '0-25 pts: fewer trades = higher',
          odds: '0-25 pts: lower odds = higher',
          betSize: '0-25 pts: larger bet = higher',
          payout: '0-25 pts: higher potential = higher',
          maxScore: 125,
        },
      },
      signals: limitedSignals,
      generatedAt: new Date().toISOString(),
    }, { headers: NO_CACHE_HEADERS });

  } catch (err) {
    console.error('[api/radar] Query failed:', err);
    return NextResponse.json(
      { error: 'Failed to generate radar signals', details: String(err).slice(0, 200) },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}
