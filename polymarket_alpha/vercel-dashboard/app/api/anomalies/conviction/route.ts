// /app/api/anomalies/conviction/route.ts
// Phase 5 (Hardened): API endpoint for conviction sizing anomalies
// Returns recent anomalies sorted by severity for dashboard display

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Response headers to prevent caching
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

interface ConvictionAnomaly {
  id: string;
  created_at: string;
  wallet: string;
  trader_name: string | null;
  fill_timestamp: string;
  trade_notional: number;
  baseline_median: number;
  baseline_mad: number;
  baseline_trade_count: number;
  ratio_to_median: number;
  robust_z: number | null;
  severity: number;
  last_seen_at: string | null;
  condition_id: string;
  outcome: string;
  title: string | null;
  slug: string | null;
  side: string;
  fill_price: number;
  is_whale: boolean;
  // Market resolution fields (from market_status JOIN)
  market_resolved: boolean;
  winning_outcome: string | null;
}

// Parse window parameter (e.g., "24h", "7d", "30d")
function parseWindow(window: string): number {
  const match = window.match(/^(\d+)(h|d)$/);
  if (!match) {
    return 24; // Default 24 hours
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  if (unit === 'd') {
    return value * 24;
  }
  return value;
}

export async function GET(request: Request) {
  const url = new URL(request.url);

  // Parse query params
  const window = url.searchParams.get('window') || '24h';
  const limitStr = url.searchParams.get('limit') || '100';
  const walletFilter = url.searchParams.get('wallet')?.toLowerCase();
  const whalesOnly = url.searchParams.get('whales') === 'true';
  // resolved param: 'only' = show only resolved, 'exclude' = hide resolved, anything else = show all
  const resolvedParam = url.searchParams.get('resolved');
  const resolvedOnly = resolvedParam === 'only';
  const excludeResolved = resolvedParam === 'exclude';
  const minRatio = url.searchParams.get('minRatio');
  const minSeverity = url.searchParams.get('minSeverity');
  const sortBy = url.searchParams.get('sort') || 'severity'; // 'severity' or 'time'

  const limit = Math.min(Math.max(1, parseInt(limitStr, 10) || 100), 500);
  const windowHours = parseWindow(window);

  // Calculate cutoff timestamp
  const cutoffDate = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const cutoff = cutoffDate.toISOString();

  // Determine ORDER BY clause
  const orderClause = sortBy === 'time'
    ? 'ORDER BY fill_timestamp DESC'
    : 'ORDER BY severity DESC, created_at DESC';

  try {
    // Build query with all filters applied
    let anomalies: ConvictionAnomaly[];

    // Parse numeric filters
    const minRatioValue = minRatio ? parseFloat(minRatio) : null;
    const minSeverityValue = minSeverity ? parseFloat(minSeverity) : null;

    // Use a single flexible query with optional filters
    // Note: sql template doesn't support dynamic ORDER BY, so we use two code paths
    if (sortBy === 'time') {
      const result = await sql<ConvictionAnomaly>`
        SELECT
          ca.id,
          ca.created_at::text,
          ca.wallet,
          ca.trader_name,
          ca.fill_timestamp::text,
          ca.trade_notional,
          ca.baseline_median,
          ca.baseline_mad,
          ca.baseline_trade_count,
          ca.ratio_to_median,
          ca.robust_z,
          COALESCE(ca.severity, 0) as severity,
          ca.last_seen_at::text,
          ca.condition_id,
          ca.outcome,
          ca.title,
          ca.slug,
          ca.side,
          ca.fill_price,
          ca.is_whale,
          COALESCE(ms.market_resolved, FALSE) as market_resolved,
          ms.winning_outcome
        FROM conviction_anomalies ca
        LEFT JOIN market_status ms ON ca.condition_id = ms.condition_id
        WHERE ca.fill_timestamp >= ${cutoff}::timestamptz
          AND (${walletFilter}::text IS NULL OR ca.wallet = ${walletFilter})
          AND (${whalesOnly}::boolean = FALSE OR ca.is_whale = TRUE)
          AND (${resolvedOnly}::boolean = FALSE OR ms.market_resolved = TRUE)
          AND (${excludeResolved}::boolean = FALSE OR COALESCE(ms.market_resolved, FALSE) = FALSE)
          AND (${minRatioValue}::numeric IS NULL OR ca.ratio_to_median >= ${minRatioValue})
          AND (${minSeverityValue}::numeric IS NULL OR COALESCE(ca.severity, 0) >= ${minSeverityValue})
        ORDER BY ca.fill_timestamp DESC
        LIMIT ${limit}
      `;
      anomalies = result.rows;
    } else {
      // Default: sort by severity
      const result = await sql<ConvictionAnomaly>`
        SELECT
          ca.id,
          ca.created_at::text,
          ca.wallet,
          ca.trader_name,
          ca.fill_timestamp::text,
          ca.trade_notional,
          ca.baseline_median,
          ca.baseline_mad,
          ca.baseline_trade_count,
          ca.ratio_to_median,
          ca.robust_z,
          COALESCE(ca.severity, 0) as severity,
          ca.last_seen_at::text,
          ca.condition_id,
          ca.outcome,
          ca.title,
          ca.slug,
          ca.side,
          ca.fill_price,
          ca.is_whale,
          COALESCE(ms.market_resolved, FALSE) as market_resolved,
          ms.winning_outcome
        FROM conviction_anomalies ca
        LEFT JOIN market_status ms ON ca.condition_id = ms.condition_id
        WHERE ca.fill_timestamp >= ${cutoff}::timestamptz
          AND (${walletFilter}::text IS NULL OR ca.wallet = ${walletFilter})
          AND (${whalesOnly}::boolean = FALSE OR ca.is_whale = TRUE)
          AND (${resolvedOnly}::boolean = FALSE OR ms.market_resolved = TRUE)
          AND (${excludeResolved}::boolean = FALSE OR COALESCE(ms.market_resolved, FALSE) = FALSE)
          AND (${minRatioValue}::numeric IS NULL OR ca.ratio_to_median >= ${minRatioValue})
          AND (${minSeverityValue}::numeric IS NULL OR COALESCE(ca.severity, 0) >= ${minSeverityValue})
        ORDER BY COALESCE(ca.severity, 0) DESC, ca.created_at DESC
        LIMIT ${limit}
      `;
      anomalies = result.rows;
    }

    // Get summary stats (with same filters as main query for consistency)
    const statsResult = await sql<{
      total_count: number;
      whale_count: number;
      avg_ratio: number;
      max_ratio: number;
      avg_severity: number;
      max_severity: number;
    }>`
      SELECT
        COUNT(*)::int as total_count,
        COUNT(*) FILTER (WHERE ca.is_whale = TRUE)::int as whale_count,
        COALESCE(AVG(ca.ratio_to_median), 0) as avg_ratio,
        COALESCE(MAX(ca.ratio_to_median), 0) as max_ratio,
        COALESCE(AVG(ca.severity), 0) as avg_severity,
        COALESCE(MAX(ca.severity), 0) as max_severity
      FROM conviction_anomalies ca
      LEFT JOIN market_status ms ON ca.condition_id = ms.condition_id
      WHERE ca.fill_timestamp >= ${cutoff}::timestamptz
        AND (${walletFilter}::text IS NULL OR ca.wallet = ${walletFilter})
        AND (${whalesOnly}::boolean = FALSE OR ca.is_whale = TRUE)
        AND (${resolvedOnly}::boolean = FALSE OR ms.market_resolved = TRUE)
        AND (${excludeResolved}::boolean = FALSE OR COALESCE(ms.market_resolved, FALSE) = FALSE)
        AND (${minRatioValue}::numeric IS NULL OR ca.ratio_to_median >= ${minRatioValue})
        AND (${minSeverityValue}::numeric IS NULL OR COALESCE(ca.severity, 0) >= ${minSeverityValue})
    `;

    const stats = statsResult.rows[0] || {
      total_count: 0,
      whale_count: 0,
      avg_ratio: 0,
      max_ratio: 0,
      avg_severity: 0,
      max_severity: 0,
    };

    return NextResponse.json({
      anomalies,
      meta: {
        count: anomalies.length,
        window,
        windowHours,
        cutoff,
        limit,
        sortBy,
        stats: {
          total: stats.total_count ?? 0,
          whaleCount: stats.whale_count ?? 0,
          avgRatio: stats.avg_ratio != null ? Number(Number(stats.avg_ratio).toFixed(2)) : 0,
          maxRatio: stats.max_ratio != null ? Number(Number(stats.max_ratio).toFixed(2)) : 0,
          avgSeverity: stats.avg_severity != null ? Number(Number(stats.avg_severity).toFixed(2)) : 0,
          maxSeverity: stats.max_severity != null ? Number(Number(stats.max_severity).toFixed(2)) : 0,
        },
      },
    }, { headers: NO_CACHE_HEADERS });

  } catch (err) {
    console.error('[anomalies/conviction] Error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch anomalies', details: String(err) },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}
