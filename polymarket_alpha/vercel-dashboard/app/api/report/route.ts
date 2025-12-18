// /app/api/report/route.ts
// Phase 2: DB-only report endpoint with convergence detection
// NO external API calls at render time
// Uses parameterized queries to prevent SQL injection

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import Decimal from 'decimal.js-light';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ============================================================================
// Constants - Convergence qualification thresholds (keep in one place)
// ============================================================================

type WindowHours = 6 | 24 | 72;

const CONVERGENCE_THRESHOLDS: Record<WindowHours, { minWallets: number; minTotalValue: number }> = {
  6: { minWallets: 2, minTotalValue: 0 },
  24: { minWallets: 3, minTotalValue: 10000 },
  72: { minWallets: 3, minTotalValue: 10000 },
};

const VALID_CONVERGENCE_WINDOWS: readonly WindowHours[] = [6, 24, 72] as const;

function isValidWindowHours(value: number): value is WindowHours {
  return (VALID_CONVERGENCE_WINDOWS as readonly number[]).includes(value);
}

// ============================================================================
// Parameter validation and clamping
// ============================================================================

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

// ============================================================================
// Type definitions
// ============================================================================

// Row types for SQL results (nullable fields marked as string | null)
type AlertRow = {
  id: string;
  fill_timestamp: string;
  wallet: string;
  trader_name: string | null;
  trader_pseudonym: string | null;
  title: string | null;
  slug: string | null;
  event_slug: string | null;
  outcome: string;
  condition_id: string;
  outcome_index: number | null;
  fill_price: string | null;
  fill_size: string | null;
  fill_value_usd: string | null;
  position_current_value: string | null;
  position_avg_price: string | null;
  position_size: string | null;
  is_whale: boolean;
  whale_label: string | null;
  whale_tier: string | null;
  whale_category: string | null;
};

type SummaryRow = {
  total: number;
  whale_count: number;
  unique_wallets: number;
};

type ConvergenceAggRow = {
  condition_id: string;
  outcome: string;
  title: string | null;
  slug: string | null;
  event_slug: string | null;
  distinct_wallets: number;
  total_position_value: string;
  qualifies: boolean;
};

type WalletDetailRow = {
  condition_id: string;
  outcome: string;
  wallet: string;
  position_current_value: string | null;
  fill_timestamp: string;
  trader_name: string | null;
  trader_pseudonym: string | null;
  is_whale: boolean;
  whale_label: string | null;
  rn: number;
};

type TotalGroupsRow = {
  count: number;
};

// Response types
interface FormattedAlert {
  id: string;
  fillTimestamp: string;
  wallet: string;
  traderName: string;
  title: string;
  slug: string | null;
  eventSlug: string | null;
  outcome: string;
  conditionId: string;
  fillPrice: number | null;
  fillPriceFormatted: string;
  fillValueUsd: number | null;
  fillValueFormatted: string;
  positionCurrentValue: number | null;
  positionCurrentValueFormatted: string;
  positionAvgPrice: number | null;
  positionAvgPriceFormatted: string;
  positionSize: number | null;
  potentialWin: number | null;
  potentialWinFormatted: string;
  isWhale: boolean;
  whaleLabel: string | null;
  whaleTier: string | null;
  whaleCategory: string | null;
}

interface WalletDetail {
  wallet: string;
  traderName: string;
  positionValue: number | null;
  positionValueRaw: string | null;
  positionValueFormatted: string;
  latestTimestamp: string;
  isWhale: boolean;
  whaleLabel: string | null;
}

interface ConvergenceGroup {
  conditionId: string;
  outcome: string;
  title: string;
  slug: string | null;
  eventSlug: string | null;
  distinctWallets: number;
  totalPositionValue: number;
  totalPositionValueRaw: string;
  totalPositionValueFormatted: string;
  qualifies: boolean;
  wallets: WalletDetail[];
}

// ============================================================================
// Formatting helpers
// ============================================================================

