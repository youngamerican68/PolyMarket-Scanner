// app/api/leaderboards/longshots/route.ts
// Phase 7: Longshot trader leaderboard based on resolved positions
// Computes all metrics at query time by joining market_status

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

// Valid sort options
type SortOption = 'accuracy' | 'profit';
const VALID_SORTS: SortOption[] = ['accuracy', 'profit'];

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

interface LeaderboardRow {
  wallet: string;
  total_tracked_count: number;
  resolved_count: number;
  wins_count: number;
  total_risk_usd: string;
  sum_edge: string;
  sum_weighted_edge: string;
  preferred_resolved_count: number;
  profit_preferred_usd: string | null;
  fallback_resolved_count: number;
  profit_fallback_usd: string | null;
}

interface LeaderboardEntry {
  wallet: string;
  total_tracked_count: number;
  resolved_count: number;
  wins_count: number;
  accuracy_unweighted: number;
  accuracy_weighted_value: number | null;
  total_risk_usd: number;
  avg_edge_per_usd: number;
  weighted_edge_per_usd: number;
  preferred_resolved_count: number;
  profit_preferred_usd: number | null;
  fallback_resolved_count: number;
  profit_fallback_usd: number | null;
  profit_method: 'preferred' | 'fallback' | 'mixed';
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Parse and validate parameters
  const sinceDays = parseIntParam(searchParams.get('sinceDays'), 30, 1, 365);
  const minResolved = parseIntParam(searchParams.get('minResolved'), 5, 1, 100);
  const threshold = parseFloatParam(searchParams.get('threshold'), 0.25, 0.01, 1.0);
  const sortParam = searchParams.get('sort') || 'accuracy';
  const sort: SortOption = VALID_SORTS.includes(sortParam as SortOption)
    ? (sortParam as SortOption)
    : 'accuracy';

