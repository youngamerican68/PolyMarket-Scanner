// /app/api/collect-trades/route.ts
// Phase 1: Ingestion into alert_events table
// Runs on schedule via Vercel cron

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import {
  fetchRawTrades,
  fetchPositionsForWallets,
  matchTradeToPosition,
  Trade,
  Position,
} from '@/lib/polymarket';
import { generateTradeDedupeId } from '@/lib/dedupe';
import { computeFillValue } from '@/lib/decimal';
import { normalizeTimestamp } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Thresholds from spec
const LONGSHOT_THRESHOLD = 0.25;
const MIN_POSITION_THRESHOLD = 2500;

// Auth check for cron requests
function isAuthorized(request: Request): boolean {
  const secret = request.headers.get('x-cron-secret');
  const expectedSecret = process.env.CRON_SECRET;

  // If CRON_SECRET is not set, allow requests (dev mode)
  if (!expectedSecret) {
    console.warn('[collect-trades] CRON_SECRET not set - allowing unauthenticated request');
    return true;
  }

  return secret === expectedSecret;
}

interface IngestionSummary {
  trades_fetched: number;
  candidates_after_filter: number;
  unique_wallets_queried: number;
  positions_fetched: number;
  positions_at_limit_warning: number;
  alerts_inserted: number;
  skipped_duplicate: number;
  skipped_no_position_match: number;
  skipped_validation_failed: number;
  skipped_below_threshold: number;
  errors: string[];
}