function formatMoney(value: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  if (Math.abs(value) >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`;
  }
  return `$${value.toFixed(0)}`;
}

function formatOdds(price: number | null): string {
  if (price === null || price === undefined || !Number.isFinite(price)) return 'N/A';
  return `${(price * 100).toFixed(1)}%`;
}

function parseNumeric(value: string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getMarketTitle(row: { title: string | null; slug: string | null; event_slug: string | null; condition_id: string }): string {
  return row.title || row.slug || row.event_slug || row.condition_id;
}

// ============================================================================
// Query helpers - explicit branches for filter combinations
// ============================================================================

type FilterMode = 'both' | 'whalesOnly' | 'categoryOnly' | 'none';

function getFilterMode(whalesOnly: boolean, category: string | null): FilterMode {
  if (whalesOnly && category) return 'both';
  if (whalesOnly) return 'whalesOnly';
  if (category) return 'categoryOnly';
  return 'none';
}

// ============================================================================
// Main handler
// ============================================================================

export async function GET(req: NextRequest) {
  const serverNow = new Date().toISOString();

  try {
    const { searchParams } = new URL(req.url);

    // Parse and validate parameters with clamping
    const alertWindowHours = parseIntParam(searchParams.get('alertWindowHours'), 24, 1, 720);
    const convergenceWindowParam = searchParams.get('convergenceWindowHours');
    const convergenceWindowParsed = convergenceWindowParam
      ? parseInt(convergenceWindowParam, 10)
      : 6;

    // Validate convergence window is one of the allowed values
    if (!isValidWindowHours(convergenceWindowParsed)) {
      return NextResponse.json(
        { error: 'Invalid convergenceWindowHours. Must be 6, 24, or 72.', serverNow },
        { status: 400 }
      );
    }
    const convergenceWindowHours: WindowHours = convergenceWindowParsed;

    const whalesOnly = searchParams.get('whalesOnly') === 'true';
    const category = (searchParams.get('category') ?? '').trim() || null;
    const minPosition = parseFloatParam(searchParams.get('minPosition'), 2500, 0, 1e12);
    const maxOdds = parseFloatParam(searchParams.get('maxOdds'), 0.25, 0, 1);
    const page = parseIntParam(searchParams.get('page'), 1, 1, 1_000_000);
    const pageSize = parseIntParam(searchParams.get('pageSize'), 50, 1, 200);
    const maxGroups = parseIntParam(searchParams.get('maxGroups'), 100, 1, 200);
    const maxWalletsPerGroup = parseIntParam(searchParams.get('maxWalletsPerGroup'), 25, 1, 100);

    // Calculate cutoff timestamps
    const alertCutoff = new Date(Date.now() - alertWindowHours * 60 * 60 * 1000).toISOString();
    const convergenceCutoff = new Date(Date.now() - convergenceWindowHours * 60 * 60 * 1000).toISOString();
    const offset = (page - 1) * pageSize;

    // Get thresholds for convergence qualification
    const thresholds = CONVERGENCE_THRESHOLDS[convergenceWindowHours];
    const filterMode = getFilterMode(whalesOnly, category);

    console.log(`[report] Alert window: ${alertWindowHours}h, Convergence: ${convergenceWindowHours}h`);
    console.log(`[report] Filters: whalesOnly=${whalesOnly}, category=${category}, minPosition=${minPosition}, maxOdds=${maxOdds}`);

    // ========================================================================
    // Query 1: Paginated alerts for the table UI
    // ========================================================================

    let alertsResult: { rows: AlertRow[] };

    switch (filterMode) {
      case 'both':
        alertsResult = await sql<AlertRow>`
          SELECT id, fill_timestamp, wallet, trader_name, trader_pseudonym,
            title, slug, event_slug, outcome, condition_id, outcome_index,
            fill_price, fill_size, fill_value_usd,
            position_current_value, position_avg_price, position_size,
            is_whale, whale_label, whale_tier, whale_category
          FROM alert_events
          WHERE fill_timestamp >= ${alertCutoff}::timestamptz
            AND fill_price <= ${maxOdds}
            AND is_whale = TRUE
            AND whale_category = ${category}
          ORDER BY fill_timestamp DESC, id DESC
          LIMIT ${pageSize} OFFSET ${offset}
        `;
        break;
      case 'whalesOnly':
        alertsResult = await sql<AlertRow>`
          SELECT id, fill_timestamp, wallet, trader_name, trader_pseudonym,
            title, slug, event_slug, outcome, condition_id, outcome_index,
            fill_price, fill_size, fill_value_usd,
            position_current_value, position_avg_price, position_size,
            is_whale, whale_label, whale_tier, whale_category
          FROM alert_events
          WHERE fill_timestamp >= ${alertCutoff}::timestamptz
            AND fill_price <= ${maxOdds}
            AND is_whale = TRUE
          ORDER BY fill_timestamp DESC, id DESC
          LIMIT ${pageSize} OFFSET ${offset}
        `;
        break;
      case 'categoryOnly':
        alertsResult = await sql<AlertRow>`
          SELECT id, fill_timestamp, wallet, trader_name, trader_pseudonym,
            title, slug, event_slug, outcome, condition_id, outcome_index,
            fill_price, fill_size, fill_value_usd,
            position_current_value, position_avg_price, position_size,
            is_whale, whale_label, whale_tier, whale_category
          FROM alert_events
          WHERE fill_timestamp >= ${alertCutoff}::timestamptz
            AND fill_price <= ${maxOdds}
            AND whale_category = ${category}
          ORDER BY fill_timestamp DESC, id DESC
          LIMIT ${pageSize} OFFSET ${offset}
        `;
        break;
      default:
        alertsResult = await sql<AlertRow>`
          SELECT id, fill_timestamp, wallet, trader_name, trader_pseudonym,
            title, slug, event_slug, outcome, condition_id, outcome_index,
            fill_price, fill_size, fill_value_usd,
            position_current_value, position_avg_price, position_size,
            is_whale, whale_label, whale_tier, whale_category
          FROM alert_events
          WHERE fill_timestamp >= ${alertCutoff}::timestamptz
            AND fill_price <= ${maxOdds}
          ORDER BY fill_timestamp DESC, id DESC
          LIMIT ${pageSize} OFFSET ${offset}
        `;
    }

    // Format alerts - DO NOT coerce nulls to 0
    const formattedAlerts: FormattedAlert[] = alertsResult.rows.map((row) => {
      const fillPrice = parseNumeric(row.fill_price);
      const fillValueUsd = parseNumeric(row.fill_value_usd);
      const positionCurrentValue = parseNumeric(row.position_current_value);
      const positionAvgPrice = parseNumeric(row.position_avg_price);
      const positionSize = parseNumeric(row.position_size);

      // Potential win = shares * (1 - avg_price) = profit if position resolves to $1
      const potentialWin = (positionSize !== null && positionAvgPrice !== null)
        ? positionSize * (1 - positionAvgPrice)
        : null;

      return {
        id: row.id,
        fillTimestamp: row.fill_timestamp,
        wallet: row.wallet,
        traderName: row.trader_name || row.trader_pseudonym || 'Anonymous',
        title: getMarketTitle(row),
        slug: row.slug,
        eventSlug: row.event_slug,
        outcome: row.outcome,
        conditionId: row.condition_id,
        fillPrice,
        fillPriceFormatted: formatOdds(fillPrice),
        fillValueUsd,
        fillValueFormatted: formatMoney(fillValueUsd),
        positionCurrentValue,
        positionCurrentValueFormatted: formatMoney(positionCurrentValue),
        positionAvgPrice,
        positionAvgPriceFormatted: formatOdds(positionAvgPrice),
        positionSize,
        potentialWin,
        potentialWinFormatted: formatMoney(potentialWin),
        isWhale: row.is_whale,
        whaleLabel: row.whale_label,
        whaleTier: row.whale_tier,
        whaleCategory: row.whale_category,
      };
    });

    // ========================================================================
    // Query 2: Summary statistics (also gives us totalAlerts for pagination)
    // ========================================================================

    let summaryResult: { rows: SummaryRow[] };

    switch (filterMode) {
      case 'both':
        summaryResult = await sql<SummaryRow>`
          SELECT COUNT(*)::int as total,
            COUNT(*) FILTER (WHERE is_whale = TRUE)::int as whale_count,
            COUNT(DISTINCT wallet)::int as unique_wallets
          FROM alert_events
          WHERE fill_timestamp >= ${alertCutoff}::timestamptz
            AND fill_price <= ${maxOdds}
            AND is_whale = TRUE
            AND whale_category = ${category}
        `;
        break;
      case 'whalesOnly':
        summaryResult = await sql<SummaryRow>`
          SELECT COUNT(*)::int as total,
            COUNT(*) FILTER (WHERE is_whale = TRUE)::int as whale_count,
            COUNT(DISTINCT wallet)::int as unique_wallets
          FROM alert_events
          WHERE fill_timestamp >= ${alertCutoff}::timestamptz
            AND fill_price <= ${maxOdds}
            AND is_whale = TRUE
        `;
        break;
      case 'categoryOnly':
        summaryResult = await sql<SummaryRow>`
          SELECT COUNT(*)::int as total,
            COUNT(*) FILTER (WHERE is_whale = TRUE)::int as whale_count,
            COUNT(DISTINCT wallet)::int as unique_wallets
          FROM alert_events
          WHERE fill_timestamp >= ${alertCutoff}::timestamptz
            AND fill_price <= ${maxOdds}
            AND whale_category = ${category}
        `;
        break;
      default:
        summaryResult = await sql<SummaryRow>`
          SELECT COUNT(*)::int as total,
            COUNT(*) FILTER (WHERE is_whale = TRUE)::int as whale_count,
            COUNT(DISTINCT wallet)::int as unique_wallets
          FROM alert_events
          WHERE fill_timestamp >= ${alertCutoff}::timestamptz
            AND fill_price <= ${maxOdds}
        `;
    }

    const summary = summaryResult.rows[0] || { total: 0, whale_count: 0, unique_wallets: 0 };
    const totalAlerts = summary.total;

    // ========================================================================
    // Query 3: Convergence detection
    // ========================================================================

    // Get count of QUALIFIED convergence groups (groups meeting threshold)
    // This counts groups that pass qualification WITHOUT the LIMIT
    let qualifiedGroupsResult: { rows: TotalGroupsRow[] };

    switch (filterMode) {
      case 'both':
        qualifiedGroupsResult = await sql<TotalGroupsRow>`
          WITH deduped AS (
            SELECT DISTINCT ON (condition_id, outcome, wallet)
              condition_id, outcome, wallet, position_current_value
            FROM alert_events
            WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
              AND fill_price <= ${maxOdds}
              AND position_current_value IS NOT NULL
              AND position_current_value >= ${minPosition}
              AND is_whale = TRUE
              AND whale_category = ${category}
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          ),
          aggregated AS (
            SELECT condition_id, outcome,
              COUNT(DISTINCT wallet)::int as distinct_wallets,
              COALESCE(SUM(position_current_value::numeric), 0) as total_val
            FROM deduped GROUP BY condition_id, outcome
          )
          SELECT COUNT(*)::int AS count FROM aggregated
          WHERE CASE WHEN ${convergenceWindowHours} = 6
            THEN distinct_wallets >= ${CONVERGENCE_THRESHOLDS[6].minWallets}
            ELSE (distinct_wallets >= ${thresholds.minWallets}
              OR total_val >= ${thresholds.minTotalValue})
          END
        `;
        break;
      case 'whalesOnly':
        qualifiedGroupsResult = await sql<TotalGroupsRow>`
          WITH deduped AS (
            SELECT DISTINCT ON (condition_id, outcome, wallet)
              condition_id, outcome, wallet, position_current_value
            FROM alert_events
            WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
              AND fill_price <= ${maxOdds}
              AND position_current_value IS NOT NULL
              AND position_current_value >= ${minPosition}
              AND is_whale = TRUE
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          ),
          aggregated AS (
            SELECT condition_id, outcome,
              COUNT(DISTINCT wallet)::int as distinct_wallets,
              COALESCE(SUM(position_current_value::numeric), 0) as total_val
            FROM deduped GROUP BY condition_id, outcome
          )
          SELECT COUNT(*)::int AS count FROM aggregated
          WHERE CASE WHEN ${convergenceWindowHours} = 6
            THEN distinct_wallets >= ${CONVERGENCE_THRESHOLDS[6].minWallets}
            ELSE (distinct_wallets >= ${thresholds.minWallets}
              OR total_val >= ${thresholds.minTotalValue})
          END
        `;
        break;
      case 'categoryOnly':
        qualifiedGroupsResult = await sql<TotalGroupsRow>`
          WITH deduped AS (
            SELECT DISTINCT ON (condition_id, outcome, wallet)
              condition_id, outcome, wallet, position_current_value
            FROM alert_events
            WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
              AND fill_price <= ${maxOdds}
              AND position_current_value IS NOT NULL
              AND position_current_value >= ${minPosition}
              AND whale_category = ${category}
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          ),
          aggregated AS (
            SELECT condition_id, outcome,
              COUNT(DISTINCT wallet)::int as distinct_wallets,
              COALESCE(SUM(position_current_value::numeric), 0) as total_val
            FROM deduped GROUP BY condition_id, outcome
          )
          SELECT COUNT(*)::int AS count FROM aggregated
          WHERE CASE WHEN ${convergenceWindowHours} = 6
            THEN distinct_wallets >= ${CONVERGENCE_THRESHOLDS[6].minWallets}
            ELSE (distinct_wallets >= ${thresholds.minWallets}
              OR total_val >= ${thresholds.minTotalValue})
          END
        `;
        break;
      default:
        qualifiedGroupsResult = await sql<TotalGroupsRow>`
          WITH deduped AS (
            SELECT DISTINCT ON (condition_id, outcome, wallet)
              condition_id, outcome, wallet, position_current_value
            FROM alert_events
            WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
              AND fill_price <= ${maxOdds}
              AND position_current_value IS NOT NULL
              AND position_current_value >= ${minPosition}
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          ),
          aggregated AS (
            SELECT condition_id, outcome,
              COUNT(DISTINCT wallet)::int as distinct_wallets,
              COALESCE(SUM(position_current_value::numeric), 0) as total_val
            FROM deduped GROUP BY condition_id, outcome
          )
          SELECT COUNT(*)::int AS count FROM aggregated
          WHERE CASE WHEN ${convergenceWindowHours} = 6
            THEN distinct_wallets >= ${CONVERGENCE_THRESHOLDS[6].minWallets}
            ELSE (distinct_wallets >= ${thresholds.minWallets}
              OR total_val >= ${thresholds.minTotalValue})
          END
        `;
    }

    const totalQualifiedGroups = qualifiedGroupsResult.rows[0]?.count ?? 0;

    // Get aggregated convergence groups (qualified only, limited)
    // Qualification: 6h = wallet count only; 24h/72h = wallets OR value
    let convergenceAggResult: { rows: ConvergenceAggRow[] };

    switch (filterMode) {
      case 'both':
        convergenceAggResult = await sql<ConvergenceAggRow>`
          WITH deduped AS (
            SELECT DISTINCT ON (condition_id, outcome, wallet)
              condition_id, outcome, wallet, title, slug, event_slug,
              position_current_value, fill_timestamp,
              trader_name, trader_pseudonym, is_whale, whale_label
            FROM alert_events
            WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
              AND fill_price <= ${maxOdds}
              AND position_current_value IS NOT NULL
              AND position_current_value >= ${minPosition}
              AND is_whale = TRUE
              AND whale_category = ${category}
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          ),
          aggregated AS (
            SELECT condition_id, outcome,
              MAX(title) as title, MAX(slug) as slug, MAX(event_slug) as event_slug,
              COUNT(DISTINCT wallet)::int as distinct_wallets,
              COALESCE(SUM(position_current_value::numeric), 0)::text as total_position_value,
              CASE WHEN ${convergenceWindowHours} = 6
                THEN COUNT(DISTINCT wallet) >= ${CONVERGENCE_THRESHOLDS[6].minWallets}
                ELSE (COUNT(DISTINCT wallet) >= ${thresholds.minWallets}
                  OR COALESCE(SUM(position_current_value::numeric), 0) >= ${thresholds.minTotalValue})
              END AS qualifies
            FROM deduped GROUP BY condition_id, outcome
          )
          SELECT * FROM aggregated WHERE qualifies = TRUE
          ORDER BY distinct_wallets DESC, total_position_value::numeric DESC, condition_id ASC, outcome ASC
          LIMIT ${maxGroups}
        `;
        break;
      case 'whalesOnly':
        convergenceAggResult = await sql<ConvergenceAggRow>`
          WITH deduped AS (
            SELECT DISTINCT ON (condition_id, outcome, wallet)
              condition_id, outcome, wallet, title, slug, event_slug,
              position_current_value, fill_timestamp,
              trader_name, trader_pseudonym, is_whale, whale_label
            FROM alert_events
            WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
              AND fill_price <= ${maxOdds}
              AND position_current_value IS NOT NULL
              AND position_current_value >= ${minPosition}
              AND is_whale = TRUE
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          ),
          aggregated AS (
            SELECT condition_id, outcome,
              MAX(title) as title, MAX(slug) as slug, MAX(event_slug) as event_slug,
              COUNT(DISTINCT wallet)::int as distinct_wallets,
              COALESCE(SUM(position_current_value::numeric), 0)::text as total_position_value,
              CASE WHEN ${convergenceWindowHours} = 6
                THEN COUNT(DISTINCT wallet) >= ${CONVERGENCE_THRESHOLDS[6].minWallets}
                ELSE (COUNT(DISTINCT wallet) >= ${thresholds.minWallets}
                  OR COALESCE(SUM(position_current_value::numeric), 0) >= ${thresholds.minTotalValue})
              END AS qualifies
            FROM deduped GROUP BY condition_id, outcome
          )
          SELECT * FROM aggregated WHERE qualifies = TRUE
          ORDER BY distinct_wallets DESC, total_position_value::numeric DESC, condition_id ASC, outcome ASC
          LIMIT ${maxGroups}
        `;
        break;
      case 'categoryOnly':
        convergenceAggResult = await sql<ConvergenceAggRow>`
          WITH deduped AS (
            SELECT DISTINCT ON (condition_id, outcome, wallet)
              condition_id, outcome, wallet, title, slug, event_slug,
              position_current_value, fill_timestamp,
              trader_name, trader_pseudonym, is_whale, whale_label
            FROM alert_events
            WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
              AND fill_price <= ${maxOdds}
              AND position_current_value IS NOT NULL
              AND position_current_value >= ${minPosition}
              AND whale_category = ${category}
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          ),
          aggregated AS (
            SELECT condition_id, outcome,
              MAX(title) as title, MAX(slug) as slug, MAX(event_slug) as event_slug,
              COUNT(DISTINCT wallet)::int as distinct_wallets,
              COALESCE(SUM(position_current_value::numeric), 0)::text as total_position_value,
              CASE WHEN ${convergenceWindowHours} = 6
                THEN COUNT(DISTINCT wallet) >= ${CONVERGENCE_THRESHOLDS[6].minWallets}
                ELSE (COUNT(DISTINCT wallet) >= ${thresholds.minWallets}
                  OR COALESCE(SUM(position_current_value::numeric), 0) >= ${thresholds.minTotalValue})
              END AS qualifies
            FROM deduped GROUP BY condition_id, outcome
          )
          SELECT * FROM aggregated WHERE qualifies = TRUE
          ORDER BY distinct_wallets DESC, total_position_value::numeric DESC, condition_id ASC, outcome ASC
          LIMIT ${maxGroups}
        `;
        break;
      default:
        convergenceAggResult = await sql<ConvergenceAggRow>`
          WITH deduped AS (
            SELECT DISTINCT ON (condition_id, outcome, wallet)
              condition_id, outcome, wallet, title, slug, event_slug,
              position_current_value, fill_timestamp,
              trader_name, trader_pseudonym, is_whale, whale_label
            FROM alert_events
            WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
              AND fill_price <= ${maxOdds}
              AND position_current_value IS NOT NULL
              AND position_current_value >= ${minPosition}
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          ),
          aggregated AS (
            SELECT condition_id, outcome,
              MAX(title) as title, MAX(slug) as slug, MAX(event_slug) as event_slug,
              COUNT(DISTINCT wallet)::int as distinct_wallets,
              COALESCE(SUM(position_current_value::numeric), 0)::text as total_position_value,
              CASE WHEN ${convergenceWindowHours} = 6
                THEN COUNT(DISTINCT wallet) >= ${CONVERGENCE_THRESHOLDS[6].minWallets}
                ELSE (COUNT(DISTINCT wallet) >= ${thresholds.minWallets}
                  OR COALESCE(SUM(position_current_value::numeric), 0) >= ${thresholds.minTotalValue})
              END AS qualifies
            FROM deduped GROUP BY condition_id, outcome
          )
          SELECT * FROM aggregated WHERE qualifies = TRUE
          ORDER BY distinct_wallets DESC, total_position_value::numeric DESC, condition_id ASC, outcome ASC
          LIMIT ${maxGroups}
        `;
    }

    // Build group lookup
    const groupMap = new Map<string, ConvergenceGroup>();

    for (const row of convergenceAggResult.rows) {
      const totalRaw = row.total_position_value || '0';
      const totalPositionValue = new Decimal(totalRaw).toNumber();

      const groupKey = `${row.condition_id}:${row.outcome}`;
      groupMap.set(groupKey, {
        conditionId: row.condition_id,
        outcome: row.outcome,
        title: row.title || row.slug || row.event_slug || row.condition_id,
        slug: row.slug,
        eventSlug: row.event_slug,
        distinctWallets: row.distinct_wallets,
        totalPositionValue,
        totalPositionValueRaw: totalRaw,
        totalPositionValueFormatted: formatMoney(totalPositionValue),
        qualifies: row.qualifies,
        wallets: [],
      });
    }

    // Query wallet details only if we have groups
    if (groupMap.size > 0) {
      let walletDetailsResult: { rows: WalletDetailRow[] };

      switch (filterMode) {
        case 'both':
          walletDetailsResult = await sql<WalletDetailRow>`
            WITH deduped AS (
              SELECT DISTINCT ON (condition_id, outcome, wallet)
                condition_id, outcome, wallet,
                position_current_value, fill_timestamp,
                trader_name, trader_pseudonym, is_whale, whale_label
              FROM alert_events
              WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
                AND fill_price <= ${maxOdds}
                AND position_current_value IS NOT NULL
                AND position_current_value >= ${minPosition}
                AND is_whale = TRUE
                AND whale_category = ${category}
              ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
            ),
            aggregated AS (
              SELECT condition_id, outcome,
                COUNT(DISTINCT wallet)::int as distinct_wallets,
                COALESCE(SUM(position_current_value::numeric), 0) as total_val,
                CASE WHEN ${convergenceWindowHours} = 6
                  THEN COUNT(DISTINCT wallet) >= ${CONVERGENCE_THRESHOLDS[6].minWallets}
                  ELSE (COUNT(DISTINCT wallet) >= ${thresholds.minWallets}
                    OR COALESCE(SUM(position_current_value::numeric), 0) >= ${thresholds.minTotalValue})
                END AS qualifies
              FROM deduped GROUP BY condition_id, outcome
            ),
            group_keys AS (
              SELECT condition_id, outcome FROM aggregated
              WHERE qualifies = TRUE
              ORDER BY distinct_wallets DESC, total_val DESC, condition_id ASC, outcome ASC
              LIMIT ${maxGroups}
            ),
            ranked AS (
              SELECT d.condition_id, d.outcome, d.wallet,
                d.position_current_value, d.fill_timestamp,
                d.trader_name, d.trader_pseudonym, d.is_whale, d.whale_label,
                ROW_NUMBER() OVER (PARTITION BY d.condition_id, d.outcome
                  ORDER BY d.position_current_value::numeric DESC, d.wallet ASC)::int as rn
              FROM deduped d
              INNER JOIN group_keys g ON d.condition_id = g.condition_id AND d.outcome = g.outcome
            )
            SELECT * FROM ranked WHERE rn <= ${maxWalletsPerGroup}
            ORDER BY condition_id, outcome, rn
          `;
          break;
        case 'whalesOnly':
          walletDetailsResult = await sql<WalletDetailRow>`
            WITH deduped AS (
              SELECT DISTINCT ON (condition_id, outcome, wallet)
                condition_id, outcome, wallet,
                position_current_value, fill_timestamp,
                trader_name, trader_pseudonym, is_whale, whale_label
              FROM alert_events
              WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
                AND fill_price <= ${maxOdds}
                AND position_current_value IS NOT NULL
                AND position_current_value >= ${minPosition}
                AND is_whale = TRUE
              ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
            ),
            aggregated AS (
              SELECT condition_id, outcome,
                COUNT(DISTINCT wallet)::int as distinct_wallets,
                COALESCE(SUM(position_current_value::numeric), 0) as total_val,
                CASE WHEN ${convergenceWindowHours} = 6
                  THEN COUNT(DISTINCT wallet) >= ${CONVERGENCE_THRESHOLDS[6].minWallets}
                  ELSE (COUNT(DISTINCT wallet) >= ${thresholds.minWallets}
                    OR COALESCE(SUM(position_current_value::numeric), 0) >= ${thresholds.minTotalValue})
                END AS qualifies
              FROM deduped GROUP BY condition_id, outcome
            ),
            group_keys AS (
              SELECT condition_id, outcome FROM aggregated
              WHERE qualifies = TRUE
              ORDER BY distinct_wallets DESC, total_val DESC, condition_id ASC, outcome ASC
              LIMIT ${maxGroups}
            ),
            ranked AS (
              SELECT d.condition_id, d.outcome, d.wallet,
                d.position_current_value, d.fill_timestamp,
                d.trader_name, d.trader_pseudonym, d.is_whale, d.whale_label,
                ROW_NUMBER() OVER (PARTITION BY d.condition_id, d.outcome
                  ORDER BY d.position_current_value::numeric DESC, d.wallet ASC)::int as rn
              FROM deduped d
              INNER JOIN group_keys g ON d.condition_id = g.condition_id AND d.outcome = g.outcome
            )
            SELECT * FROM ranked WHERE rn <= ${maxWalletsPerGroup}
            ORDER BY condition_id, outcome, rn
          `;
          break;
        case 'categoryOnly':
          walletDetailsResult = await sql<WalletDetailRow>`
            WITH deduped AS (
              SELECT DISTINCT ON (condition_id, outcome, wallet)
                condition_id, outcome, wallet,
                position_current_value, fill_timestamp,
                trader_name, trader_pseudonym, is_whale, whale_label
              FROM alert_events
              WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
                AND fill_price <= ${maxOdds}
                AND position_current_value IS NOT NULL
                AND position_current_value >= ${minPosition}
                AND whale_category = ${category}
              ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
            ),
            aggregated AS (
              SELECT condition_id, outcome,
                COUNT(DISTINCT wallet)::int as distinct_wallets,
                COALESCE(SUM(position_current_value::numeric), 0) as total_val,
                CASE WHEN ${convergenceWindowHours} = 6
                  THEN COUNT(DISTINCT wallet) >= ${CONVERGENCE_THRESHOLDS[6].minWallets}
                  ELSE (COUNT(DISTINCT wallet) >= ${thresholds.minWallets}
                    OR COALESCE(SUM(position_current_value::numeric), 0) >= ${thresholds.minTotalValue})
                END AS qualifies
              FROM deduped GROUP BY condition_id, outcome
            ),
            group_keys AS (
              SELECT condition_id, outcome FROM aggregated
              WHERE qualifies = TRUE
              ORDER BY distinct_wallets DESC, total_val DESC, condition_id ASC, outcome ASC
              LIMIT ${maxGroups}
            ),
            ranked AS (
              SELECT d.condition_id, d.outcome, d.wallet,
                d.position_current_value, d.fill_timestamp,
                d.trader_name, d.trader_pseudonym, d.is_whale, d.whale_label,
                ROW_NUMBER() OVER (PARTITION BY d.condition_id, d.outcome
                  ORDER BY d.position_current_value::numeric DESC, d.wallet ASC)::int as rn
              FROM deduped d
              INNER JOIN group_keys g ON d.condition_id = g.condition_id AND d.outcome = g.outcome
            )
            SELECT * FROM ranked WHERE rn <= ${maxWalletsPerGroup}
            ORDER BY condition_id, outcome, rn
          `;
          break;
        default:
          walletDetailsResult = await sql<WalletDetailRow>`
            WITH deduped AS (
              SELECT DISTINCT ON (condition_id, outcome, wallet)
                condition_id, outcome, wallet,
                position_current_value, fill_timestamp,
                trader_name, trader_pseudonym, is_whale, whale_label
              FROM alert_events
              WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
                AND fill_price <= ${maxOdds}
                AND position_current_value IS NOT NULL
                AND position_current_value >= ${minPosition}
              ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
            ),
            aggregated AS (
              SELECT condition_id, outcome,
                COUNT(DISTINCT wallet)::int as distinct_wallets,
                COALESCE(SUM(position_current_value::numeric), 0) as total_val,
                CASE WHEN ${convergenceWindowHours} = 6
                  THEN COUNT(DISTINCT wallet) >= ${CONVERGENCE_THRESHOLDS[6].minWallets}
                  ELSE (COUNT(DISTINCT wallet) >= ${thresholds.minWallets}
                    OR COALESCE(SUM(position_current_value::numeric), 0) >= ${thresholds.minTotalValue})
                END AS qualifies
              FROM deduped GROUP BY condition_id, outcome
            ),
            group_keys AS (
              SELECT condition_id, outcome FROM aggregated
              WHERE qualifies = TRUE
              ORDER BY distinct_wallets DESC, total_val DESC, condition_id ASC, outcome ASC
              LIMIT ${maxGroups}
            ),
            ranked AS (
              SELECT d.condition_id, d.outcome, d.wallet,
                d.position_current_value, d.fill_timestamp,
                d.trader_name, d.trader_pseudonym, d.is_whale, d.whale_label,
                ROW_NUMBER() OVER (PARTITION BY d.condition_id, d.outcome
                  ORDER BY d.position_current_value::numeric DESC, d.wallet ASC)::int as rn
              FROM deduped d
              INNER JOIN group_keys g ON d.condition_id = g.condition_id AND d.outcome = g.outcome
            )
            SELECT * FROM ranked WHERE rn <= ${maxWalletsPerGroup}
            ORDER BY condition_id, outcome, rn
          `;
      }

      // Attach wallets to groups
      for (const row of walletDetailsResult.rows) {
        const key = `${row.condition_id}:${row.outcome}`;
        const group = groupMap.get(key);
        if (group) {
          const posValue = parseNumeric(row.position_current_value);
          group.wallets.push({
            wallet: row.wallet,
            traderName: row.trader_name || row.trader_pseudonym || 'Anonymous',
            positionValue: posValue,
            positionValueRaw: row.position_current_value,
            positionValueFormatted: formatMoney(posValue),
            latestTimestamp: row.fill_timestamp,
            isWhale: row.is_whale,
            whaleLabel: row.whale_label,
          });
        }
      }
    }

    const qualifiedConvergence = Array.from(groupMap.values());

    // ========================================================================
    // Response
    // ========================================================================
    return NextResponse.json({
      serverNow,
      meta: {
        alertWindowHours,
        convergenceWindowHours,
        whalesOnly,
        category,
        minPosition,
        maxOdds,
        maxGroups,
        maxWalletsPerGroup,
        totalAlerts,
        whaleAlerts: summary.whale_count,
        uniqueWallets: summary.unique_wallets,
        page,
        pageSize,
        totalPages: Math.ceil(totalAlerts / pageSize),
      },
      alertsPage: formattedAlerts,
      convergence: {
        windowHours: convergenceWindowHours,
        thresholds,
        totalGroups: totalQualifiedGroups,
        qualifiedGroups: qualifiedConvergence.length,
        groups: qualifiedConvergence,
      },
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (err) {
    console.error('[report] Error:', err);
    return NextResponse.json(
      {
        error: 'Failed to generate report',
        details: err instanceof Error ? err.message : String(err),
        serverNow,
      },
      { status: 500 }
    );
  }
}