  try {
    // Get tracking start date (min observed_at in archive)
    const trackingStartResult = await sql<{ min_date: string | null }>`
      SELECT MIN(observed_at)::text as min_date FROM trade_history_longshot_positions
    `;
    const trackingStartDate = trackingStartResult.rows[0]?.min_date || null;

    // Get global resolved count
    const globalCountResult = await sql<{ count: number }>`
      SELECT COUNT(DISTINCT lp.id)::int as count
      FROM trade_history_longshot_positions lp
      INNER JOIN market_status ms ON lp.condition_id = ms.condition_id
      WHERE ms.market_resolved = TRUE
        AND lp.fill_price <= ${threshold}
        AND lp.observed_at >= NOW() - INTERVAL '1 day' * ${sinceDays}
    `;
    const globalResolvedCount = globalCountResult.rows[0]?.count ?? 0;

    // Main leaderboard query
    // Golden Metric Set computed at query time:
    // - edge_per_usd = win::int - fill_price
    // - profit_preferred: win ? +potential_win_usd : -position_value_usd (when potential_win_usd IS NOT NULL)
    // - profit_fallback: position_value_usd * edge_per_usd (when potential_win_usd IS NULL)
    let leaderboardResult: { rows: LeaderboardRow[] };

    if (sort === 'profit') {
      // Sort by profit: preferred first, fallback as tie-breaker
      leaderboardResult = await sql<LeaderboardRow>`
        WITH resolved_positions AS (
          SELECT
            lp.wallet,
            lp.condition_id,
            lp.outcome,
            lp.fill_price,
            lp.position_value_usd,
            lp.potential_win_usd,
            ms.winning_outcome,
            CASE WHEN lp.outcome = ms.winning_outcome THEN 1 ELSE 0 END as win,
            (CASE WHEN lp.outcome = ms.winning_outcome THEN 1 ELSE 0 END)::numeric - lp.fill_price as edge_per_usd
          FROM trade_history_longshot_positions lp
          INNER JOIN market_status ms ON lp.condition_id = ms.condition_id
          WHERE ms.market_resolved = TRUE
            AND lp.fill_price <= ${threshold}
            AND lp.observed_at >= NOW() - INTERVAL '1 day' * ${sinceDays}
        ),
        wallet_stats AS (
          SELECT
            wallet,
            COUNT(*)::int as resolved_count,
            SUM(win)::int as wins_count,
            SUM(position_value_usd)::numeric as total_risk_usd,
            SUM(edge_per_usd)::numeric as sum_edge,
            SUM(position_value_usd * edge_per_usd)::numeric as sum_weighted_edge,
            COUNT(*) FILTER (WHERE potential_win_usd IS NOT NULL)::int as preferred_resolved_count,
            SUM(
              CASE
                WHEN potential_win_usd IS NOT NULL AND win = 1 THEN potential_win_usd
                WHEN potential_win_usd IS NOT NULL AND win = 0 THEN -position_value_usd
                ELSE 0
              END
            )::numeric as profit_preferred_usd,
            COUNT(*) FILTER (WHERE potential_win_usd IS NULL)::int as fallback_resolved_count,
            SUM(
              CASE
                WHEN potential_win_usd IS NULL THEN position_value_usd * edge_per_usd
                ELSE 0
              END
            )::numeric as profit_fallback_usd
          FROM resolved_positions
          GROUP BY wallet
          HAVING COUNT(*) >= ${minResolved}
        )
        SELECT
          wallet,
          (SELECT COUNT(*)::int FROM trade_history_longshot_positions t WHERE t.wallet = wallet_stats.wallet) as total_tracked_count,
          resolved_count,
          wins_count,
          total_risk_usd::text,
          sum_edge::text,
          sum_weighted_edge::text,
          preferred_resolved_count,
          profit_preferred_usd::text,
          fallback_resolved_count,
          profit_fallback_usd::text
        FROM wallet_stats
        ORDER BY profit_preferred_usd DESC NULLS LAST, profit_fallback_usd DESC NULLS LAST, resolved_count DESC
        LIMIT 50
      `;
    } else {
      // Sort by accuracy (default)
      leaderboardResult = await sql<LeaderboardRow>`
        WITH resolved_positions AS (
          SELECT
            lp.wallet,
            lp.condition_id,
            lp.outcome,
            lp.fill_price,
            lp.position_value_usd,
            lp.potential_win_usd,
            ms.winning_outcome,
            CASE WHEN lp.outcome = ms.winning_outcome THEN 1 ELSE 0 END as win,
            (CASE WHEN lp.outcome = ms.winning_outcome THEN 1 ELSE 0 END)::numeric - lp.fill_price as edge_per_usd
          FROM trade_history_longshot_positions lp
          INNER JOIN market_status ms ON lp.condition_id = ms.condition_id
          WHERE ms.market_resolved = TRUE
            AND lp.fill_price <= ${threshold}
            AND lp.observed_at >= NOW() - INTERVAL '1 day' * ${sinceDays}
        ),
        wallet_stats AS (
          SELECT
            wallet,
            COUNT(*)::int as resolved_count,
            SUM(win)::int as wins_count,
            SUM(position_value_usd)::numeric as total_risk_usd,
            SUM(edge_per_usd)::numeric as sum_edge,
            SUM(position_value_usd * edge_per_usd)::numeric as sum_weighted_edge,
            COUNT(*) FILTER (WHERE potential_win_usd IS NOT NULL)::int as preferred_resolved_count,
            SUM(
              CASE
                WHEN potential_win_usd IS NOT NULL AND win = 1 THEN potential_win_usd
                WHEN potential_win_usd IS NOT NULL AND win = 0 THEN -position_value_usd
                ELSE 0
              END
            )::numeric as profit_preferred_usd,
            COUNT(*) FILTER (WHERE potential_win_usd IS NULL)::int as fallback_resolved_count,
            SUM(
              CASE
                WHEN potential_win_usd IS NULL THEN position_value_usd * edge_per_usd
                ELSE 0
              END
            )::numeric as profit_fallback_usd
          FROM resolved_positions
          GROUP BY wallet
          HAVING COUNT(*) >= ${minResolved}
        )
        SELECT
          wallet,
          (SELECT COUNT(*)::int FROM trade_history_longshot_positions t WHERE t.wallet = wallet_stats.wallet) as total_tracked_count,
          resolved_count,
          wins_count,
          total_risk_usd::text,
          sum_edge::text,
          sum_weighted_edge::text,
          preferred_resolved_count,
          profit_preferred_usd::text,
          fallback_resolved_count,
          profit_fallback_usd::text
        FROM wallet_stats
        ORDER BY (wins_count::numeric / NULLIF(resolved_count, 0)) DESC NULLS LAST, resolved_count DESC
        LIMIT 50
      `;
    }

    // Transform to response format
    const leaderboard: LeaderboardEntry[] = leaderboardResult.rows.map(row => {
      const resolvedCount = row.resolved_count;
      const winsCount = row.wins_count;
      const totalRiskUsd = parseFloat(row.total_risk_usd) || 0;
      const sumEdge = parseFloat(row.sum_edge) || 0;
      const sumWeightedEdge = parseFloat(row.sum_weighted_edge) || 0;
      const profitPreferredUsd = row.profit_preferred_usd !== null ? parseFloat(row.profit_preferred_usd) : null;
      const profitFallbackUsd = row.profit_fallback_usd !== null ? parseFloat(row.profit_fallback_usd) : null;

      // Determine profit method
      let profitMethod: 'preferred' | 'fallback' | 'mixed';
      if (row.preferred_resolved_count > 0 && row.fallback_resolved_count > 0) {
        profitMethod = 'mixed';
      } else if (row.preferred_resolved_count > 0) {
        profitMethod = 'preferred';
      } else {
        profitMethod = 'fallback';
      }

      return {
        wallet: row.wallet,
        total_tracked_count: row.total_tracked_count,
        resolved_count: resolvedCount,
        wins_count: winsCount,
        accuracy_unweighted: resolvedCount > 0 ? winsCount / resolvedCount : 0,
        accuracy_weighted_value: totalRiskUsd > 0 ? sumWeightedEdge / totalRiskUsd : null,
        total_risk_usd: totalRiskUsd,
        avg_edge_per_usd: resolvedCount > 0 ? sumEdge / resolvedCount : 0,
        weighted_edge_per_usd: totalRiskUsd > 0 ? sumWeightedEdge / totalRiskUsd : 0,
        preferred_resolved_count: row.preferred_resolved_count,
        profit_preferred_usd: profitPreferredUsd,
        fallback_resolved_count: row.fallback_resolved_count,
        profit_fallback_usd: profitFallbackUsd,
        profit_method: profitMethod,
      };
    });

    return NextResponse.json({
      metadata: {
        threshold,
        min_resolved: minResolved,
        since_days: sinceDays,
        tracking_start_date: trackingStartDate,
        mode: 'per-snapshot',
        disclaimers: {
          tracked_subset: `Based on positions observed by our alerts since ${trackingStartDate || 'tracking start'}; may not include all wallet activity.`,
          longshot_definition: `Longshot defined as fill_price <= ${(threshold * 100).toFixed(0)}%`,
          profit_estimation: 'Profit calculations may use estimated values when potential_win_usd unavailable',
        },
        global_resolved_count: globalResolvedCount,
      },
      leaderboard,
      generated_at: new Date().toISOString(),
    }, { headers: NO_CACHE_HEADERS });

  } catch (err) {
    console.error('[leaderboards/longshots] Query failed:', err);
    return NextResponse.json(
      { error: 'Failed to generate leaderboard', details: String(err).slice(0, 200) },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}