// POST-only, requires x-cron-secret header
export async function POST(request: Request) {
  // Auth check
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  const startTime = Date.now();
  const summary: IngestionSummary = {
    trades_fetched: 0,
    candidates_after_filter: 0,
    unique_wallets_queried: 0,
    positions_fetched: 0,
    positions_at_limit_warning: 0,
    alerts_inserted: 0,
    skipped_duplicate: 0,
    skipped_no_position_match: 0,
    skipped_validation_failed: 0,
    skipped_below_threshold: 0,
    errors: [],
  };

  try {
    console.log('[collect-trades] Starting Phase 1 ingestion...');

    // Step 1: Fetch recent trades with per-item validation
    const { trades, skipped: validationSkipped, errors: validationErrors } = await fetchRawTrades({
      minValue: 100,
      limit: 500,
    });

    summary.trades_fetched = trades.length + validationSkipped;
    summary.skipped_validation_failed = validationSkipped;

    if (validationErrors.length > 0) {
      summary.errors.push(...validationErrors.slice(0, 5));
    }

    console.log(`[collect-trades] Fetched ${trades.length} valid trades (${validationSkipped} failed validation)`);

    // Step 2: Filter to longshot candidates (BUY side, price <= 25%)
    const candidates = trades.filter(
      (t) => t.side === 'BUY' && t.price <= LONGSHOT_THRESHOLD
    );
    summary.candidates_after_filter = candidates.length;

    console.log(`[collect-trades] ${candidates.length} longshot candidates after filter`);

    if (candidates.length === 0) {
      return NextResponse.json({
        success: true,
        summary,
        durationMs: Date.now() - startTime,
      });
    }

    // Step 3: Generate dedupe IDs and check for existing entries
    const candidatesWithDedupeId = candidates.map((trade) => ({
      trade,
      dedupeId: generateTradeDedupeId({
        transactionHash: trade.transactionHash,
        wallet: trade.proxyWallet,
        asset: trade.asset,
        side: trade.side,
        timestamp: trade.timestamp,
        price: trade.price,
        size: trade.size,
      }),
    }));

    // Check which dedupe IDs already exist in database
    const dedupeIds = candidatesWithDedupeId.map((c) => c.dedupeId);

    // Build the query with proper array handling for Vercel Postgres
    const existingDedupeIds = new Set<string>();
    if (dedupeIds.length > 0) {
      const existingResult = await sql.query(
        `SELECT trade_dedupe_id FROM alert_events WHERE trade_dedupe_id = ANY($1::text[])`,
        [dedupeIds]
      );
      for (const row of existingResult.rows) {
        existingDedupeIds.add(row.trade_dedupe_id);
      }
    }

    // Filter out already-ingested trades
    const newCandidates = candidatesWithDedupeId.filter((c) => !existingDedupeIds.has(c.dedupeId));
    summary.skipped_duplicate = candidatesWithDedupeId.length - newCandidates.length;

    console.log(`[collect-trades] ${newCandidates.length} new candidates (${summary.skipped_duplicate} duplicates skipped)`);

    if (newCandidates.length === 0) {
      return NextResponse.json({
        success: true,
        summary,
        durationMs: Date.now() - startTime,
      });
    }

    // Step 4: Group candidates by wallet
    const walletSet = new Set(newCandidates.map((c) => c.trade.proxyWallet));
    const uniqueWallets = Array.from(walletSet);
    summary.unique_wallets_queried = uniqueWallets.length;

    console.log(`[collect-trades] Fetching positions for ${uniqueWallets.length} unique wallets...`);

    // Step 5: Fetch positions for all wallets (with concurrency control)
    const { positionsByWallet, atLimitWallets } = await fetchPositionsForWallets(uniqueWallets);

    summary.positions_at_limit_warning = atLimitWallets.length;
    let totalPositions = 0;
    for (const positions of Array.from(positionsByWallet.values())) {
      totalPositions += positions.length;
    }
    summary.positions_fetched = totalPositions;

    console.log(`[collect-trades] Fetched ${totalPositions} positions (${atLimitWallets.length} wallets at limit)`);

    // Step 6: Fetch whale watchlist for metadata lookup
    const whaleResult = await sql`
      SELECT LOWER(wallet) as wallet, name as label, tier, category
      FROM whale_watchlist
      WHERE wallet IS NOT NULL
    `;
    const whalesByWallet = new Map(
      whaleResult.rows.map((r) => [r.wallet, { label: r.label, tier: r.tier, category: r.category }])
    );

    // Step 7: Process each candidate
    const snapshotAt = new Date().toISOString();

    for (const { trade, dedupeId } of newCandidates) {
      try {
        const walletLower = trade.proxyWallet.toLowerCase();
        const positions = positionsByWallet.get(walletLower) || [];

        // Match trade to position
        const matchedPosition = matchTradeToPosition(trade, positions);

        if (!matchedPosition) {
          summary.skipped_no_position_match++;
          continue;
        }

        // Compute threshold qualification
        let thresholdValue: number | null = null;
        let thresholdSource: string | null = null;

        if (matchedPosition.initialValue !== null && matchedPosition.initialValue !== undefined) {
          thresholdValue = matchedPosition.initialValue;
          thresholdSource = 'initialValue';
        } else if (matchedPosition.currentValue !== null && matchedPosition.currentValue !== undefined) {
          thresholdValue = matchedPosition.currentValue;
          thresholdSource = 'currentValue';
        }

        const qualifiesMinPosition = thresholdValue !== null && thresholdValue >= MIN_POSITION_THRESHOLD;

        if (!qualifiesMinPosition) {
          summary.skipped_below_threshold++;
          continue;
        }

        // Compute fill value using decimal-safe math
        const fillValueUsd = computeFillValue(trade.price, trade.size);

        // Generate UUID
        const id = crypto.randomUUID();

        // Convert timestamp to ISO for TIMESTAMPTZ
        const timestampSeconds = normalizeTimestamp(trade.timestamp);
        const fillTimestamp = new Date(timestampSeconds * 1000).toISOString();

        // Lookup whale metadata
        const whaleInfo = whalesByWallet.get(walletLower);
        const isWhale = !!whaleInfo;

        // Insert into alert_events
        const insertResult = await sql`
          INSERT INTO alert_events (
            id,
            trade_dedupe_id,
            transaction_hash,
            fill_timestamp,
            side,
            fill_price,
            fill_size,
            fill_value_usd,
            wallet,
            trader_name,
            trader_pseudonym,
            asset,
            condition_id,
            outcome,
            outcome_index,
            title,
            slug,
            event_slug,
            position_size,
            position_avg_price,
            position_cur_price,
            position_initial_value,
            position_current_value,
            position_cash_pnl,
            position_snapshot_at,
            longshot_threshold,
            min_position_threshold,
            qualifies_longshot,
            qualifies_min_position,
            threshold_value_used,
            threshold_source,
            is_whale,
            whale_label,
            whale_tier,
            whale_category
          ) VALUES (
            ${id},
            ${dedupeId},
            ${trade.transactionHash || null},
            ${fillTimestamp},
            ${trade.side},
            ${trade.price},
            ${trade.size},
            ${fillValueUsd},
            ${walletLower},
            ${trade.name || null},
            ${trade.pseudonym || null},
            ${trade.asset},
            ${trade.conditionId},
            ${trade.outcome},
            ${trade.outcomeIndex},
            ${trade.title || null},
            ${trade.slug || null},
            ${trade.eventSlug || null},
            ${matchedPosition.size},
            ${matchedPosition.avgPrice},
            ${matchedPosition.curPrice},
            ${matchedPosition.initialValue},
            ${matchedPosition.currentValue},
            ${matchedPosition.cashPnl},
            ${snapshotAt},
            ${LONGSHOT_THRESHOLD},
            ${MIN_POSITION_THRESHOLD},
            ${true},
            ${qualifiesMinPosition},
            ${thresholdValue},
            ${thresholdSource},
            ${isWhale},
            ${whaleInfo?.label || null},
            ${whaleInfo?.tier || null},
            ${whaleInfo?.category || null}
          )
          ON CONFLICT (trade_dedupe_id) DO NOTHING
        `;

        if (insertResult.rowCount && insertResult.rowCount > 0) {
          summary.alerts_inserted++;
          console.log(
            `[collect-trades] Inserted: ${trade.name || walletLower.slice(0, 8)} - ${trade.title?.slice(0, 30) || 'Unknown'} @ ${(trade.price * 100).toFixed(1)}% = $${fillValueUsd}`
          );
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        summary.errors.push(`Insert failed: ${errMsg}`);
        if (summary.errors.length <= 5) {
          console.error('[collect-trades] Insert error:', err);
        }
      }
    }

    console.log('[collect-trades] Ingestion complete:', JSON.stringify(summary, null, 2));

    return NextResponse.json({
      success: true,
      summary,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[collect-trades] Fatal error:', err);
    summary.errors.push(`Fatal: ${err instanceof Error ? err.message : String(err)}`);

    return NextResponse.json(
      {
        success: false,
        error: 'Ingestion failed',
        summary,
        durationMs: Date.now() - startTime,
      },
      { status: 500 }
    );
  }
}

// Reject GET requests
export async function GET() {
  return NextResponse.json(
    { error: 'Method not allowed. Use POST with x-cron-secret header.' },
    { status: 405, headers: { 'Allow': 'POST' } }
  );
}
