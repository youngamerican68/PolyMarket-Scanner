// /app/api/report/route.ts
// Phase 2-3: DB-only report endpoint with convergence detection and cached prices
// NO external API calls at render time
// Uses parameterized queries to prevent SQL injection

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import Decimal from 'decimal.js-light';
import { archiveLongshotPositionsBatch, LongshotSnapshot } from '@/lib/longshots/archiveLongshotPosition';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Price staleness threshold in milliseconds (30 minutes)
const PRICE_STALE_THRESHOLD_MS = 30 * 60 * 1000;

// Phase 7: Longshot archive feature flag (default: off)
const LONGSHOT_ARCHIVE_ENABLED = process.env.ENABLE_LONGSHOT_ARCHIVE === 'true';

// ============================================================================
// Constants - Convergence qualification thresholds (keep in one place)
// ============================================================================

type WindowHours = 6 | 24 | 72;

const CONVERGENCE_THRESHOLDS: Record<WindowHours, { minWallets: number; minTotalValue: number }> = {
  6: { minWallets: 2, minTotalValue: 10000 },
  24: { minWallets: 2, minTotalValue: 10000 },
  72: { minWallets: 2, minTotalValue: 10000 },
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

// Floor date to hour granularity (for stable dedupe keys when no stable timestamp available)
function floorToHour(date: Date): Date {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d;
}

// ============================================================================
// Type definitions
// ============================================================================

// Price status for cached prices
type PriceStatus = 'fresh' | 'stale' | 'missing';

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
  // Cached price fields (from LEFT JOIN)
  cached_price: string | null;
  price_fetched_at: string | null;
  // Phase 6: Market resolution fields (from LEFT JOIN market_status)
  market_resolved: boolean | null;
  market_closed: boolean | null;
  winning_outcome: string | null;
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
  min_fill_price: string | null;
  max_fill_price: string | null;
  latest_fill_timestamp: string | null; // Phase 7: for archive dedupe key
  qualifies: boolean;
};

type WalletDetailRow = {
  condition_id: string;
  outcome: string;
  wallet: string;
  position_current_value: string | null;
  position_size: string | null;
  position_avg_price: string | null;
  fill_price: string | null;
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
  // Cached price fields (Phase 3)
  currentPrice: number | null;
  currentPriceFormatted: string;
  priceStatus: PriceStatus;
  priceFetchedAt: string | null;
  // Phase 6: Market resolution fields
  marketResolved: boolean;
  marketClosed: boolean;
  winningOutcome: string | null;
}

