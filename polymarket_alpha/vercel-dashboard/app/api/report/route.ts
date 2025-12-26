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

// Phase 10: Position sync overlay feature flag (default: off)
const POSITION_SYNC_ENABLED = process.env.ENABLE_POSITION_SYNC === 'true' || process.env.ENABLE_POSITION_SYNC === '1';

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
  // Latest position size for this wallet/market (for consistent payout display)
  latest_position_size: string | null;
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
  market_finalized_at: string | null; // When P&L finalization ran for this market
  // Phase 8: Final P&L from market_final_pnl (when resolved)
  final_pnl: string | null;
  final_position_found: boolean | null;
  // Phase 9: Estimate metadata
  final_pnl_is_estimated: boolean | null;
  final_pnl_estimate_source: string | null;
  final_pnl_estimate_as_of: string | null;
};

// Phase 11: Position-aggregated row (one per wallet+market+outcome)
// Replaces AlertRow for the main table to eliminate duplicate fills
type PositionRow = {
  // Position key
  wallet: string;
  condition_id: string;
  outcome: string;
  // Market info
  title: string | null;
  slug: string | null;
  event_slug: string | null;
  outcome_index: number | null;
  // Trader info
  trader_name: string | null;
  trader_pseudonym: string | null;
  is_whale: boolean;
  whale_label: string | null;
  whale_tier: string | null;
  whale_category: string | null;
  // Most recent fill info (from alert_events)
  last_fill_price: string | null;
  last_fill_value: string | null;
  last_fill_timestamp: string;
  fill_count: number;
  // Position snapshot (from alert_events - latest fill's position data)
  position_size: string | null;
  position_avg_price: string | null;
  position_current_value: string | null;
  // Cached current price
  cached_price: string | null;
  price_fetched_at: string | null;
  // Market resolution
  market_resolved: boolean | null;
  market_closed: boolean | null;
  winning_outcome: string | null;
  market_finalized_at: string | null;
  // Final P&L
  final_pnl: string | null;
  final_position_found: boolean | null;
  final_pnl_is_estimated: boolean | null;
  final_pnl_estimate_source: string | null;
  final_pnl_estimate_as_of: string | null;
  // Position sync overlay (Phase 10)
  synced_position_size: string | null;
  synced_avg_price: string | null;
  synced_current_value: string | null;
  synced_payout_if_wins: string | null;
  synced_at: string | null;
  sync_status: string | null;
  // Safe state model (Phase 10.1)
  position_state: string | null;
  last_known_position_size: string | null;
  last_known_avg_price: string | null;
  last_known_current_value: string | null;
  last_known_payout_if_wins: string | null;
  last_nonzero_at: string | null;
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
  // Cached price (from LEFT JOIN outcome_price_cache)
  cached_price: string | null;
  // Phase 8: Final P&L
  final_pnl: string | null;
  final_position_found: boolean | null;
  // Phase 9: Estimate metadata
  final_pnl_is_estimated: boolean | null;
  final_pnl_estimate_source: string | null;
  final_pnl_estimate_as_of: string | null;
  // Phase 10: Position sync overlay (from LEFT JOIN position_sync_overlay)
  synced_position_size: string | null;
  synced_avg_price: string | null;
  synced_current_value: string | null;
  synced_payout_if_wins: string | null;
  synced_at: string | null;
  sync_status: string | null;
  // Phase 10.1: Safe state model (preserves last-known values)
  position_state: string | null;
  last_known_position_size: string | null;
  last_known_avg_price: string | null;
  last_known_current_value: string | null;
  last_known_payout_if_wins: string | null;
  last_nonzero_at: string | null;
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
  // Total payout if outcome wins = positionSize (each share pays $1)
  totalPayoutIfWins: number | null;
  totalPayoutIfWinsFormatted: string;
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
  marketFinalizedAt: string | null; // When P&L finalization ran for this market
  // Phase 8: Final P&L from market_final_pnl (when resolved)
  finalPnl: number | null;
  finalPositionFound: boolean | null;
  // Phase 9: Estimate metadata
  finalPnlIsEstimated: boolean | null;
  finalPnlEstimateSource: string | null;
  finalPnlEstimateAsOf: string | null;
}

// Phase 11: Aggregated position (one per wallet+market+outcome)
// Individual fill within a position (for row expansion)
interface PositionFill {
  fillId: string;
  fillTimestamp: string;
  fillPrice: number | null;
  fillPriceFormatted: string;
  fillSize: number | null;
  fillSizeFormatted: string;
  fillValue: number | null;
  fillValueFormatted: string;
}

interface FormattedPosition {
  // Position key (composite ID for React keys)
  positionKey: string;
  wallet: string;
  conditionId: string;
  outcome: string;
  // Market info
  title: string;
  slug: string | null;
  eventSlug: string | null;
  // Trader info
  traderName: string;
  isWhale: boolean;
  whaleLabel: string | null;
  whaleTier: string | null;
  whaleCategory: string | null;
  // Most recent fill (for "Last Fill Price/Value/Time" columns)
  lastFillPrice: number | null;
  lastFillPriceFormatted: string;
  lastFillValue: number | null;
  lastFillValueFormatted: string;
  lastFillTimestamp: string;
  fillCount: number;
  // Position snapshot (aggregated)
  positionSize: number | null;
  positionAvgPrice: number | null;
  positionAvgPriceFormatted: string;
  positionCost: number | null;
  positionCostFormatted: string;
  positionValue: number | null;
  positionValueFormatted: string;
  totalPayoutIfWins: number | null;
  totalPayoutIfWinsFormatted: string;
  // Current price
  currentPrice: number | null;
  currentPriceFormatted: string;
  priceStatus: PriceStatus;
  priceFetchedAt: string | null;
  // Market resolution
  marketResolved: boolean;
  marketClosed: boolean;
  winningOutcome: string | null;
  marketFinalizedAt: string | null;
  // Final P&L
  finalPnl: number | null;
  finalPositionFound: boolean | null;
  finalPnlIsEstimated: boolean | null;
  finalPnlEstimateSource: string | null;
  finalPnlEstimateAsOf: string | null;
  // Position sync overlay (Phase 10)
  syncedPositionSize: number | null;
  syncedAvgPrice: number | null;
  syncedCurrentValue: number | null;
  syncedPayoutIfWins: number | null;
  syncedPositionCost: number | null;
  syncedPositionCostFormatted: string;
  syncedCurrentValueFormatted: string;
  syncedPayoutIfWinsFormatted: string;
  syncedAt: string | null;
  syncStatus: string | null;
  // Safe state model (Phase 10.1)
  positionState: string | null;
  lastKnownPositionSize: number | null;
  lastKnownAvgPrice: number | null;
  lastKnownCurrentValue: number | null;
  lastKnownPayoutIfWins: number | null;
  lastKnownPositionCost: number | null;
  lastKnownPositionCostFormatted: string;
  lastKnownCurrentValueFormatted: string;
  lastKnownPayoutIfWinsFormatted: string;
  lastNonzeroAt: string | null;
  // Underlying fills for row expansion
  fills: PositionFill[];
}

