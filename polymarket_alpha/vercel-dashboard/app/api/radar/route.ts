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
// Based on actual first trade date from Polymarket API
function scoreWalletFreshness(daysOld: number): number {
  if (daysOld <= 7) return 25;
  if (daysOld <= 14) return 22;
  if (daysOld <= 30) return 18;
  if (daysOld <= 60) return 10;
  if (daysOld <= 90) return 5;
  return 0;
}

// Wallet activity: fewer trades = higher score (more "purpose-built")
// Based on actual trade count from Polymarket API
function scoreWalletActivity(tradeCount: number): number {
  if (tradeCount <= 3) return 25;
  if (tradeCount <= 10) return 18;
  if (tradeCount <= 25) return 10;
  if (tradeCount <= 50) return 5;
  return 0;
}

// Fetch actual wallet stats from Polymarket API
// Returns { tradeCount, firstTradeDate, daysOld }
async function fetchWalletStats(wallet: string): Promise<{
  tradeCount: number;
  firstTradeTimestamp: number | null;
  daysOld: number;
}> {
  try {
    // Fetch trades for this wallet (up to 1000)
    const res = await fetch(
      `https://data-api.polymarket.com/trades?user=${wallet}&limit=1000`,
      { cache: 'no-store' }
    );

    if (!res.ok) {
      console.warn(`[fetchWalletStats] Failed to fetch for ${wallet}: ${res.status}`);
      return { tradeCount: 0, firstTradeTimestamp: null, daysOld: 999 };
    }

    const trades = await res.json();

    if (!Array.isArray(trades) || trades.length === 0) {
      return { tradeCount: 0, firstTradeTimestamp: null, daysOld: 999 };
    }

    const tradeCount = trades.length;

    // Find oldest trade timestamp
    const timestamps = trades.map((t: { timestamp: number }) => t.timestamp);
    const oldestTimestamp = Math.min(...timestamps);

    // Calculate days old
    const now = Date.now() / 1000;
    const daysOld = Math.floor((now - oldestTimestamp) / (60 * 60 * 24));

    return { tradeCount, firstTradeTimestamp: oldestTimestamp, daysOld };
  } catch (err) {
    console.error(`[fetchWalletStats] Error for ${wallet}:`, err);
    return { tradeCount: 0, firstTradeTimestamp: null, daysOld: 999 };
  }
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

// Sports detection keywords
const SPORTS_KEYWORDS = [
  // Leagues
  'nfl', 'nba', 'mlb', 'nhl', 'mls', 'ufc', 'pga', 'atp', 'wta', 'fifa', 'ncaa', 'wnba',
  // Sports terms
  'super bowl', 'world series', 'stanley cup', 'playoffs', 'championship', 'finals',
  'game ', 'match ', 'vs ', ' vs.', 'versus',
  // Team indicators
  'win ', 'wins ', 'beat ', 'defeat ',
  // Common sports
  'football', 'basketball', 'baseball', 'hockey', 'soccer', 'tennis', 'golf', 'boxing', 'mma',
  // Specific events
  'bowl game', 'march madness', 'world cup', 'olympics', 'grand slam',
];

function isSportsMarket(title: string | null, slug: string | null, eventSlug: string | null): boolean {
  const text = `${title || ''} ${slug || ''} ${eventSlug || ''}`.toLowerCase();
  return SPORTS_KEYWORDS.some(keyword => text.includes(keyword));
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

  // Position details (from synced data or snapshot)
  positionSize: number | null;
  positionCost: number | null;  // position_size × fill_price (actual cost basis)
  positionCostFormatted: string;
  positionValueUsd: number | null;  // current value
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

  // Synced data (from position_sync_overlay)
  hasSyncedData: boolean;
  syncedAt: string | null;

  // Hedge detection
  isHedger: boolean;  // true if wallet has positions on multiple outcomes of this market

  // Sports detection
  isSports: boolean;  // true if market appears to be sports-related
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
  // Synced position data (matches main report)
  synced_position_size: string | null;
  synced_avg_price: string | null;
  synced_current_value: string | null;
  synced_payout_if_wins: string | null;
  last_known_position_size: string | null;
  last_known_avg_price: string | null;
  synced_at: string | null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Parse parameters (defaults match main report)
  const maxOdds = parseFloatParam(searchParams.get('maxOdds'), 0.25, 0.01, 0.50);
  const minPosition = parseFloatParam(searchParams.get('minPosition'), 2500, 0, 100000);
  const sinceDays = parseIntParam(searchParams.get('sinceDays'), 7, 1, 90);
  const minScore = parseIntParam(searchParams.get('minScore'), 50, 0, 125);
  const limit = parseIntParam(searchParams.get('limit'), 50, 1, 200);
  const includeResolved = searchParams.get('includeResolved') === 'true';
  const sortBy = searchParams.get('sortBy') === 'score' ? 'score' : 'time';  // default: time
  const hideSports = searchParams.get('hideSports') === 'true';

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
        -- Deduplicate by wallet + condition_id + outcome, keeping the most recent trade
        SELECT DISTINCT ON (ae.wallet, ae.condition_id, ae.outcome)
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
          ae.whale_label,
          -- Synced position data (from position_sync_overlay, matches main report)
          pso.synced_position_size,
          pso.synced_avg_price,
          pso.synced_current_value,
          pso.synced_payout_if_wins,
          pso.last_known_position_size,
          pso.last_known_avg_price,
          pso.synced_at
        FROM alert_events ae
        INNER JOIN wallet_stats ws ON ae.wallet = ws.wallet
        LEFT JOIN market_status ms ON ae.condition_id = ms.condition_id
        LEFT JOIN position_sync_overlay pso
          ON ae.wallet = pso.wallet
          AND ae.condition_id = pso.condition_id
          AND ae.outcome = pso.outcome
        WHERE ae.side = 'BUY'
          AND ae.fill_price <= ${maxOdds}
          AND COALESCE(pso.synced_current_value, ae.position_current_value) >= ${minPosition}
          AND ae.fill_timestamp >= NOW() - INTERVAL '1 day' * ${sinceDays}
        ORDER BY ae.wallet, ae.condition_id, ae.outcome, ae.fill_timestamp DESC
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
        whale_label,
        synced_position_size::text,
        synced_avg_price::text,
        synced_current_value::text,
        synced_payout_if_wins::text,
        last_known_position_size::text,
        last_known_avg_price::text,
        synced_at::text
      FROM radar_candidates
      ORDER BY fill_timestamp DESC
      LIMIT 500
    `;

    // Filter rows first (before API calls)
    const filteredRows = result.rows.filter(row => {
      const isResolved = row.market_resolved ?? false;
      return includeResolved || !isResolved;
    });

    // ========================================================================
    // HEDGE DETECTION: Find wallets with positions on multiple outcomes of same market
    // ========================================================================
    const hedgeMap = new Map<string, Set<string>>();  // key: wallet|condition_id → Set of outcomes
    for (const row of filteredRows) {
      const key = `${row.wallet}|${row.condition_id}`;
      if (!hedgeMap.has(key)) {
        hedgeMap.set(key, new Set());
      }
      hedgeMap.get(key)!.add(row.outcome);
    }
    // A wallet is hedging if they have 2+ outcomes on the same market
    const hedgerKeys = new Set<string>();
    hedgeMap.forEach((outcomes, key) => {
      if (outcomes.size > 1) {
        hedgerKeys.add(key);
      }
    });

    // Get unique wallets to fetch stats for
    const uniqueWallets = Array.from(new Set(filteredRows.map(r => r.wallet)));
    console.log(`[radar] Fetching stats for ${uniqueWallets.length} unique wallets`);

    // Fetch real wallet stats from Polymarket API (in parallel, max 10 concurrent)
    const walletStatsMap = new Map<string, { tradeCount: number; daysOld: number }>();

    // Process in batches of 10 to avoid rate limiting
    const BATCH_SIZE = 10;
    for (let i = 0; i < uniqueWallets.length; i += BATCH_SIZE) {
      const batch = uniqueWallets.slice(i, i + BATCH_SIZE);
      const statsPromises = batch.map(async (wallet) => {
        const stats = await fetchWalletStats(wallet);
        return { wallet, stats };
      });

      const batchResults = await Promise.all(statsPromises);
      for (const { wallet, stats } of batchResults) {
        walletStatsMap.set(wallet, { tradeCount: stats.tradeCount, daysOld: stats.daysOld });
      }
    }

    // Process rows and compute scores using real wallet stats
    const signals: RadarSignal[] = [];

    for (const row of filteredRows) {
      const fillPrice = parseFloat(row.fill_price) || 0;

      // ========================================================================
      // EFFECTIVE VALUES: Prefer synced → lastKnown → alert_events fallback
      // This matches main report's approach for consistency
      // ========================================================================
      const syncedPositionSize = row.synced_position_size ? parseFloat(row.synced_position_size) : null;
      const syncedAvgPrice = row.synced_avg_price ? parseFloat(row.synced_avg_price) : null;
      const syncedCurrentValue = row.synced_current_value ? parseFloat(row.synced_current_value) : null;
      const syncedPayoutIfWins = row.synced_payout_if_wins ? parseFloat(row.synced_payout_if_wins) : null;

      const lastKnownPositionSize = row.last_known_position_size ? parseFloat(row.last_known_position_size) : null;
      const lastKnownAvgPrice = row.last_known_avg_price ? parseFloat(row.last_known_avg_price) : null;

      const rawPositionSize = row.position_size ? parseFloat(row.position_size) : null;
      const rawPositionValue = row.position_current_value ? parseFloat(row.position_current_value) : null;

      // Effective values (synced → lastKnown → raw)
      const positionSize = syncedPositionSize ?? lastKnownPositionSize ?? rawPositionSize;
      const positionAvgPrice = syncedAvgPrice ?? lastKnownAvgPrice ?? fillPrice;
      const positionValue = syncedCurrentValue ?? rawPositionValue;
      const potentialPayout = syncedPayoutIfWins ?? positionSize;

      // Position cost = shares × avg price (matches main report)
      const positionCost = (positionSize !== null && positionAvgPrice !== null)
        ? positionSize * positionAvgPrice
        : null;

      // Has synced data indicator
      const hasSyncedData = syncedPositionSize !== null;

      // Get real wallet stats from Polymarket API
      const walletStats = walletStatsMap.get(row.wallet) || { tradeCount: 999, daysOld: 999 };
      const walletDaysOld = walletStats.daysOld;
      const walletTradeCount = walletStats.tradeCount;

      // Compute scores using REAL data
      const freshnessScore = scoreWalletFreshness(walletDaysOld);
      const activityScore = scoreWalletActivity(walletTradeCount);
      const oddsScore = scoreOddsExtremity(fillPrice);
      // Use position cost (actual risk) for bet size scoring, not individual trade value
      const betSizeScore = scoreBetSize(positionCost || 0);
      const payoutScore = scorePotentialPayout(potentialPayout || 0);

      const totalScore = freshnessScore + activityScore + oddsScore + betSizeScore + payoutScore;

      // Filter by minimum score
      if (totalScore < minScore) continue;

      // Check if this wallet is hedging on this market
      const hedgeKey = `${row.wallet}|${row.condition_id}`;
      const isHedger = hedgerKeys.has(hedgeKey);

      // Check if this is a sports market
      const isSports = isSportsMarket(row.title, row.slug, row.event_slug);

      // Filter out sports if requested
      if (hideSports && isSports) continue;

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
        positionSize,
        positionCost,
        positionCostFormatted: positionCost
          ? `$${positionCost.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
          : '-',
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
        hasSyncedData,
        syncedAt: row.synced_at,
        isHedger,
        isSports,
      });
    }

    // Sort by selected criteria
    if (sortBy === 'score') {
      signals.sort((a, b) => b.scores.total - a.scores.total);
    } else {
      // Sort by time (newest first)
      signals.sort((a, b) => new Date(b.fillTimestamp).getTime() - new Date(a.fillTimestamp).getTime());
    }

    // Limit results
    const limitedSignals = signals.slice(0, limit);

    return NextResponse.json({
      metadata: {
        maxOdds,
        minPosition,
        sinceDays,
        minScore,
        limit,
        includeResolved,
        sortBy,
        hideSports,
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