interface WalletDetail {
  wallet: string;
  traderName: string;
  positionValue: number | null;
  positionValueRaw: string | null;
  positionValueFormatted: string;
  fillPrice: number | null;
  fillPriceFormatted: string;
  positionAvgPrice: number | null;
  positionAvgPriceFormatted: string;
  potentialWin: number | null;
  potentialWinFormatted: string;
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
  minOdds: number | null;
  maxOdds: number | null;
  oddsRangeFormatted: string;
  qualifies: boolean;
  wallets: WalletDetail[];
  // Phase 6: Market resolution fields
  marketResolved: boolean;
  winningOutcome: string | null;
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

function getPriceStatus(fetchedAt: string | null): PriceStatus {
  if (!fetchedAt) return 'missing';
  const fetchedTime = new Date(fetchedAt).getTime();
  const now = Date.now();
  const age = now - fetchedTime;
  return age > PRICE_STALE_THRESHOLD_MS ? 'stale' : 'fresh';
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

    // Default convergenceWindow to alertWindowHours if not provided and alertWindowHours is valid,
    // otherwise fall back to 6h
    const defaultConvergenceWindow = isValidWindowHours(alertWindowHours) ? alertWindowHours : 6;
    const convergenceWindowParsed = convergenceWindowParam
      ? parseInt(convergenceWindowParam, 10)
      : defaultConvergenceWindow;

    // Validate convergence window is one of the allowed values
    if (!isValidWindowHours(convergenceWindowParsed)) {
      return NextResponse.json(
        { error: 'Invalid convergenceWindowHours. Must be 6, 24, or 72.', serverNow },
        { status: 400 }
      );
    }
    const convergenceWindowHours: WindowHours = convergenceWindowParsed;

    const whalesOnly = searchParams.get('whalesOnly') === 'true';
    const includeResolved = searchParams.get('includeResolved') === 'true';
    const category = (searchParams.get('category') ?? '').trim().toLowerCase() || null;
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
    console.log(`[report] Filters: whalesOnly=${whalesOnly}, category=${category}, minPosition=${minPosition}, maxOdds=${maxOdds}, includeResolved=${includeResolved}`);

    // ========================================================================
    // Query 1: Paginated alerts for the table UI
    // ========================================================================

    let alertsResult: { rows: AlertRow[] };

    switch (filterMode) {
      case 'both':
        alertsResult = await sql<AlertRow>`
          SELECT ae.id, ae.fill_timestamp, ae.wallet, ae.trader_name, ae.trader_pseudonym,
            ae.title, ae.slug, ae.event_slug, ae.outcome, ae.condition_id, ae.outcome_index,
            ae.fill_price, ae.fill_size, ae.fill_value_usd,
            ae.position_current_value, ae.position_avg_price, ae.position_size,
            ae.is_whale, ae.whale_label, ae.whale_tier, ae.whale_category,
            opc.price::text as cached_price, opc.fetched_at::text as price_fetched_at,
            ms.market_resolved, ms.market_closed, ms.winning_outcome
          FROM alert_events ae
          LEFT JOIN outcome_price_cache opc ON ae.condition_id = opc.condition_id AND ae.outcome = opc.outcome
          LEFT JOIN market_status ms ON ae.condition_id = ms.condition_id
          WHERE ae.fill_timestamp >= ${alertCutoff}::timestamptz
            AND ae.fill_price <= ${maxOdds}
            AND ae.position_current_value IS NOT NULL
            AND ae.position_current_value >= ${minPosition}
            AND ae.is_whale = TRUE
            AND ae.whale_category = ${category}
            AND (
              CASE WHEN ${includeResolved}::boolean = TRUE
                THEN ms.market_resolved = TRUE AND ms.winning_outcome IS NOT NULL AND TRIM(ms.winning_outcome) != ''
                ELSE ms.market_resolved IS NOT TRUE OR ms.winning_outcome IS NULL OR TRIM(ms.winning_outcome) = ''
              END
            )
          ORDER BY ae.fill_timestamp DESC, ae.id DESC
          LIMIT ${pageSize} OFFSET ${offset}
        `;
        break;
      case 'whalesOnly':
        alertsResult = await sql<AlertRow>`
          SELECT ae.id, ae.fill_timestamp, ae.wallet, ae.trader_name, ae.trader_pseudonym,
            ae.title, ae.slug, ae.event_slug, ae.outcome, ae.condition_id, ae.outcome_index,
            ae.fill_price, ae.fill_size, ae.fill_value_usd,
            ae.position_current_value, ae.position_avg_price, ae.position_size,
            ae.is_whale, ae.whale_label, ae.whale_tier, ae.whale_category,
            opc.price::text as cached_price, opc.fetched_at::text as price_fetched_at,
            ms.market_resolved, ms.market_closed, ms.winning_outcome
          FROM alert_events ae
          LEFT JOIN outcome_price_cache opc ON ae.condition_id = opc.condition_id AND ae.outcome = opc.outcome
          LEFT JOIN market_status ms ON ae.condition_id = ms.condition_id
          WHERE ae.fill_timestamp >= ${alertCutoff}::timestamptz
            AND ae.fill_price <= ${maxOdds}
            AND ae.position_current_value IS NOT NULL
            AND ae.position_current_value >= ${minPosition}
            AND ae.is_whale = TRUE
            AND (
              CASE WHEN ${includeResolved}::boolean = TRUE
                THEN ms.market_resolved = TRUE AND ms.winning_outcome IS NOT NULL AND TRIM(ms.winning_outcome) != ''
                ELSE ms.market_resolved IS NOT TRUE OR ms.winning_outcome IS NULL OR TRIM(ms.winning_outcome) = ''
              END
            )
          ORDER BY ae.fill_timestamp DESC, ae.id DESC
          LIMIT ${pageSize} OFFSET ${offset}
        `;
        break;
      case 'categoryOnly':
        alertsResult = await sql<AlertRow>`
          SELECT ae.id, ae.fill_timestamp, ae.wallet, ae.trader_name, ae.trader_pseudonym,
            ae.title, ae.slug, ae.event_slug, ae.outcome, ae.condition_id, ae.outcome_index,
            ae.fill_price, ae.fill_size, ae.fill_value_usd,
            ae.position_current_value, ae.position_avg_price, ae.position_size,
            ae.is_whale, ae.whale_label, ae.whale_tier, ae.whale_category,
            opc.price::text as cached_price, opc.fetched_at::text as price_fetched_at,
            ms.market_resolved, ms.market_closed, ms.winning_outcome
          FROM alert_events ae
          LEFT JOIN outcome_price_cache opc ON ae.condition_id = opc.condition_id AND ae.outcome = opc.outcome
          LEFT JOIN market_status ms ON ae.condition_id = ms.condition_id
          WHERE ae.fill_timestamp >= ${alertCutoff}::timestamptz
            AND ae.fill_price <= ${maxOdds}
            AND ae.position_current_value IS NOT NULL
            AND ae.position_current_value >= ${minPosition}
            AND ae.whale_category = ${category}
            AND (
              CASE WHEN ${includeResolved}::boolean = TRUE
                THEN ms.market_resolved = TRUE AND ms.winning_outcome IS NOT NULL AND TRIM(ms.winning_outcome) != ''
                ELSE ms.market_resolved IS NOT TRUE OR ms.winning_outcome IS NULL OR TRIM(ms.winning_outcome) = ''
              END
            )
          ORDER BY ae.fill_timestamp DESC, ae.id DESC
          LIMIT ${pageSize} OFFSET ${offset}
        `;
        break;
      default:
        alertsResult = await sql<AlertRow>`
          SELECT ae.id, ae.fill_timestamp, ae.wallet, ae.trader_name, ae.trader_pseudonym,
            ae.title, ae.slug, ae.event_slug, ae.outcome, ae.condition_id, ae.outcome_index,
            ae.fill_price, ae.fill_size, ae.fill_value_usd,
            ae.position_current_value, ae.position_avg_price, ae.position_size,
            ae.is_whale, ae.whale_label, ae.whale_tier, ae.whale_category,
            opc.price::text as cached_price, opc.fetched_at::text as price_fetched_at,
            ms.market_resolved, ms.market_closed, ms.winning_outcome
          FROM alert_events ae
          LEFT JOIN outcome_price_cache opc ON ae.condition_id = opc.condition_id AND ae.outcome = opc.outcome
          LEFT JOIN market_status ms ON ae.condition_id = ms.condition_id
          WHERE ae.fill_timestamp >= ${alertCutoff}::timestamptz
            AND ae.fill_price <= ${maxOdds}
            AND ae.position_current_value IS NOT NULL
            AND ae.position_current_value >= ${minPosition}
            AND (
              CASE WHEN ${includeResolved}::boolean = TRUE
                THEN ms.market_resolved = TRUE AND ms.winning_outcome IS NOT NULL AND TRIM(ms.winning_outcome) != ''
                ELSE ms.market_resolved IS NOT TRUE OR ms.winning_outcome IS NULL OR TRIM(ms.winning_outcome) = ''
              END
            )
          ORDER BY ae.fill_timestamp DESC, ae.id DESC
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
      const cachedPrice = parseNumeric(row.cached_price);

      // Potential win = shares * (1 - avg_price) = profit if position resolves to $1
      const potentialWin = (positionSize !== null && positionAvgPrice !== null)
        ? positionSize * (1 - positionAvgPrice)
        : null;

      // Price status based on cache freshness
      const priceStatus = getPriceStatus(row.price_fetched_at);

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
        // Cached price fields
        currentPrice: cachedPrice,
        currentPriceFormatted: cachedPrice !== null ? formatOdds(cachedPrice) : 'Price unavailable',
        priceStatus,
        priceFetchedAt: row.price_fetched_at,
        // Phase 6: Market resolution fields
        marketResolved: row.market_resolved ?? false,
        marketClosed: row.market_closed ?? false,
        winningOutcome: row.winning_outcome ?? null,
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
            AND position_current_value IS NOT NULL
            AND position_current_value >= ${minPosition}
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
            AND position_current_value IS NOT NULL
            AND position_current_value >= ${minPosition}
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
            AND position_current_value IS NOT NULL
            AND position_current_value >= ${minPosition}
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
            AND position_current_value IS NOT NULL
            AND position_current_value >= ${minPosition}
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
              AND (
                CASE WHEN ${includeResolved}::boolean = TRUE
                  THEN condition_id IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != '')
                  ELSE condition_id NOT IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != '')
                END
              )
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          ),
          aggregated AS (
            SELECT condition_id, outcome,
              COUNT(DISTINCT wallet)::int as distinct_wallets,
              COALESCE(SUM(position_current_value::numeric), 0) as total_val
            FROM deduped GROUP BY condition_id, outcome
          )
          SELECT COUNT(*)::int AS count FROM aggregated
          WHERE (distinct_wallets >= ${thresholds.minWallets}
            OR total_val >= ${thresholds.minTotalValue})
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
              AND (
                CASE WHEN ${includeResolved}::boolean = TRUE
                  THEN condition_id IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != '')
                  ELSE condition_id NOT IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != '')
                END
              )
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          ),
          aggregated AS (
            SELECT condition_id, outcome,
              COUNT(DISTINCT wallet)::int as distinct_wallets,
              COALESCE(SUM(position_current_value::numeric), 0) as total_val
            FROM deduped GROUP BY condition_id, outcome
          )
          SELECT COUNT(*)::int AS count FROM aggregated
          WHERE (distinct_wallets >= ${thresholds.minWallets}
            OR total_val >= ${thresholds.minTotalValue})
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
              AND (
                CASE WHEN ${includeResolved}::boolean = TRUE
                  THEN condition_id IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != '')
                  ELSE condition_id NOT IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != '')
                END
              )
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          ),
          aggregated AS (
            SELECT condition_id, outcome,
              COUNT(DISTINCT wallet)::int as distinct_wallets,
              COALESCE(SUM(position_current_value::numeric), 0) as total_val
            FROM deduped GROUP BY condition_id, outcome
          )
          SELECT COUNT(*)::int AS count FROM aggregated
          WHERE (distinct_wallets >= ${thresholds.minWallets}
            OR total_val >= ${thresholds.minTotalValue})
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
              AND (
                CASE WHEN ${includeResolved}::boolean = TRUE
                  THEN condition_id IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != '')
                  ELSE condition_id NOT IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != '')
                END
              )
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          ),
          aggregated AS (
            SELECT condition_id, outcome,
              COUNT(DISTINCT wallet)::int as distinct_wallets,
              COALESCE(SUM(position_current_value::numeric), 0) as total_val
            FROM deduped GROUP BY condition_id, outcome
          )
          SELECT COUNT(*)::int AS count FROM aggregated
          WHERE (distinct_wallets >= ${thresholds.minWallets}
            OR total_val >= ${thresholds.minTotalValue})
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
              position_current_value, fill_price, fill_timestamp,
              trader_name, trader_pseudonym, is_whale, whale_label
            FROM alert_events
            WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
              AND fill_price <= ${maxOdds}
              AND position_current_value IS NOT NULL
              AND position_current_value >= ${minPosition}
              AND is_whale = TRUE
              AND whale_category = ${category}
              AND (
                CASE WHEN ${includeResolved}::boolean = TRUE
                  THEN condition_id IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != '')
                  ELSE condition_id NOT IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != '')
                END
              )
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          ),
          aggregated AS (
            SELECT condition_id, outcome,
              MAX(title) as title, MAX(slug) as slug, MAX(event_slug) as event_slug,
              COUNT(DISTINCT wallet)::int as distinct_wallets,
              COALESCE(SUM(position_current_value::numeric), 0)::text as total_position_value,
              MIN(fill_price)::text as min_fill_price,
              MAX(fill_price)::text as max_fill_price,
              MAX(fill_timestamp)::text as latest_fill_timestamp,
              (COUNT(DISTINCT wallet) >= ${thresholds.minWallets}
                OR COALESCE(SUM(position_current_value::numeric), 0) >= ${thresholds.minTotalValue}) AS qualifies
            FROM deduped GROUP BY condition_id, outcome
          )
          SELECT * FROM aggregated WHERE qualifies = TRUE
          ORDER BY total_position_value::numeric DESC, distinct_wallets DESC, condition_id ASC, outcome ASC
          LIMIT ${maxGroups}
        `;
        break;
      case 'whalesOnly':
        convergenceAggResult = await sql<ConvergenceAggRow>`
          WITH deduped AS (
            SELECT DISTINCT ON (condition_id, outcome, wallet)
              condition_id, outcome, wallet, title, slug, event_slug,
              position_current_value, fill_price, fill_timestamp,
              trader_name, trader_pseudonym, is_whale, whale_label
            FROM alert_events
            WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
              AND fill_price <= ${maxOdds}
              AND position_current_value IS NOT NULL
              AND position_current_value >= ${minPosition}
              AND is_whale = TRUE
              AND (
                CASE WHEN ${includeResolved}::boolean = TRUE
                  THEN condition_id IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != '')
                  ELSE condition_id NOT IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != '')
                END
              )
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          ),
          aggregated AS (
            SELECT condition_id, outcome,
              MAX(title) as title, MAX(slug) as slug, MAX(event_slug) as event_slug,
              COUNT(DISTINCT wallet)::int as distinct_wallets,
              COALESCE(SUM(position_current_value::numeric), 0)::text as total_position_value,
              MIN(fill_price)::text as min_fill_price,
              MAX(fill_price)::text as max_fill_price,
              MAX(fill_timestamp)::text as latest_fill_timestamp,
              (COUNT(DISTINCT wallet) >= ${thresholds.minWallets}
                OR COALESCE(SUM(position_current_value::numeric), 0) >= ${thresholds.minTotalValue}) AS qualifies
            FROM deduped GROUP BY condition_id, outcome
          )
          SELECT * FROM aggregated WHERE qualifies = TRUE
          ORDER BY total_position_value::numeric DESC, distinct_wallets DESC, condition_id ASC, outcome ASC
          LIMIT ${maxGroups}
        `;
        break;
      case 'categoryOnly':
        convergenceAggResult = await sql<ConvergenceAggRow>`
          WITH deduped AS (
            SELECT DISTINCT ON (condition_id, outcome, wallet)
              condition_id, outcome, wallet, title, slug, event_slug,
              position_current_value, fill_price, fill_timestamp,
              trader_name, trader_pseudonym, is_whale, whale_label
            FROM alert_events
            WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
              AND fill_price <= ${maxOdds}
              AND position_current_value IS NOT NULL
              AND position_current_value >= ${minPosition}
              AND whale_category = ${category}
              AND (
                CASE WHEN ${includeResolved}::boolean = TRUE
                  THEN condition_id IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != '')
                  ELSE condition_id NOT IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != '')
                END
              )
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          ),
          aggregated AS (
            SELECT condition_id, outcome,
              MAX(title) as title, MAX(slug) as slug, MAX(event_slug) as event_slug,
              COUNT(DISTINCT wallet)::int as distinct_wallets,
              COALESCE(SUM(position_current_value::numeric), 0)::text as total_position_value,
              MIN(fill_price)::text as min_fill_price,
              MAX(fill_price)::text as max_fill_price,
              MAX(fill_timestamp)::text as latest_fill_timestamp,
              (COUNT(DISTINCT wallet) >= ${thresholds.minWallets}
                OR COALESCE(SUM(position_current_value::numeric), 0) >= ${thresholds.minTotalValue}) AS qualifies
            FROM deduped GROUP BY condition_id, outcome
          )
          SELECT * FROM aggregated WHERE qualifies = TRUE
          ORDER BY total_position_value::numeric DESC, distinct_wallets DESC, condition_id ASC, outcome ASC
          LIMIT ${maxGroups}
        `;
        break;
      default:
        convergenceAggResult = await sql<ConvergenceAggRow>`
          WITH deduped AS (
            SELECT DISTINCT ON (condition_id, outcome, wallet)
              condition_id, outcome, wallet, title, slug, event_slug,
              position_current_value, fill_price, fill_timestamp,
              trader_name, trader_pseudonym, is_whale, whale_label
            FROM alert_events
            WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
              AND fill_price <= ${maxOdds}
              AND position_current_value IS NOT NULL
              AND position_current_value >= ${minPosition}
              AND (
                CASE WHEN ${includeResolved}::boolean = TRUE
                  THEN condition_id IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != '')
                  ELSE condition_id NOT IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != '')
                END
              )
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          ),
          aggregated AS (
            SELECT condition_id, outcome,
              MAX(title) as title, MAX(slug) as slug, MAX(event_slug) as event_slug,
              COUNT(DISTINCT wallet)::int as distinct_wallets,
              COALESCE(SUM(position_current_value::numeric), 0)::text as total_position_value,
              MIN(fill_price)::text as min_fill_price,
              MAX(fill_price)::text as max_fill_price,
              MAX(fill_timestamp)::text as latest_fill_timestamp,
              (COUNT(DISTINCT wallet) >= ${thresholds.minWallets}
                OR COALESCE(SUM(position_current_value::numeric), 0) >= ${thresholds.minTotalValue}) AS qualifies
            FROM deduped GROUP BY condition_id, outcome
          )
          SELECT * FROM aggregated WHERE qualifies = TRUE
          ORDER BY total_position_value::numeric DESC, distinct_wallets DESC, condition_id ASC, outcome ASC
          LIMIT ${maxGroups}
        `;
    }

    // Build group lookup
    const groupMap = new Map<string, ConvergenceGroup>();
    // Phase 7: Track latest fill timestamps separately (not in response)
    const groupTimestampMap = new Map<string, string | null>();

    for (const row of convergenceAggResult.rows) {
      const totalRaw = row.total_position_value || '0';
      const totalPositionValue = new Decimal(totalRaw).toNumber();
      const minOdds = parseNumeric(row.min_fill_price);
      const maxOdds = parseNumeric(row.max_fill_price);

      // Format odds range: "8-15%" or just "12%" if same
      let oddsRangeFormatted = 'N/A';
      if (minOdds !== null && maxOdds !== null) {
        const minPct = (minOdds * 100).toFixed(0);
        const maxPct = (maxOdds * 100).toFixed(0);
        oddsRangeFormatted = minPct === maxPct ? `${minPct}%` : `${minPct}-${maxPct}%`;
      }

      const groupKey = `${row.condition_id}:${row.outcome}`;
      // Phase 7: Store timestamp for archival (not in response)
      groupTimestampMap.set(groupKey, row.latest_fill_timestamp);
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
        minOdds,
        maxOdds,
        oddsRangeFormatted,
        qualifies: row.qualifies,
        wallets: [],
        // Will be enriched below
        marketResolved: false,
        winningOutcome: null,
      });
    }

    // Enrich convergence groups with market resolution status
    if (groupMap.size > 0) {
      try {
        // Get all unique condition IDs from groups
        const conditionIdSet = new Set<string>();
        const groups = Array.from(groupMap.values());
        for (let i = 0; i < groups.length; i++) {
          conditionIdSet.add(groups[i].conditionId);
        }

        // Query resolution status for all condition IDs at once
        // Only fetch markets with valid winning_outcome (non-null, non-empty)
        const resolutionResult = await sql<{ condition_id: string; market_resolved: boolean; winning_outcome: string | null }>`
          SELECT ms.condition_id, ms.market_resolved, ms.winning_outcome
          FROM market_status ms
          WHERE ms.condition_id IN (
            SELECT DISTINCT ae.condition_id
            FROM alert_events ae
            WHERE ae.condition_id IS NOT NULL
          )
          AND ms.market_resolved = TRUE
          AND ms.winning_outcome IS NOT NULL
          AND TRIM(ms.winning_outcome) != ''
        `;

        const resolutionMap = new Map(resolutionResult.rows.map(r => [r.condition_id, r]));
        const groupsToEnrich = Array.from(groupMap.values());
        let enrichedCount = 0;
        let notFoundCount = 0;
        for (let i = 0; i < groupsToEnrich.length; i++) {
          const group = groupsToEnrich[i];
          const status = resolutionMap.get(group.conditionId);
          if (status) {
            group.marketResolved = status.market_resolved ?? false;
            group.winningOutcome = status.winning_outcome ?? null;
            enrichedCount++;
          } else {
            notFoundCount++;
            // Debug: log condition_ids that passed filter but weren't enriched
            if (includeResolved) {
              console.warn(`[report] Convergence group passed resolved filter but no resolution data: ${group.conditionId} (${group.outcome})`);
            }
          }
        }
        if (includeResolved && notFoundCount > 0) {
          console.warn(`[report] Enrichment stats: ${enrichedCount} enriched, ${notFoundCount} not found in resolution map`);
        }
      } catch (err) {
        console.warn('[report] Failed to enrich convergence with resolution status:', err);
      }
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
                position_current_value, position_size, position_avg_price, fill_price, fill_timestamp,
                trader_name, trader_pseudonym, is_whale, whale_label
              FROM alert_events
              WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
                AND fill_price <= ${maxOdds}
                AND position_current_value IS NOT NULL
                AND position_current_value >= ${minPosition}
                AND is_whale = TRUE
                AND whale_category = ${category}
                AND (
                  CASE WHEN ${includeResolved}::boolean = TRUE
                    THEN condition_id IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE)
                    ELSE condition_id NOT IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE)
                  END
                )
              ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
            ),
            aggregated AS (
              SELECT condition_id, outcome,
                COUNT(DISTINCT wallet)::int as distinct_wallets,
                COALESCE(SUM(position_current_value::numeric), 0) as total_val,
                (COUNT(DISTINCT wallet) >= ${thresholds.minWallets}
                  OR COALESCE(SUM(position_current_value::numeric), 0) >= ${thresholds.minTotalValue}) AS qualifies
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
                d.position_current_value, d.position_size, d.position_avg_price, d.fill_price, d.fill_timestamp,
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
                position_current_value, position_size, position_avg_price, fill_price, fill_timestamp,
                trader_name, trader_pseudonym, is_whale, whale_label
              FROM alert_events
              WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
                AND fill_price <= ${maxOdds}
                AND position_current_value IS NOT NULL
                AND position_current_value >= ${minPosition}
                AND is_whale = TRUE
                AND (
                  CASE WHEN ${includeResolved}::boolean = TRUE
                    THEN condition_id IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE)
                    ELSE condition_id NOT IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE)
                  END
                )
              ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
            ),
            aggregated AS (
              SELECT condition_id, outcome,
                COUNT(DISTINCT wallet)::int as distinct_wallets,
                COALESCE(SUM(position_current_value::numeric), 0) as total_val,
                (COUNT(DISTINCT wallet) >= ${thresholds.minWallets}
                  OR COALESCE(SUM(position_current_value::numeric), 0) >= ${thresholds.minTotalValue}) AS qualifies
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
                d.position_current_value, d.position_size, d.position_avg_price, d.fill_price, d.fill_timestamp,
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
                position_current_value, position_size, position_avg_price, fill_price, fill_timestamp,
                trader_name, trader_pseudonym, is_whale, whale_label
              FROM alert_events
              WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
                AND fill_price <= ${maxOdds}
                AND position_current_value IS NOT NULL
                AND position_current_value >= ${minPosition}
                AND whale_category = ${category}
                AND (
                  CASE WHEN ${includeResolved}::boolean = TRUE
                    THEN condition_id IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE)
                    ELSE condition_id NOT IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE)
                  END
                )
              ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
            ),
            aggregated AS (
              SELECT condition_id, outcome,
                COUNT(DISTINCT wallet)::int as distinct_wallets,
                COALESCE(SUM(position_current_value::numeric), 0) as total_val,
                (COUNT(DISTINCT wallet) >= ${thresholds.minWallets}
                  OR COALESCE(SUM(position_current_value::numeric), 0) >= ${thresholds.minTotalValue}) AS qualifies
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
                d.position_current_value, d.position_size, d.position_avg_price, d.fill_price, d.fill_timestamp,
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
                position_current_value, position_size, position_avg_price, fill_price, fill_timestamp,
                trader_name, trader_pseudonym, is_whale, whale_label
              FROM alert_events
              WHERE fill_timestamp >= ${convergenceCutoff}::timestamptz
                AND fill_price <= ${maxOdds}
                AND position_current_value IS NOT NULL
                AND position_current_value >= ${minPosition}
                AND (
                  CASE WHEN ${includeResolved}::boolean = TRUE
                    THEN condition_id IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE)
                    ELSE condition_id NOT IN (SELECT condition_id FROM market_status WHERE market_resolved = TRUE)
                  END
                )
              ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
            ),
            aggregated AS (
              SELECT condition_id, outcome,
                COUNT(DISTINCT wallet)::int as distinct_wallets,
                COALESCE(SUM(position_current_value::numeric), 0) as total_val,
                (COUNT(DISTINCT wallet) >= ${thresholds.minWallets}
                  OR COALESCE(SUM(position_current_value::numeric), 0) >= ${thresholds.minTotalValue}) AS qualifies
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
                d.position_current_value, d.position_size, d.position_avg_price, d.fill_price, d.fill_timestamp,
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
          const fillPrice = parseNumeric(row.fill_price);
          const positionSize = parseNumeric(row.position_size);
          const positionAvgPrice = parseNumeric(row.position_avg_price);
          // Potential win = position_size * (1 - position_avg_price)
          const potentialWin = (positionSize !== null && positionAvgPrice !== null)
            ? positionSize * (1 - positionAvgPrice)
            : null;
          group.wallets.push({
            wallet: row.wallet,
            traderName: row.trader_name || row.trader_pseudonym || 'Anonymous',
            positionValue: posValue,
            positionValueRaw: row.position_current_value,
            positionValueFormatted: formatMoney(posValue),
            fillPrice: fillPrice,
            fillPriceFormatted: formatOdds(fillPrice),
            positionAvgPrice: positionAvgPrice,
            positionAvgPriceFormatted: formatOdds(positionAvgPrice),
            potentialWin: potentialWin,
            potentialWinFormatted: formatMoney(potentialWin),
            latestTimestamp: row.fill_timestamp,
            isWhale: row.is_whale,
            whaleLabel: row.whale_label,
          });
        }
      }
    }

    const allQualifiedGroups = Array.from(groupMap.values());

    // Split into true convergence (2+ wallets) vs large single bets
    const trueConvergence = allQualifiedGroups.filter(g => g.distinctWallets >= 2);
    const largeSingleBets = allQualifiedGroups.filter(g => g.distinctWallets === 1);

    // ========================================================================
    // Phase 7: Archive large single bet positions (fire-and-forget, non-blocking)
    // ========================================================================
    if (LONGSHOT_ARCHIVE_ENABLED && largeSingleBets.length > 0) {
      const snapshots: LongshotSnapshot[] = [];

      for (const bet of largeSingleBets) {
        // Large single bet has exactly 1 wallet
        const wallet = bet.wallets[0];
        if (!wallet) continue;

        // F: Skip if fillPrice is missing (don't default to 0)
        const fillPrice = wallet.fillPrice;
        if (fillPrice === null || fillPrice === undefined) continue;

        const groupKey = `${bet.conditionId}:${bet.outcome}`;
        const latestFillTimestamp = groupTimestampMap.get(groupKey);

        // Use stable timestamp from underlying data, or floor to hour
        const observedAt = latestFillTimestamp
          ? new Date(latestFillTimestamp)
          : floorToHour(new Date());

        snapshots.push({
          wallet: wallet.wallet,
          conditionId: bet.conditionId,
          outcome: bet.outcome,
          fillPrice, // canonical fill price from wallet detail
          posAvgEntry: wallet.positionAvgPrice,
          positionValueUsd: bet.totalPositionValue,
          potentialWinUsd: wallet.potentialWin, // Uses IS NULL check, not falsy
          observedAt,
        });
      }

      // Fire-and-forget: don't await, don't block response
      // Use void prefix to avoid floating promise lint warnings
      if (snapshots.length > 0) {
        void archiveLongshotPositionsBatch(snapshots).catch(() => {});
      }
    }

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
        totalGroups: trueConvergence.length,
        groups: trueConvergence,
      },
      largeSingleBets: {
        totalGroups: largeSingleBets.length,
        groups: largeSingleBets,
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