interface WalletDetail {
  wallet: string;
  traderName: string;
  positionSize: number | null;
  // Cost basis = positionSize × positionAvgPrice
  positionCost: number | null;
  positionCostFormatted: string;
  // Mark-to-market value = positionSize × currentPrice (null if currentPrice missing)
  positionValue: number | null;
  positionValueFormatted: string;
  fillPrice: number | null;
  fillPriceFormatted: string;
  positionAvgPrice: number | null;
  positionAvgPriceFormatted: string;
  // Total payout if outcome wins = positionSize (each share pays $1)
  totalPayoutIfWins: number | null;
  totalPayoutIfWinsFormatted: string;
  latestTimestamp: string;
  isWhale: boolean;
  whaleLabel: string | null;
  // Cached current price
  currentPrice: number | null;
  // Phase 8: Final P&L
  finalPnl: number | null;
  finalPositionFound: boolean | null;
  // Phase 9: Estimate metadata
  finalPnlIsEstimated: boolean | null;
  finalPnlEstimateSource: string | null;
  finalPnlEstimateAsOf: string | null;
  // Phase 10: Position sync overlay (when ENABLE_POSITION_SYNC=true)
  syncedPositionSize: number | null;
  syncedAvgPrice: number | null;
  syncedCurrentValue: number | null;
  syncedPayoutIfWins: number | null;
  // Computed synced cost = syncedPositionSize × syncedAvgPrice
  syncedPositionCost: number | null;
  syncedPositionCostFormatted: string;
  syncedCurrentValueFormatted: string;
  syncedPayoutIfWinsFormatted: string;
  syncedAt: string | null;
  syncStatus: string | null; // 'synced' | 'not_found' | null
  // Phase 10.1: Safe state model (preserves last-known values when sync returns empty)
  positionState: string | null; // 'open' | 'not_found_in_sync' | 'closed_confirmed' | 'redeemed_confirmed' | 'unknown'
  lastKnownPositionSize: number | null;
  lastKnownAvgPrice: number | null;
  lastKnownCurrentValue: number | null;
  lastKnownPayoutIfWins: number | null;
  lastKnownPositionCost: number | null;
  lastKnownPositionCostFormatted: string;
  lastKnownCurrentValueFormatted: string;
  lastKnownPayoutIfWinsFormatted: string;
  lastNonzeroAt: string | null;
}

interface ConvergenceGroup {
  conditionId: string;
  outcome: string;
  title: string;
  slug: string | null;
  eventSlug: string | null;
  distinctWallets: number;
  // Cost = sum(positionSize × positionAvgPrice) across wallets
  totalCost: number;
  totalCostFormatted: string;
  // Value = sum(positionSize × currentPrice) across wallets; null if any wallet missing price
  totalValue: number | null;
  totalValueFormatted: string;
  // Payout if outcome wins = sum(positionSize) across wallets; null if any wallet missing size
  totalPayoutIfWins: number | null;
  totalPayoutIfWinsFormatted: string;
  minOdds: number | null;
  maxOdds: number | null;
  oddsRangeFormatted: string;
  qualifies: boolean;
  wallets: WalletDetail[];
  // Phase 6: Market resolution fields
  marketResolved: boolean;
  winningOutcome: string | null;
  marketFinalizedAt: string | null;
}

// ============================================================================
// Formatting helpers
// ============================================================================

function formatMoney(value: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  if (Math.abs(value) >= 1000000) {
    return `$${(value / 1000000).toFixed(2)}M`;
  }
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
    const excludeCategory = (searchParams.get('excludeCategory') ?? '').trim().toLowerCase() || null;
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
          WITH latest_positions AS (
            SELECT DISTINCT ON (condition_id, outcome, wallet)
              condition_id, outcome, wallet, position_size as latest_position_size
            FROM alert_events
            WHERE fill_timestamp >= ${alertCutoff}::timestamptz
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          )
          SELECT ae.id, ae.fill_timestamp, ae.wallet, ae.trader_name, ae.trader_pseudonym,
            ae.title, ae.slug, ae.event_slug, ae.outcome, ae.condition_id, ae.outcome_index,
            ae.fill_price, ae.fill_size, ae.fill_value_usd,
            ae.position_current_value, ae.position_avg_price, ae.position_size,
            lp.latest_position_size,
            ae.is_whale, ae.whale_label, ae.whale_tier, ae.whale_category,
            opc.price::text as cached_price, opc.fetched_at::text as price_fetched_at,
            ms.market_resolved, ms.market_closed, ms.winning_outcome, ms.finalized_at as market_finalized_at,
            mfp.final_pnl::text as final_pnl,
            mfp.position_found as final_position_found,
            mfp.is_estimated as final_pnl_is_estimated,
            mfp.estimate_source as final_pnl_estimate_source,
            mfp.estimate_as_of::text as final_pnl_estimate_as_of
          FROM alert_events ae
          LEFT JOIN latest_positions lp ON ae.condition_id = lp.condition_id AND ae.outcome = lp.outcome AND ae.wallet = lp.wallet
          LEFT JOIN outcome_price_cache opc ON ae.condition_id = opc.condition_id AND ae.outcome = opc.outcome
          LEFT JOIN market_status ms ON ae.condition_id = ms.condition_id
          LEFT JOIN market_final_pnl mfp ON ae.condition_id = mfp.condition_id AND ae.wallet = mfp.wallet AND ae.outcome = mfp.outcome
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
          WITH latest_positions AS (
            SELECT DISTINCT ON (condition_id, outcome, wallet)
              condition_id, outcome, wallet, position_size as latest_position_size
            FROM alert_events
            WHERE fill_timestamp >= ${alertCutoff}::timestamptz
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          )
          SELECT ae.id, ae.fill_timestamp, ae.wallet, ae.trader_name, ae.trader_pseudonym,
            ae.title, ae.slug, ae.event_slug, ae.outcome, ae.condition_id, ae.outcome_index,
            ae.fill_price, ae.fill_size, ae.fill_value_usd,
            ae.position_current_value, ae.position_avg_price, ae.position_size,
            lp.latest_position_size,
            ae.is_whale, ae.whale_label, ae.whale_tier, ae.whale_category,
            opc.price::text as cached_price, opc.fetched_at::text as price_fetched_at,
            ms.market_resolved, ms.market_closed, ms.winning_outcome, ms.finalized_at as market_finalized_at,
            mfp.final_pnl::text as final_pnl,
            mfp.position_found as final_position_found,
            mfp.is_estimated as final_pnl_is_estimated,
            mfp.estimate_source as final_pnl_estimate_source,
            mfp.estimate_as_of::text as final_pnl_estimate_as_of
          FROM alert_events ae
          LEFT JOIN latest_positions lp ON ae.condition_id = lp.condition_id AND ae.outcome = lp.outcome AND ae.wallet = lp.wallet
          LEFT JOIN outcome_price_cache opc ON ae.condition_id = opc.condition_id AND ae.outcome = opc.outcome
          LEFT JOIN market_status ms ON ae.condition_id = ms.condition_id
          LEFT JOIN market_final_pnl mfp ON ae.condition_id = mfp.condition_id AND ae.wallet = mfp.wallet AND ae.outcome = mfp.outcome
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
          WITH latest_positions AS (
            SELECT DISTINCT ON (condition_id, outcome, wallet)
              condition_id, outcome, wallet, position_size as latest_position_size
            FROM alert_events
            WHERE fill_timestamp >= ${alertCutoff}::timestamptz
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          )
          SELECT ae.id, ae.fill_timestamp, ae.wallet, ae.trader_name, ae.trader_pseudonym,
            ae.title, ae.slug, ae.event_slug, ae.outcome, ae.condition_id, ae.outcome_index,
            ae.fill_price, ae.fill_size, ae.fill_value_usd,
            ae.position_current_value, ae.position_avg_price, ae.position_size,
            lp.latest_position_size,
            ae.is_whale, ae.whale_label, ae.whale_tier, ae.whale_category,
            opc.price::text as cached_price, opc.fetched_at::text as price_fetched_at,
            ms.market_resolved, ms.market_closed, ms.winning_outcome, ms.finalized_at as market_finalized_at,
            mfp.final_pnl::text as final_pnl,
            mfp.position_found as final_position_found,
            mfp.is_estimated as final_pnl_is_estimated,
            mfp.estimate_source as final_pnl_estimate_source,
            mfp.estimate_as_of::text as final_pnl_estimate_as_of
          FROM alert_events ae
          LEFT JOIN latest_positions lp ON ae.condition_id = lp.condition_id AND ae.outcome = lp.outcome AND ae.wallet = lp.wallet
          LEFT JOIN outcome_price_cache opc ON ae.condition_id = opc.condition_id AND ae.outcome = opc.outcome
          LEFT JOIN market_status ms ON ae.condition_id = ms.condition_id
          LEFT JOIN market_final_pnl mfp ON ae.condition_id = mfp.condition_id AND ae.wallet = mfp.wallet AND ae.outcome = mfp.outcome
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
          WITH latest_positions AS (
            SELECT DISTINCT ON (condition_id, outcome, wallet)
              condition_id, outcome, wallet, position_size as latest_position_size
            FROM alert_events
            WHERE fill_timestamp >= ${alertCutoff}::timestamptz
            ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
          )
          SELECT ae.id, ae.fill_timestamp, ae.wallet, ae.trader_name, ae.trader_pseudonym,
            ae.title, ae.slug, ae.event_slug, ae.outcome, ae.condition_id, ae.outcome_index,
            ae.fill_price, ae.fill_size, ae.fill_value_usd,
            ae.position_current_value, ae.position_avg_price, ae.position_size,
            lp.latest_position_size,
            ae.is_whale, ae.whale_label, ae.whale_tier, ae.whale_category,
            opc.price::text as cached_price, opc.fetched_at::text as price_fetched_at,
            ms.market_resolved, ms.market_closed, ms.winning_outcome, ms.finalized_at as market_finalized_at,
            mfp.final_pnl::text as final_pnl,
            mfp.position_found as final_position_found,
            mfp.is_estimated as final_pnl_is_estimated,
            mfp.estimate_source as final_pnl_estimate_source,
            mfp.estimate_as_of::text as final_pnl_estimate_as_of
          FROM alert_events ae
          LEFT JOIN latest_positions lp ON ae.condition_id = lp.condition_id AND ae.outcome = lp.outcome AND ae.wallet = lp.wallet
          LEFT JOIN outcome_price_cache opc ON ae.condition_id = opc.condition_id AND ae.outcome = opc.outcome
          LEFT JOIN market_status ms ON ae.condition_id = ms.condition_id
          LEFT JOIN market_final_pnl mfp ON ae.condition_id = mfp.condition_id AND ae.wallet = mfp.wallet AND ae.outcome = mfp.outcome
          WHERE ae.fill_timestamp >= ${alertCutoff}::timestamptz
            AND ae.fill_price <= ${maxOdds}
            AND ae.position_current_value IS NOT NULL
            AND ae.position_current_value >= ${minPosition}
            AND (
              ${excludeCategory}::text IS NULL
              OR ${excludeCategory} != 'crypto'
              OR (
                ae.whale_category IS DISTINCT FROM 'crypto'
                AND ae.title NOT ILIKE '%bitcoin%'
                AND ae.title NOT ILIKE '%btc%'
                AND ae.title NOT ILIKE '%ethereum%'
                AND ae.title NOT ILIKE '%eth %'
                AND ae.title NOT ILIKE '%solana%'
                AND ae.title NOT ILIKE '%sol %'
                AND ae.title NOT ILIKE '%crypto%'
                AND ae.title NOT ILIKE '%token%'
                AND ae.title NOT ILIKE '%market cap%'
                AND ae.title NOT ILIKE '%fdv%'
                AND ae.title NOT ILIKE '%defi%'
              )
            )
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
      const latestPositionSize = parseNumeric(row.latest_position_size);
      const cachedPrice = parseNumeric(row.cached_price);

      // Total payout if outcome wins = latest position size for this wallet/market
      // This ensures all trades from the same wallet in the same market show the same payout
      const totalPayoutIfWins = latestPositionSize ?? positionSize;

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
        totalPayoutIfWins,
        totalPayoutIfWinsFormatted: formatMoney(totalPayoutIfWins),
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
        marketFinalizedAt: row.market_finalized_at ?? null,
        // Phase 8: Final P&L from market_final_pnl (when resolved)
        finalPnl: row.final_pnl !== null ? parseFloat(row.final_pnl) : null,
        finalPositionFound: row.final_position_found ?? null,
        // Phase 9: Estimate metadata
        finalPnlIsEstimated: row.final_pnl_is_estimated ?? null,
        finalPnlEstimateSource: row.final_pnl_estimate_source ?? null,
        finalPnlEstimateAsOf: row.final_pnl_estimate_as_of ?? null,
      };
    });

    // ========================================================================
    // Query 1b: Aggregated positions (Phase 11)
    // One row per (wallet, condition_id, outcome) with fill count
    // Uses 'none' filter mode only (default) - aggregation ignores whale/category filters
    // for simplicity; the frontend filters the resulting positions
    // ========================================================================

    const positionsResult = await sql<PositionRow>`
      WITH fill_counts AS (
        SELECT wallet, condition_id, outcome, COUNT(*)::int as fill_count
        FROM alert_events
        WHERE fill_timestamp >= ${alertCutoff}::timestamptz
          AND fill_price <= ${maxOdds}
          AND position_current_value IS NOT NULL
          AND position_current_value >= ${minPosition}
          AND (
            ${excludeCategory}::text IS NULL
            OR ${excludeCategory} != 'crypto'
            OR (
              whale_category IS DISTINCT FROM 'crypto'
              AND title NOT ILIKE '%bitcoin%'
              AND title NOT ILIKE '%btc%'
              AND title NOT ILIKE '%ethereum%'
              AND title NOT ILIKE '%eth %'
              AND title NOT ILIKE '%solana%'
              AND title NOT ILIKE '%sol %'
              AND title NOT ILIKE '%crypto%'
              AND title NOT ILIKE '%token%'
              AND title NOT ILIKE '%market cap%'
              AND title NOT ILIKE '%fdv%'
              AND title NOT ILIKE '%defi%'
            )
          )
        GROUP BY wallet, condition_id, outcome
      ),
      latest_fills AS (
        SELECT DISTINCT ON (ae.wallet, ae.condition_id, ae.outcome)
          ae.wallet, ae.condition_id, ae.outcome,
          ae.title, ae.slug, ae.event_slug, ae.outcome_index,
          ae.trader_name, ae.trader_pseudonym,
          ae.is_whale, ae.whale_label, ae.whale_tier, ae.whale_category,
          ae.fill_price as last_fill_price,
          ae.fill_value_usd as last_fill_value,
          ae.fill_timestamp as last_fill_timestamp,
          ae.position_size, ae.position_avg_price, ae.position_current_value
        FROM alert_events ae
        WHERE ae.fill_timestamp >= ${alertCutoff}::timestamptz
          AND ae.fill_price <= ${maxOdds}
          AND ae.position_current_value IS NOT NULL
          AND ae.position_current_value >= ${minPosition}
          AND (
            ${excludeCategory}::text IS NULL
            OR ${excludeCategory} != 'crypto'
            OR (
              ae.whale_category IS DISTINCT FROM 'crypto'
              AND ae.title NOT ILIKE '%bitcoin%'
              AND ae.title NOT ILIKE '%btc%'
              AND ae.title NOT ILIKE '%ethereum%'
              AND ae.title NOT ILIKE '%eth %'
              AND ae.title NOT ILIKE '%solana%'
              AND ae.title NOT ILIKE '%sol %'
              AND ae.title NOT ILIKE '%crypto%'
              AND ae.title NOT ILIKE '%token%'
              AND ae.title NOT ILIKE '%market cap%'
              AND ae.title NOT ILIKE '%fdv%'
              AND ae.title NOT ILIKE '%defi%'
            )
          )
        ORDER BY ae.wallet, ae.condition_id, ae.outcome, ae.fill_timestamp DESC
      )
      SELECT
        lf.wallet, lf.condition_id, lf.outcome,
        lf.title, lf.slug, lf.event_slug, lf.outcome_index,
        lf.trader_name, lf.trader_pseudonym,
        lf.is_whale, lf.whale_label, lf.whale_tier, lf.whale_category,
        lf.last_fill_price::text as last_fill_price,
        lf.last_fill_value::text as last_fill_value,
        lf.last_fill_timestamp,
        fc.fill_count,
        lf.position_size::text as position_size,
        lf.position_avg_price::text as position_avg_price,
        lf.position_current_value::text as position_current_value,
        opc.price::text as cached_price,
        opc.fetched_at::text as price_fetched_at,
        ms.market_resolved, ms.market_closed, ms.winning_outcome,
        ms.finalized_at::text as market_finalized_at,
        mfp.final_pnl::text as final_pnl,
        mfp.position_found as final_position_found,
        mfp.is_estimated as final_pnl_is_estimated,
        mfp.estimate_source as final_pnl_estimate_source,
        mfp.estimate_as_of::text as final_pnl_estimate_as_of,
        pso.synced_position_size::text as synced_position_size,
        pso.synced_avg_price::text as synced_avg_price,
        pso.synced_current_value::text as synced_current_value,
        pso.synced_payout_if_wins::text as synced_payout_if_wins,
        pso.synced_at::text as synced_at,
        pso.sync_status,
        pso.position_state,
        pso.last_known_position_size::text as last_known_position_size,
        pso.last_known_avg_price::text as last_known_avg_price,
        pso.last_known_current_value::text as last_known_current_value,
        pso.last_known_payout_if_wins::text as last_known_payout_if_wins,
        pso.last_nonzero_at::text as last_nonzero_at
      FROM latest_fills lf
      INNER JOIN fill_counts fc ON lf.wallet = fc.wallet AND lf.condition_id = fc.condition_id AND lf.outcome = fc.outcome
      LEFT JOIN outcome_price_cache opc ON lf.condition_id = opc.condition_id AND lf.outcome = opc.outcome
      LEFT JOIN market_status ms ON lf.condition_id = ms.condition_id
      LEFT JOIN market_final_pnl mfp ON lf.condition_id = mfp.condition_id AND lf.wallet = mfp.wallet AND lf.outcome = mfp.outcome
      LEFT JOIN position_sync_overlay pso ON lf.condition_id = pso.condition_id AND lf.wallet = pso.wallet AND lf.outcome = pso.outcome
      WHERE (
        CASE WHEN ${includeResolved}::boolean = TRUE
          THEN ms.market_resolved = TRUE AND ms.winning_outcome IS NOT NULL AND TRIM(ms.winning_outcome) != ''
          ELSE ms.market_resolved IS NOT TRUE OR ms.winning_outcome IS NULL OR TRIM(ms.winning_outcome) = ''
        END
      )
      ORDER BY lf.last_fill_timestamp DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `;

    // Helper: consistent position key format (used for positionKey and fills grouping)
    const makePositionKey = (wallet: string, conditionId: string, outcome: string) =>
      `${wallet}:${conditionId}:${outcome}`;

    // Format positions
    const formattedPositions: FormattedPosition[] = positionsResult.rows.map((row) => {
      const lastFillPrice = parseNumeric(row.last_fill_price);
      const lastFillValue = parseNumeric(row.last_fill_value);
      const positionSize = parseNumeric(row.position_size);
      const positionAvgPrice = parseNumeric(row.position_avg_price);
      const cachedPrice = parseNumeric(row.cached_price);

      // Cost = shares × avgEntry
      const positionCost = (positionSize !== null && positionAvgPrice !== null)
        ? positionSize * positionAvgPrice
        : null;

      // Value = shares × currentPrice
      const positionValue = (positionSize !== null && cachedPrice !== null)
        ? positionSize * cachedPrice
        : null;

      // Payout = shares (each share pays $1)
      const totalPayoutIfWins = positionSize;

      // Position sync overlay
      const syncedPositionSize = parseNumeric(row.synced_position_size);
      const syncedAvgPrice = parseNumeric(row.synced_avg_price);
      const syncedCurrentValue = parseNumeric(row.synced_current_value);
      const syncedPayoutIfWins = parseNumeric(row.synced_payout_if_wins);
      const syncedPositionCost = (syncedPositionSize !== null && syncedAvgPrice !== null)
        ? syncedPositionSize * syncedAvgPrice
        : null;

      // Safe state model
      const lastKnownPositionSize = parseNumeric(row.last_known_position_size);
      const lastKnownAvgPrice = parseNumeric(row.last_known_avg_price);
      const lastKnownCurrentValue = parseNumeric(row.last_known_current_value);
      const lastKnownPayoutIfWins = parseNumeric(row.last_known_payout_if_wins);
      const lastKnownPositionCost = (lastKnownPositionSize !== null && lastKnownAvgPrice !== null)
        ? lastKnownPositionSize * lastKnownAvgPrice
        : null;

      return {
        positionKey: makePositionKey(row.wallet, row.condition_id, row.outcome),
        wallet: row.wallet,
        conditionId: row.condition_id,
        outcome: row.outcome,
        title: row.title || row.slug || row.event_slug || row.condition_id,
        slug: row.slug,
        eventSlug: row.event_slug,
        traderName: row.trader_name || row.trader_pseudonym || 'Anonymous',
        isWhale: row.is_whale,
        whaleLabel: row.whale_label,
        whaleTier: row.whale_tier,
        whaleCategory: row.whale_category,
        lastFillPrice,
        lastFillPriceFormatted: formatOdds(lastFillPrice),
        lastFillValue,
        lastFillValueFormatted: formatMoney(lastFillValue),
        lastFillTimestamp: row.last_fill_timestamp,
        fillCount: row.fill_count,
        positionSize,
        positionAvgPrice,
        positionAvgPriceFormatted: formatOdds(positionAvgPrice),
        positionCost,
        positionCostFormatted: positionCost !== null ? formatMoney(positionCost) : '—',
        positionValue,
        positionValueFormatted: positionValue !== null ? formatMoney(positionValue) : '—',
        totalPayoutIfWins,
        totalPayoutIfWinsFormatted: totalPayoutIfWins !== null ? formatMoney(totalPayoutIfWins) : '—',
        currentPrice: cachedPrice,
        currentPriceFormatted: cachedPrice !== null ? formatOdds(cachedPrice) : 'N/A',
        priceStatus: getPriceStatus(row.price_fetched_at),
        priceFetchedAt: row.price_fetched_at,
        marketResolved: row.market_resolved ?? false,
        marketClosed: row.market_closed ?? false,
        winningOutcome: row.winning_outcome ?? null,
        marketFinalizedAt: row.market_finalized_at ?? null,
        finalPnl: row.final_pnl !== null ? parseFloat(row.final_pnl) : null,
        finalPositionFound: row.final_position_found ?? null,
        finalPnlIsEstimated: row.final_pnl_is_estimated ?? null,
        finalPnlEstimateSource: row.final_pnl_estimate_source ?? null,
        finalPnlEstimateAsOf: row.final_pnl_estimate_as_of ?? null,
        syncedPositionSize,
        syncedAvgPrice,
        syncedCurrentValue,
        syncedPayoutIfWins,
        syncedPositionCost,
        syncedPositionCostFormatted: syncedPositionCost !== null ? formatMoney(syncedPositionCost) : '—',
        syncedCurrentValueFormatted: syncedCurrentValue !== null ? formatMoney(syncedCurrentValue) : '—',
        syncedPayoutIfWinsFormatted: syncedPayoutIfWins !== null ? formatMoney(syncedPayoutIfWins) : '—',
        syncedAt: row.synced_at ?? null,
        syncStatus: row.sync_status ?? null,
        positionState: row.position_state ?? null,
        lastKnownPositionSize,
        lastKnownAvgPrice,
        lastKnownCurrentValue,
        lastKnownPayoutIfWins,
        lastKnownPositionCost,
        lastKnownPositionCostFormatted: lastKnownPositionCost !== null ? formatMoney(lastKnownPositionCost) : '—',
        lastKnownCurrentValueFormatted: lastKnownCurrentValue !== null ? formatMoney(lastKnownCurrentValue) : '—',
        lastKnownPayoutIfWinsFormatted: lastKnownPayoutIfWins !== null ? formatMoney(lastKnownPayoutIfWins) : '—',
        lastNonzeroAt: row.last_nonzero_at ?? null,
        fills: [], // Will be populated below
      };
    });

    // ========================================================================
    // Query 1c: Fetch fills for positions on this page (for row expansion)
    // ========================================================================

    type FillRow = {
      id: string;
      wallet: string;
      condition_id: string;
      outcome: string;
      fill_timestamp: string;
      fill_price: string | null;
      fill_size: string | null;
      fill_value_usd: string | null;
    };

    // Only fetch fills for expandable positions (fillCount > 1)
    // Single-fill positions don't need expansion data
    const expandablePositions = formattedPositions.filter(p => p.fillCount > 1);

    if (expandablePositions.length > 0) {
      // Build JSON array of objects for recordset join (index-friendly)
      const positionKeysJson = JSON.stringify(
        expandablePositions.map(p => ({
          wallet: p.wallet,
          condition_id: p.conditionId,
          outcome: p.outcome
        }))
      );

      // Query fills using JSON recordset join instead of string concatenation
      // This allows Postgres to use indexes on (wallet, condition_id, outcome)
      const fillsResult = await sql<FillRow>`
        WITH keys AS (
          SELECT DISTINCT wallet, condition_id, outcome
          FROM jsonb_to_recordset(${positionKeysJson}::jsonb)
            AS k(wallet text, condition_id text, outcome text)
        )
        SELECT
          ae.id,
          ae.wallet,
          ae.condition_id,
          ae.outcome,
          ae.fill_timestamp,
          ae.fill_price::text as fill_price,
          ae.fill_size::text as fill_size,
          ae.fill_value_usd::text as fill_value_usd
        FROM alert_events ae
        INNER JOIN keys k
          ON ae.wallet = k.wallet
          AND ae.condition_id = k.condition_id
          AND ae.outcome = k.outcome
        WHERE ae.fill_timestamp >= ${alertCutoff}::timestamptz
          AND ae.fill_price <= ${maxOdds}
          AND ae.position_current_value IS NOT NULL
          AND ae.position_current_value >= ${minPosition}
        ORDER BY ae.fill_timestamp DESC, ae.id DESC
      `;

      // Group fills by position key using consistent helper
      const fillsByPosition = new Map<string, PositionFill[]>();
      for (const fill of fillsResult.rows) {
        const key = makePositionKey(fill.wallet, fill.condition_id, fill.outcome);
        const fillPrice = parseNumeric(fill.fill_price);
        const fillSize = parseNumeric(fill.fill_size);
        const fillValue = parseNumeric(fill.fill_value_usd);

        const formattedFill: PositionFill = {
          fillId: fill.id,
          fillTimestamp: fill.fill_timestamp,
          fillPrice,
          fillPriceFormatted: formatOdds(fillPrice),
          fillSize,
          fillSizeFormatted: fillSize !== null ? fillSize.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—',
          fillValue,
          fillValueFormatted: formatMoney(fillValue),
        };

        if (!fillsByPosition.has(key)) {
          fillsByPosition.set(key, []);
        }
        fillsByPosition.get(key)!.push(formattedFill);
      }

      // Attach fills to positions (positionKey uses same format as makePositionKey)
      for (const position of expandablePositions) {
        const fills = fillsByPosition.get(position.positionKey);
        if (fills) {
          position.fills = fills;
        }
      }
    }

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
            AND (
              ${excludeCategory}::text IS NULL
              OR ${excludeCategory} != 'crypto'
              OR (
                whale_category IS DISTINCT FROM 'crypto'
                AND title NOT ILIKE '%bitcoin%'
                AND title NOT ILIKE '%btc%'
                AND title NOT ILIKE '%ethereum%'
                AND title NOT ILIKE '%eth %'
                AND title NOT ILIKE '%solana%'
                AND title NOT ILIKE '%sol %'
                AND title NOT ILIKE '%crypto%'
                AND title NOT ILIKE '%token%'
                AND title NOT ILIKE '%market cap%'
                AND title NOT ILIKE '%fdv%'
                AND title NOT ILIKE '%defi%'
              )
            )
        `;
    }

    const summary = summaryResult.rows[0] || { total: 0, whale_count: 0, unique_wallets: 0 };
    const totalAlerts = summary.total;

    // ========================================================================
    // Query 2b: Total positions count (for pagination)
    // Uses same filters as Query 1b (excludeCategory only, no whale/category filters)
    // ========================================================================

    const totalPositionsResult = await sql<{ count: number }>`
      WITH position_keys AS (
        SELECT DISTINCT wallet, condition_id, outcome
        FROM alert_events ae
        LEFT JOIN market_status ms ON ae.condition_id = ms.condition_id
        WHERE ae.fill_timestamp >= ${alertCutoff}::timestamptz
          AND ae.fill_price <= ${maxOdds}
          AND ae.position_current_value IS NOT NULL
          AND ae.position_current_value >= ${minPosition}
          AND (
            ${excludeCategory}::text IS NULL
            OR ${excludeCategory} != 'crypto'
            OR (
              ae.whale_category IS DISTINCT FROM 'crypto'
              AND ae.title NOT ILIKE '%bitcoin%'
              AND ae.title NOT ILIKE '%btc%'
              AND ae.title NOT ILIKE '%ethereum%'
              AND ae.title NOT ILIKE '%eth %'
              AND ae.title NOT ILIKE '%solana%'
              AND ae.title NOT ILIKE '%sol %'
              AND ae.title NOT ILIKE '%crypto%'
              AND ae.title NOT ILIKE '%token%'
              AND ae.title NOT ILIKE '%market cap%'
              AND ae.title NOT ILIKE '%fdv%'
              AND ae.title NOT ILIKE '%defi%'
            )
          )
          AND (
            CASE WHEN ${includeResolved}::boolean = TRUE
              THEN ms.market_resolved = TRUE AND ms.winning_outcome IS NOT NULL AND TRIM(ms.winning_outcome) != ''
              ELSE ms.market_resolved IS NOT TRUE OR ms.winning_outcome IS NULL OR TRIM(ms.winning_outcome) = ''
            END
          )
      )
      SELECT COUNT(*)::int as count FROM position_keys
    `;

    const totalPositions = totalPositionsResult.rows[0]?.count ?? 0;

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
                ${excludeCategory}::text IS NULL
                OR ${excludeCategory} != 'crypto'
                OR (
                  whale_category IS DISTINCT FROM 'crypto'
                  AND title NOT ILIKE '%bitcoin%'
                  AND title NOT ILIKE '%btc%'
                  AND title NOT ILIKE '%ethereum%'
                  AND title NOT ILIKE '%eth %'
                  AND title NOT ILIKE '%solana%'
                  AND title NOT ILIKE '%sol %'
                  AND title NOT ILIKE '%crypto%'
                  AND title NOT ILIKE '%token%'
                  AND title NOT ILIKE '%market cap%'
                  AND title NOT ILIKE '%fdv%'
                  AND title NOT ILIKE '%defi%'
                )
              )
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
                ${excludeCategory}::text IS NULL
                OR ${excludeCategory} != 'crypto'
                OR (
                  whale_category IS DISTINCT FROM 'crypto'
                  AND title NOT ILIKE '%bitcoin%'
                  AND title NOT ILIKE '%btc%'
                  AND title NOT ILIKE '%ethereum%'
                  AND title NOT ILIKE '%eth %'
                  AND title NOT ILIKE '%solana%'
                  AND title NOT ILIKE '%sol %'
                  AND title NOT ILIKE '%crypto%'
                  AND title NOT ILIKE '%token%'
                  AND title NOT ILIKE '%market cap%'
                  AND title NOT ILIKE '%fdv%'
                  AND title NOT ILIKE '%defi%'
                )
              )
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
        // Placeholder totals - will be computed from wallet details below
        totalCost: 0,
        totalCostFormatted: '$0',
        totalValue: null,
        totalValueFormatted: '—',
        totalPayoutIfWins: null,
        totalPayoutIfWinsFormatted: '—',
        minOdds,
        maxOdds,
        oddsRangeFormatted,
        qualifies: row.qualifies,
        wallets: [],
        // Will be enriched below
        marketResolved: false,
        winningOutcome: null,
        marketFinalizedAt: null,
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
        const conditionIds = Array.from(conditionIdSet);

        // Query resolution status for the specific condition IDs in our groups
        // Pass array as JSON and unnest for efficient matching
        const conditionIdsJson = JSON.stringify(conditionIds);
        const resolutionResult = await sql<{ condition_id: string; market_resolved: boolean; winning_outcome: string | null; finalized_at: string | null }>`
          SELECT ms.condition_id, ms.market_resolved, ms.winning_outcome, ms.finalized_at
          FROM market_status ms
          WHERE ms.condition_id IN (
            SELECT jsonb_array_elements_text(${conditionIdsJson}::jsonb)
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
            group.marketFinalizedAt = status.finalized_at ?? null;
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
              FROM alert_events ae
              WHERE ae.fill_timestamp >= ${convergenceCutoff}::timestamptz
                AND ae.fill_price <= ${maxOdds}
                AND ae.position_current_value IS NOT NULL
                AND ae.position_current_value >= ${minPosition}
                AND ae.is_whale = TRUE
                AND ae.whale_category = ${category}
                AND (
                  CASE WHEN ${includeResolved}::boolean = TRUE
                    THEN EXISTS (SELECT 1 FROM market_status ms2 WHERE ms2.condition_id = ae.condition_id AND ms2.market_resolved = TRUE AND ms2.winning_outcome IS NOT NULL AND TRIM(ms2.winning_outcome) != '')
                    ELSE NOT EXISTS (SELECT 1 FROM market_status ms2 WHERE ms2.condition_id = ae.condition_id AND ms2.market_resolved = TRUE AND ms2.winning_outcome IS NOT NULL AND TRIM(ms2.winning_outcome) != '')
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
                opc.price::text as cached_price,
                mfp.final_pnl, mfp.position_found as final_position_found,
                mfp.is_estimated as final_pnl_is_estimated,
                mfp.estimate_source as final_pnl_estimate_source,
                mfp.estimate_as_of::text as final_pnl_estimate_as_of,
                pso.synced_position_size::text as synced_position_size,
                pso.synced_avg_price::text as synced_avg_price,
                pso.synced_current_value::text as synced_current_value,
                pso.synced_payout_if_wins::text as synced_payout_if_wins,
                pso.synced_at::text as synced_at,
                pso.sync_status as sync_status,
                pso.position_state as position_state,
                pso.last_known_position_size::text as last_known_position_size,
                pso.last_known_avg_price::text as last_known_avg_price,
                pso.last_known_current_value::text as last_known_current_value,
                pso.last_known_payout_if_wins::text as last_known_payout_if_wins,
                pso.last_nonzero_at::text as last_nonzero_at,
                ROW_NUMBER() OVER (PARTITION BY d.condition_id, d.outcome
                  ORDER BY d.position_current_value::numeric DESC, d.wallet ASC)::int as rn
              FROM deduped d
              INNER JOIN group_keys g ON d.condition_id = g.condition_id AND d.outcome = g.outcome
              LEFT JOIN outcome_price_cache opc ON opc.condition_id = d.condition_id AND opc.outcome = d.outcome
              LEFT JOIN market_final_pnl mfp ON mfp.condition_id = d.condition_id AND mfp.wallet = d.wallet AND mfp.outcome = d.outcome
              LEFT JOIN position_sync_overlay pso ON pso.condition_id = d.condition_id AND pso.wallet = d.wallet AND pso.outcome = d.outcome
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
              FROM alert_events ae
              WHERE ae.fill_timestamp >= ${convergenceCutoff}::timestamptz
                AND ae.fill_price <= ${maxOdds}
                AND ae.position_current_value IS NOT NULL
                AND ae.position_current_value >= ${minPosition}
                AND ae.is_whale = TRUE
                AND (
                  CASE WHEN ${includeResolved}::boolean = TRUE
                    THEN EXISTS (SELECT 1 FROM market_status ms2 WHERE ms2.condition_id = ae.condition_id AND ms2.market_resolved = TRUE AND ms2.winning_outcome IS NOT NULL AND TRIM(ms2.winning_outcome) != '')
                    ELSE NOT EXISTS (SELECT 1 FROM market_status ms2 WHERE ms2.condition_id = ae.condition_id AND ms2.market_resolved = TRUE AND ms2.winning_outcome IS NOT NULL AND TRIM(ms2.winning_outcome) != '')
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
                opc.price::text as cached_price,
                mfp.final_pnl, mfp.position_found as final_position_found,
                mfp.is_estimated as final_pnl_is_estimated,
                mfp.estimate_source as final_pnl_estimate_source,
                mfp.estimate_as_of::text as final_pnl_estimate_as_of,
                pso.synced_position_size::text as synced_position_size,
                pso.synced_avg_price::text as synced_avg_price,
                pso.synced_current_value::text as synced_current_value,
                pso.synced_payout_if_wins::text as synced_payout_if_wins,
                pso.synced_at::text as synced_at,
                pso.sync_status as sync_status,
                pso.position_state as position_state,
                pso.last_known_position_size::text as last_known_position_size,
                pso.last_known_avg_price::text as last_known_avg_price,
                pso.last_known_current_value::text as last_known_current_value,
                pso.last_known_payout_if_wins::text as last_known_payout_if_wins,
                pso.last_nonzero_at::text as last_nonzero_at,
                ROW_NUMBER() OVER (PARTITION BY d.condition_id, d.outcome
                  ORDER BY d.position_current_value::numeric DESC, d.wallet ASC)::int as rn
              FROM deduped d
              INNER JOIN group_keys g ON d.condition_id = g.condition_id AND d.outcome = g.outcome
              LEFT JOIN outcome_price_cache opc ON opc.condition_id = d.condition_id AND opc.outcome = d.outcome
              LEFT JOIN market_final_pnl mfp ON mfp.condition_id = d.condition_id AND mfp.wallet = d.wallet AND mfp.outcome = d.outcome
              LEFT JOIN position_sync_overlay pso ON pso.condition_id = d.condition_id AND pso.wallet = d.wallet AND pso.outcome = d.outcome
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
              FROM alert_events ae
              WHERE ae.fill_timestamp >= ${convergenceCutoff}::timestamptz
                AND ae.fill_price <= ${maxOdds}
                AND ae.position_current_value IS NOT NULL
                AND ae.position_current_value >= ${minPosition}
                AND ae.whale_category = ${category}
                AND (
                  CASE WHEN ${includeResolved}::boolean = TRUE
                    THEN EXISTS (SELECT 1 FROM market_status ms2 WHERE ms2.condition_id = ae.condition_id AND ms2.market_resolved = TRUE AND ms2.winning_outcome IS NOT NULL AND TRIM(ms2.winning_outcome) != '')
                    ELSE NOT EXISTS (SELECT 1 FROM market_status ms2 WHERE ms2.condition_id = ae.condition_id AND ms2.market_resolved = TRUE AND ms2.winning_outcome IS NOT NULL AND TRIM(ms2.winning_outcome) != '')
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
                opc.price::text as cached_price,
                mfp.final_pnl, mfp.position_found as final_position_found,
                mfp.is_estimated as final_pnl_is_estimated,
                mfp.estimate_source as final_pnl_estimate_source,
                mfp.estimate_as_of::text as final_pnl_estimate_as_of,
                pso.synced_position_size::text as synced_position_size,
                pso.synced_avg_price::text as synced_avg_price,
                pso.synced_current_value::text as synced_current_value,
                pso.synced_payout_if_wins::text as synced_payout_if_wins,
                pso.synced_at::text as synced_at,
                pso.sync_status as sync_status,
                pso.position_state as position_state,
                pso.last_known_position_size::text as last_known_position_size,
                pso.last_known_avg_price::text as last_known_avg_price,
                pso.last_known_current_value::text as last_known_current_value,
                pso.last_known_payout_if_wins::text as last_known_payout_if_wins,
                pso.last_nonzero_at::text as last_nonzero_at,
                ROW_NUMBER() OVER (PARTITION BY d.condition_id, d.outcome
                  ORDER BY d.position_current_value::numeric DESC, d.wallet ASC)::int as rn
              FROM deduped d
              INNER JOIN group_keys g ON d.condition_id = g.condition_id AND d.outcome = g.outcome
              LEFT JOIN outcome_price_cache opc ON opc.condition_id = d.condition_id AND opc.outcome = d.outcome
              LEFT JOIN market_final_pnl mfp ON mfp.condition_id = d.condition_id AND mfp.wallet = d.wallet AND mfp.outcome = d.outcome
              LEFT JOIN position_sync_overlay pso ON pso.condition_id = d.condition_id AND pso.wallet = d.wallet AND pso.outcome = d.outcome
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
              FROM alert_events ae
              WHERE ae.fill_timestamp >= ${convergenceCutoff}::timestamptz
                AND ae.fill_price <= ${maxOdds}
                AND ae.position_current_value IS NOT NULL
                AND ae.position_current_value >= ${minPosition}
                AND (
                  ${excludeCategory}::text IS NULL
                  OR ${excludeCategory} != 'crypto'
                  OR (
                    ae.whale_category IS DISTINCT FROM 'crypto'
                    AND ae.title NOT ILIKE '%bitcoin%'
                    AND ae.title NOT ILIKE '%btc%'
                    AND ae.title NOT ILIKE '%ethereum%'
                    AND ae.title NOT ILIKE '%eth %'
                    AND ae.title NOT ILIKE '%solana%'
                    AND ae.title NOT ILIKE '%sol %'
                    AND ae.title NOT ILIKE '%crypto%'
                    AND ae.title NOT ILIKE '%token%'
                    AND ae.title NOT ILIKE '%market cap%'
                    AND ae.title NOT ILIKE '%fdv%'
                    AND ae.title NOT ILIKE '%defi%'
                  )
                )
                AND (
                  CASE WHEN ${includeResolved}::boolean = TRUE
                    THEN EXISTS (SELECT 1 FROM market_status ms2 WHERE ms2.condition_id = ae.condition_id AND ms2.market_resolved = TRUE AND ms2.winning_outcome IS NOT NULL AND TRIM(ms2.winning_outcome) != '')
                    ELSE NOT EXISTS (SELECT 1 FROM market_status ms2 WHERE ms2.condition_id = ae.condition_id AND ms2.market_resolved = TRUE AND ms2.winning_outcome IS NOT NULL AND TRIM(ms2.winning_outcome) != '')
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
                opc.price::text as cached_price,
                mfp.final_pnl, mfp.position_found as final_position_found,
                mfp.is_estimated as final_pnl_is_estimated,
                mfp.estimate_source as final_pnl_estimate_source,
                mfp.estimate_as_of::text as final_pnl_estimate_as_of,
                pso.synced_position_size::text as synced_position_size,
                pso.synced_avg_price::text as synced_avg_price,
                pso.synced_current_value::text as synced_current_value,
                pso.synced_payout_if_wins::text as synced_payout_if_wins,
                pso.synced_at::text as synced_at,
                pso.sync_status as sync_status,
                pso.position_state as position_state,
                pso.last_known_position_size::text as last_known_position_size,
                pso.last_known_avg_price::text as last_known_avg_price,
                pso.last_known_current_value::text as last_known_current_value,
                pso.last_known_payout_if_wins::text as last_known_payout_if_wins,
                pso.last_nonzero_at::text as last_nonzero_at,
                ROW_NUMBER() OVER (PARTITION BY d.condition_id, d.outcome
                  ORDER BY d.position_current_value::numeric DESC, d.wallet ASC)::int as rn
              FROM deduped d
              INNER JOIN group_keys g ON d.condition_id = g.condition_id AND d.outcome = g.outcome
              LEFT JOIN outcome_price_cache opc ON opc.condition_id = d.condition_id AND opc.outcome = d.outcome
              LEFT JOIN market_final_pnl mfp ON mfp.condition_id = d.condition_id AND mfp.wallet = d.wallet AND mfp.outcome = d.outcome
              LEFT JOIN position_sync_overlay pso ON pso.condition_id = d.condition_id AND pso.wallet = d.wallet AND pso.outcome = d.outcome
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
          const fillPrice = parseNumeric(row.fill_price);
          const positionSize = parseNumeric(row.position_size);
          const positionAvgPrice = parseNumeric(row.position_avg_price);
          const cachedPrice = parseNumeric(row.cached_price);

          // Cost basis = positionSize × positionAvgPrice
          const positionCost = (positionSize !== null && positionAvgPrice !== null)
            ? positionSize * positionAvgPrice
            : null;

          // Mark-to-market value = positionSize × currentPrice (null if no price)
          const positionValue = (positionSize !== null && cachedPrice !== null)
            ? positionSize * cachedPrice
            : null;

          // Total payout if outcome wins = positionSize (each share pays $1)
          const totalPayoutIfWins = positionSize;

          // Phase 10: Position sync overlay (when feature enabled)
          const syncedPositionSize = parseNumeric(row.synced_position_size);
          const syncedAvgPrice = parseNumeric(row.synced_avg_price);
          const syncedCurrentValue = parseNumeric(row.synced_current_value);
          const syncedPayoutIfWins = parseNumeric(row.synced_payout_if_wins);
          // Compute synced cost = syncedPositionSize × syncedAvgPrice
          const syncedPositionCost = (syncedPositionSize !== null && syncedAvgPrice !== null)
            ? syncedPositionSize * syncedAvgPrice
            : null;

          // Phase 10.1: Safe state model - last known values (preserved when sync returns empty)
          const lastKnownPositionSize = parseNumeric(row.last_known_position_size);
          const lastKnownAvgPrice = parseNumeric(row.last_known_avg_price);
          const lastKnownCurrentValue = parseNumeric(row.last_known_current_value);
          const lastKnownPayoutIfWins = parseNumeric(row.last_known_payout_if_wins);
          // Compute last known cost = lastKnownPositionSize × lastKnownAvgPrice
          const lastKnownPositionCost = (lastKnownPositionSize !== null && lastKnownAvgPrice !== null)
            ? lastKnownPositionSize * lastKnownAvgPrice
            : null;

          group.wallets.push({
            wallet: row.wallet,
            traderName: row.trader_name || row.trader_pseudonym || 'Anonymous',
            positionSize: positionSize,
            positionCost: positionCost,
            positionCostFormatted: positionCost !== null ? formatMoney(positionCost) : '—',
            positionValue: positionValue,
            positionValueFormatted: positionValue !== null ? formatMoney(positionValue) : '—',
            fillPrice: fillPrice,
            fillPriceFormatted: formatOdds(fillPrice),
            positionAvgPrice: positionAvgPrice,
            positionAvgPriceFormatted: formatOdds(positionAvgPrice),
            totalPayoutIfWins: totalPayoutIfWins,
            totalPayoutIfWinsFormatted: totalPayoutIfWins !== null ? formatMoney(totalPayoutIfWins) : '—',
            latestTimestamp: row.fill_timestamp,
            isWhale: row.is_whale,
            whaleLabel: row.whale_label,
            currentPrice: cachedPrice,
            // Phase 8: Final P&L
            finalPnl: row.final_pnl !== null ? parseFloat(row.final_pnl) : null,
            finalPositionFound: row.final_position_found ?? null,
            // Phase 9: Estimate metadata
            finalPnlIsEstimated: row.final_pnl_is_estimated ?? null,
            finalPnlEstimateSource: row.final_pnl_estimate_source ?? null,
            finalPnlEstimateAsOf: row.final_pnl_estimate_as_of ?? null,
            // Phase 10: Position sync overlay
            syncedPositionSize: syncedPositionSize,
            syncedAvgPrice: syncedAvgPrice,
            syncedCurrentValue: syncedCurrentValue,
            syncedPayoutIfWins: syncedPayoutIfWins,
            syncedPositionCost: syncedPositionCost,
            syncedPositionCostFormatted: syncedPositionCost !== null ? formatMoney(syncedPositionCost) : '—',
            syncedCurrentValueFormatted: syncedCurrentValue !== null ? formatMoney(syncedCurrentValue) : '—',
            syncedPayoutIfWinsFormatted: syncedPayoutIfWins !== null ? formatMoney(syncedPayoutIfWins) : '—',
            syncedAt: row.synced_at ?? null,
            syncStatus: row.sync_status ?? null,
            // Phase 10.1: Safe state model
            positionState: row.position_state ?? null,
            lastKnownPositionSize: lastKnownPositionSize,
            lastKnownAvgPrice: lastKnownAvgPrice,
            lastKnownCurrentValue: lastKnownCurrentValue,
            lastKnownPayoutIfWins: lastKnownPayoutIfWins,
            lastKnownPositionCost: lastKnownPositionCost,
            lastKnownPositionCostFormatted: lastKnownPositionCost !== null ? formatMoney(lastKnownPositionCost) : '—',
            lastKnownCurrentValueFormatted: lastKnownCurrentValue !== null ? formatMoney(lastKnownCurrentValue) : '—',
            lastKnownPayoutIfWinsFormatted: lastKnownPayoutIfWins !== null ? formatMoney(lastKnownPayoutIfWins) : '—',
            lastNonzeroAt: row.last_nonzero_at ?? null,
          });
        }
      }

      // Compute group totals from wallet details
      const groups = Array.from(groupMap.values());
      for (const group of groups) {
        let totalCost = 0;
        let totalValue: number | null = 0;
        let totalPayoutIfWins: number | null = 0;
        let hasAllValues = true;
        let hasAllPayouts = true;

        for (const wallet of group.wallets) {
          // Accumulate cost (skip nulls)
          if (wallet.positionCost !== null) {
            totalCost += wallet.positionCost;
          }

          // Accumulate value - if any wallet is missing value, total value becomes null
          if (wallet.positionValue === null) {
            hasAllValues = false;
          } else if (totalValue !== null) {
            totalValue += wallet.positionValue;
          }

          // Accumulate payout - if any wallet is missing payout (positionSize), total becomes null
          if (wallet.totalPayoutIfWins === null) {
            hasAllPayouts = false;
          } else if (totalPayoutIfWins !== null) {
            totalPayoutIfWins += wallet.totalPayoutIfWins;
          }
        }

        // Set final values
        group.totalCost = totalCost;
        group.totalCostFormatted = formatMoney(totalCost);
        group.totalValue = hasAllValues ? totalValue : null;
        group.totalValueFormatted = hasAllValues && totalValue !== null ? formatMoney(totalValue) : '—';
        group.totalPayoutIfWins = hasAllPayouts ? totalPayoutIfWins : null;
        group.totalPayoutIfWinsFormatted = hasAllPayouts && totalPayoutIfWins !== null ? formatMoney(totalPayoutIfWins) : '—';
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
          positionValueUsd: bet.totalCost, // Use cost basis for archive
          potentialWinUsd: wallet.totalPayoutIfWins, // Total payout if wins = positionSize
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
        // Phase 11: Position aggregation
        totalPositions,
        totalPositionPages: Math.ceil(totalPositions / pageSize),
        whaleAlerts: summary.whale_count,
        uniqueWallets: summary.unique_wallets,
        page,
        pageSize,
        totalPages: Math.ceil(totalAlerts / pageSize),
        // Phase 10: Position sync feature flag
        positionSyncEnabled: POSITION_SYNC_ENABLED,
      },
      alertsPage: formattedAlerts,
      // Phase 11: Aggregated positions (one per wallet+market+outcome)
      positionsPage: formattedPositions,
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
