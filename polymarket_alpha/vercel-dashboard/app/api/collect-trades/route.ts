// /app/api/collect-trades/route.ts
// Phase 1: Ingestion into alert_events table
// Phase 5: Conviction sizing anomaly detection (hardened)
// Phase 12: Robust pagination with composite watermark
// Runs on schedule via Vercel cron

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import {
  fetchRawTrades,
  fetchPositionsForWallets,
  matchTradeToPosition,
  Trade,
} from '@/lib/polymarket';
import { generateTradeDedupeId } from '@/lib/dedupe';
import { computeFillValue } from '@/lib/decimal';
import { normalizeTimestamp } from '@/lib/schemas';
import {
  MIN_ABS_NOTIONAL_USD,
  MIN_TRADES,
  DEDUPE_WINDOW_MINUTES,
  evaluateAnomaly,
} from '@/lib/anomaly-config';
import { isCronAuthed, cronUnauthorized } from '@/lib/cronAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Thresholds from spec
const LONGSHOT_THRESHOLD = 0.25;
const MIN_POSITION_THRESHOLD = 2500;

// Pagination configuration
const PAGE_SIZE = 500;
const MAX_PAGES = 6; // Polymarket API has max offset of 3000, so 6 pages max (offset 2500)
const LOOKBACK_SECONDS = 120; // 2 minute lookback for eventual consistency

// Auth check delegated to shared helper (lib/cronAuth.ts)
// Validates: Authorization: Bearer <CRON_SECRET> or x-cron-secret header (legacy)

interface IngestionSummary {
  trades_fetched: number;
  pages_fetched: number;
  candidates_after_filter: number;
  unique_wallets_queried: number;
  positions_fetched: number;
  positions_at_limit_warning: number;
  alerts_inserted: number;
  skipped_duplicate: number;
  skipped_no_position_match: number;
  skipped_validation_failed: number;
  skipped_below_threshold: number;
  skipped_before_watermark: number;
  pending_wallets_tracked: number;
  // Phase 5: Conviction anomalies (hardened)
  anomalies_inserted: number;
  anomalies_updated: number;
  anomalies_no_baseline: number;
  anomalies_skipped_small_median: number;
  anomalies_skipped_below_threshold: number;
  // Watermark info
  watermark_before: { timestamp: number; dedupeId: string };
  watermark_after: { timestamp: number; dedupeId: string };
  // Safety metrics
  crossed_watermark_boundary: boolean;
  ingest_gap_detected: boolean; // true = trades were provably missed this run
  hit_page_limit: boolean;
  errors: string[];
}

interface TradeWithDedupeId {
  trade: Trade;
  dedupeId: string;
  timestampSeconds: number;
}

/**
 * Composite watermark comparison.
 * Returns true if trade is "newer" than watermark.
 * Handles ties by comparing dedupe IDs lexicographically.
 */
function isNewerThanWatermark(
  tradeTs: number,
  tradeDedupeId: string,
  watermarkTs: number,
  watermarkDedupeId: string
): boolean {
  if (tradeTs > watermarkTs) return true;
  if (tradeTs === watermarkTs && tradeDedupeId > watermarkDedupeId) return true;
  return false;
}

/**
 * Check if we've crossed the watermark boundary (accounting for lookback).
 * Returns true if the oldest trade in page is at or before watermark - lookback.
 */
function crossedWatermarkBoundary(
  oldestTradeTs: number,
  watermarkTs: number,
  lookbackSeconds: number
): boolean {
  return oldestTradeTs <= watermarkTs - lookbackSeconds;
}

// POST-only, requires Authorization: Bearer <CRON_SECRET> or x-cron-secret header
export async function POST(request: Request) {
  // Auth check (defense-in-depth; middleware also validates)
  if (!isCronAuthed(request)) {
    return cronUnauthorized();
  }

  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  let jobStatus: 'success' | 'error' = 'success';
  let jobError: string | null = null;

  const summary: IngestionSummary = {
    trades_fetched: 0,
    pages_fetched: 0,
    candidates_after_filter: 0,
    unique_wallets_queried: 0,
    positions_fetched: 0,
    positions_at_limit_warning: 0,
    alerts_inserted: 0,
    skipped_duplicate: 0,
    skipped_no_position_match: 0,
    skipped_validation_failed: 0,
    skipped_below_threshold: 0,
    skipped_before_watermark: 0,
    pending_wallets_tracked: 0,
    anomalies_inserted: 0,
    anomalies_updated: 0,
    anomalies_no_baseline: 0,
    anomalies_skipped_small_median: 0,
    anomalies_skipped_below_threshold: 0,
    watermark_before: { timestamp: 0, dedupeId: '' },
    watermark_after: { timestamp: 0, dedupeId: '' },
    crossed_watermark_boundary: false,
    ingest_gap_detected: false,
    hit_page_limit: false,
    errors: [],
  };

  try {
    console.log('[collect-trades] Starting Phase 12 ingestion with watermark pagination...');

    // Step 1: Read current watermark
    const watermarkResult = await sql<{
      last_timestamp: string;
      last_trade_dedupe_id: string;
    }>`
      SELECT last_timestamp, last_trade_dedupe_id
      FROM trade_ingest_watermark
      WHERE id = 'default'
    `;

    let watermarkTs = 0;
    let watermarkDedupeId = '';

    if (watermarkResult.rows.length > 0) {
      watermarkTs = parseInt(watermarkResult.rows[0].last_timestamp, 10) || 0;
      watermarkDedupeId = watermarkResult.rows[0].last_trade_dedupe_id || '';
    } else {
      // Initialize watermark if not exists
      await sql`
        INSERT INTO trade_ingest_watermark (id, last_timestamp, last_trade_dedupe_id)
        VALUES ('default', 0, '')
        ON CONFLICT (id) DO NOTHING
      `;
    }

    summary.watermark_before = { timestamp: watermarkTs, dedupeId: watermarkDedupeId };
    console.log(`[collect-trades] Current watermark: ts=${watermarkTs}, id=${watermarkDedupeId.slice(0, 30)}...`);

    // Step 2: Paginate through trades until we cross the watermark boundary
    const allNewTrades: TradeWithDedupeId[] = [];
    let offset = 0;
    let shouldContinue = true;
    let crossedBoundary = false;

    for (let page = 0; page < MAX_PAGES && shouldContinue; page++) {
      const { trades, skipped: validationSkipped, errors: validationErrors, hitOffsetLimit } = await fetchRawTrades({
        minValue: 100,
        limit: PAGE_SIZE,
        offset,
        side: 'BUY', // every downstream filter is BUY-only; don't spend offset budget on SELLs
      });

      // Handle Polymarket API offset limit (max 3000)
      if (hitOffsetLimit) {
        console.log(`[collect-trades] Hit API offset limit at page ${page + 1}, stopping pagination gracefully`);
        crossedBoundary = true; // Treat as boundary - we've fetched all we can
        break;
      }

      summary.pages_fetched++;
      summary.trades_fetched += trades.length + validationSkipped;
      summary.skipped_validation_failed += validationSkipped;

      if (validationErrors.length > 0) {
        summary.errors.push(...validationErrors.slice(0, 3));
      }

      console.log(`[collect-trades] Page ${page + 1}: fetched ${trades.length} valid trades (offset=${offset})`);

      if (trades.length === 0) {
        console.log('[collect-trades] Empty page, stopping pagination');
        crossedBoundary = true; // Empty page means we've seen everything
        break;
      }

      // Process trades in this page
      let oldestTradeTs = Infinity;
      let newTradesThisPage = 0;

      for (const trade of trades) {
        const timestampSeconds = normalizeTimestamp(trade.timestamp);
        oldestTradeTs = Math.min(oldestTradeTs, timestampSeconds);

        const dedupeId = generateTradeDedupeId({
          transactionHash: trade.transactionHash,
          wallet: trade.proxyWallet,
          asset: trade.asset,
          side: trade.side,
          timestamp: trade.timestamp,
          price: trade.price,
          size: trade.size,
        });

        // Check if this trade is newer than watermark (with lookback)
        // We include trades within the lookback window to handle eventual consistency
        const effectiveWatermarkTs = Math.max(0, watermarkTs - LOOKBACK_SECONDS);

        if (isNewerThanWatermark(timestampSeconds, dedupeId, effectiveWatermarkTs, watermarkDedupeId)) {
          allNewTrades.push({ trade, dedupeId, timestampSeconds });
          newTradesThisPage++;
        } else {
          summary.skipped_before_watermark++;
        }
      }

      console.log(`[collect-trades] Page ${page + 1}: ${newTradesThisPage} new trades, oldest_ts=${oldestTradeTs}`);

      // Check if we've crossed the watermark boundary
      if (crossedWatermarkBoundary(oldestTradeTs, watermarkTs, LOOKBACK_SECONDS)) {
        console.log(`[collect-trades] Crossed watermark boundary at page ${page + 1}, stopping pagination`);
        crossedBoundary = true;
        shouldContinue = false;
      } else if (trades.length < PAGE_SIZE) {
        // End of data (partial page)
        console.log('[collect-trades] Partial page, end of data');
        crossedBoundary = true;
        shouldContinue = false;
      } else {
        offset += PAGE_SIZE;
      }
    }

    // Scan high-water mark: the newest trade we actually READ this run.
    // The watermark tracks scan progress, not persistence -- most runs legitimately
    // persist zero alerts (all candidates filtered out), and gating the watermark on
    // inserts is what let it sit frozen while the scanner ran fine.
    let scanHighWaterTs = watermarkTs;
    let scanHighWaterDedupeId = watermarkDedupeId;
    for (const t of allNewTrades) {
      if (t.timestampSeconds > scanHighWaterTs ||
          (t.timestampSeconds === scanHighWaterTs && t.dedupeId > scanHighWaterDedupeId)) {
        scanHighWaterTs = t.timestampSeconds;
        scanHighWaterDedupeId = t.dedupeId;
      }
    }

    // Check if we hit page limit without crossing boundary
    summary.crossed_watermark_boundary = crossedBoundary;
    summary.hit_page_limit = !crossedBoundary && summary.pages_fetched >= MAX_PAGES;

    if (summary.hit_page_limit) {
      console.error(`[collect-trades] INGEST GAP: hit page limit (${MAX_PAGES}) without reaching the watermark. Trades older than the fetched window were MISSED and are unrecoverable (API offset cap). Watermark advanced anyway to avoid latching. Reduce the cron interval.`);
    }

    console.log(`[collect-trades] Pagination complete: ${allNewTrades.length} new trades across ${summary.pages_fetched} pages (crossed_boundary=${crossedBoundary})`);

    // SAFETY vs LIVENESS: If we hit the page limit without crossing the boundary, some older
    // trades were unreachable this run. The original behaviour was to freeze the watermark.
    // That is a latch: once the watermark falls further behind than one 3000-trade window
    // (~1h of filtered volume), the boundary can NEVER be crossed again, so the watermark
    // stops advancing permanently and every run re-scans the same blind window. Observed in
    // production: frozen at 2026-01-15 for 7 months.
    //
    // Freezing does not recover the missed trades either -- they are outside the offset cap
    // regardless. So we accept the known gap, advance anyway, and make the loss LOUD via
    // ingest_gap_detected. De-duplication does not depend on the watermark: Step 4 checks
    // existing dedupe IDs and the insert is ON CONFLICT DO NOTHING.
    const canAdvanceWatermark = true;
    summary.ingest_gap_detected = summary.hit_page_limit;

    // Step 3: Filter to longshot candidates (BUY side, price <= 25%)
    const candidates = allNewTrades.filter(
      (t) => t.trade.side === 'BUY' && t.trade.price <= LONGSHOT_THRESHOLD
    );
    summary.candidates_after_filter = candidates.length;

    console.log(`[collect-trades] ${candidates.length} longshot candidates after filter`);

    if (candidates.length === 0) {
      // Only update watermark if we safely crossed the boundary
      if (canAdvanceWatermark && allNewTrades.length > 0) {
        const maxTrade = allNewTrades.reduce((max, t) =>
          t.timestampSeconds > max.timestampSeconds ||
          (t.timestampSeconds === max.timestampSeconds && t.dedupeId > max.dedupeId)
            ? t : max
        );
        await sql`
          UPDATE trade_ingest_watermark
          SET last_timestamp = ${maxTrade.timestampSeconds},
              last_trade_dedupe_id = ${maxTrade.dedupeId},
              updated_at = NOW()
          WHERE id = 'default'
        `;
        summary.watermark_after = { timestamp: maxTrade.timestampSeconds, dedupeId: maxTrade.dedupeId };
      } else {
        summary.watermark_after = summary.watermark_before;
      }

      return NextResponse.json({
        success: true,
        summary,
        durationMs: Date.now() - startTime,
      });
    }

    // Step 4: Check which dedupe IDs already exist in database (idempotent deduplication)
    const dedupeIds = candidates.map((c) => c.dedupeId);
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
    const newCandidates = candidates.filter((c) => !existingDedupeIds.has(c.dedupeId));
    summary.skipped_duplicate = candidates.length - newCandidates.length;

    console.log(`[collect-trades] ${newCandidates.length} new candidates (${summary.skipped_duplicate} duplicates skipped)`);

    if (newCandidates.length === 0) {
      // Only update watermark if we safely crossed the boundary
      if (canAdvanceWatermark && candidates.length > 0) {
        const maxTrade = candidates.reduce((max, t) =>
          t.timestampSeconds > max.timestampSeconds ||
          (t.timestampSeconds === max.timestampSeconds && t.dedupeId > max.dedupeId)
            ? t : max
        );
        await sql`
          UPDATE trade_ingest_watermark
          SET last_timestamp = ${maxTrade.timestampSeconds},
              last_trade_dedupe_id = ${maxTrade.dedupeId},
              updated_at = NOW()
          WHERE id = 'default'
        `;
        summary.watermark_after = { timestamp: maxTrade.timestampSeconds, dedupeId: maxTrade.dedupeId };
      } else {
        summary.watermark_after = summary.watermark_before;
      }

      return NextResponse.json({
        success: true,
        summary,
        durationMs: Date.now() - startTime,
      });
    }

    // Step 5: Group candidates by wallet and fetch positions
    const walletSet = new Set(newCandidates.map((c) => c.trade.proxyWallet));
    const uniqueWallets = Array.from(walletSet);
    summary.unique_wallets_queried = uniqueWallets.length;

    console.log(`[collect-trades] Fetching positions for ${uniqueWallets.length} unique wallets...`);

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

    // Step 7: Process each candidate and track max watermark
    const snapshotAt = new Date().toISOString();
    let maxPersistedTs = watermarkTs;
    let maxPersistedDedupeId = watermarkDedupeId;

    // Sort candidates oldest-first for deterministic processing
    const sortedCandidates = [...newCandidates].sort((a, b) => {
      if (a.timestampSeconds !== b.timestampSeconds) {
        return a.timestampSeconds - b.timestampSeconds;
      }
      return a.dedupeId.localeCompare(b.dedupeId);
    });

    for (const { trade, dedupeId, timestampSeconds } of sortedCandidates) {
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

          // Track wallet for later re-scan - they made a longshot trade but position is too small
          try {
            const fillTimestampForPending = new Date(timestampSeconds * 1000).toISOString();
            await sql`
              INSERT INTO pending_longshot_wallets (
                wallet,
                first_seen_at,
                last_trade_at,
                last_condition_id,
                last_trade_price,
                last_trade_size,
                last_position_value,
                times_skipped,
                status
              ) VALUES (
                ${walletLower},
                NOW(),
                ${fillTimestampForPending}::timestamptz,
                ${trade.conditionId},
                ${trade.price},
                ${trade.size},
                ${thresholdValue},
                1,
                'pending'
              )
              ON CONFLICT (wallet) DO UPDATE SET
                last_trade_at = EXCLUDED.last_trade_at,
                last_condition_id = EXCLUDED.last_condition_id,
                last_trade_price = EXCLUDED.last_trade_price,
                last_trade_size = EXCLUDED.last_trade_size,
                last_position_value = EXCLUDED.last_position_value,
                times_skipped = pending_longshot_wallets.times_skipped + 1,
                status = 'pending'
            `;
            summary.pending_wallets_tracked++;
          } catch (pendingErr) {
            // Non-fatal - log but don't fail the trade processing
            console.warn('[collect-trades] Failed to track pending wallet:', String(pendingErr).slice(0, 100));
          }

          continue;
        }

        // Compute fill value using decimal-safe math
        const fillValueUsd = computeFillValue(trade.price, trade.size);

        // Generate UUID
        const id = crypto.randomUUID();

        // Convert timestamp to ISO for TIMESTAMPTZ
        const fillTimestamp = new Date(timestampSeconds * 1000).toISOString();

        // Lookup whale metadata
        const whaleInfo = whalesByWallet.get(walletLower);
        const isWhale = !!whaleInfo;

        // Insert into alert_events (idempotent via ON CONFLICT DO NOTHING)
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

          // Update max watermark after successful persist
          if (timestampSeconds > maxPersistedTs ||
              (timestampSeconds === maxPersistedTs && dedupeId > maxPersistedDedupeId)) {
            maxPersistedTs = timestampSeconds;
            maxPersistedDedupeId = dedupeId;
          }

          console.log(
            `[collect-trades] Inserted: ${trade.name || walletLower.slice(0, 8)} - ${trade.title?.slice(0, 30) || 'Unknown'} @ ${(trade.price * 100).toFixed(1)}% = $${fillValueUsd}`
          );

          // Phase 5 (Hardened): Check for conviction sizing anomaly
          const fillValueNum = parseFloat(fillValueUsd);
          if (fillValueNum >= MIN_ABS_NOTIONAL_USD) {
            try {
              // Look up baseline for this wallet
              const baselineResult = await sql<{
                trade_count: number;
                median_notional: number;
                mad: number;
              }>`
                SELECT trade_count, median_notional, mad
                FROM wallet_trade_size_baselines
                WHERE wallet = ${walletLower}
              `;

              const baseline = baselineResult.rows[0];

              if (baseline) {
                // Use the hardened evaluation logic
                const evaluation = evaluateAnomaly(
                  fillValueNum,
                  baseline.median_notional,
                  baseline.mad,
                  baseline.trade_count
                );

                if (evaluation.qualifies) {
                  // Check for existing anomaly within dedupe window (same wallet + market)
                  const dedupeWindowCutoff = new Date(Date.now() - DEDUPE_WINDOW_MINUTES * 60 * 1000).toISOString();
                  const existingResult = await sql<{
                    id: string;
                    trade_notional: number;
                    ratio_to_median: number;
                    severity: number;
                  }>`
                    SELECT id, trade_notional, ratio_to_median, severity
                    FROM conviction_anomalies
                    WHERE wallet = ${walletLower}
                      AND condition_id = ${trade.conditionId}
                      AND COALESCE(last_seen_at, created_at) >= ${dedupeWindowCutoff}::timestamptz
                    ORDER BY COALESCE(last_seen_at, created_at) DESC
                    LIMIT 1
                  `;

                  const existing = existingResult.rows[0];

                  if (existing) {
                    // Dedupe: Update existing anomaly with max values
                    const newNotional = Math.max(existing.trade_notional, fillValueNum);
                    const newRatio = Math.max(existing.ratio_to_median, evaluation.ratio);
                    const newSeverity = Math.max(existing.severity, evaluation.severity);

                    await sql`
                      UPDATE conviction_anomalies
                      SET trade_notional = ${newNotional},
                          ratio_to_median = ${newRatio},
                          severity = ${newSeverity},
                          last_seen_at = NOW()
                      WHERE id = ${existing.id}::uuid
                    `;
                    summary.anomalies_updated++;
                    console.log(
                      `[collect-trades] ANOMALY (updated): ${trade.name || walletLower.slice(0, 8)} - merged into existing, notional now $${newNotional.toFixed(0)}`
                    );
                  } else {
                    // Insert new anomaly
                    const anomalyId = crypto.randomUUID();
                    await sql`
                      INSERT INTO conviction_anomalies (
                        id,
                        alert_event_id,
                        trade_dedupe_id,
                        wallet,
                        fill_timestamp,
                        trade_notional,
                        baseline_median,
                        baseline_mad,
                        baseline_trade_count,
                        ratio_to_median,
                        robust_z,
                        severity,
                        condition_id,
                        outcome,
                        title,
                        slug,
                        side,
                        fill_price,
                        is_whale,
                        trader_name
                      ) VALUES (
                        ${anomalyId},
                        ${id},
                        ${dedupeId},
                        ${walletLower},
                        ${fillTimestamp},
                        ${fillValueNum},
                        ${baseline.median_notional},
                        ${baseline.mad},
                        ${baseline.trade_count},
                        ${evaluation.ratio},
                        ${evaluation.robustZ},
                        ${evaluation.severity},
                        ${trade.conditionId},
                        ${trade.outcome},
                        ${trade.title || null},
                        ${trade.slug || null},
                        ${trade.side},
                        ${trade.price},
                        ${isWhale},
                        ${trade.name || null}
                      )
                      ON CONFLICT (trade_dedupe_id) DO NOTHING
                    `;
                    summary.anomalies_inserted++;
                    console.log(
                      `[collect-trades] ANOMALY: ${trade.name || walletLower.slice(0, 8)} - $${fillValueNum.toFixed(0)} is ${evaluation.ratio.toFixed(1)}x median (severity: ${evaluation.severity.toFixed(1)})`
                    );
                  }
                } else if (evaluation.reason === 'small_median_below_abs_threshold') {
                  summary.anomalies_skipped_small_median++;
                } else if (evaluation.reason === 'below_ratio_threshold' || evaluation.reason === 'below_robust_z_threshold') {
                  summary.anomalies_skipped_below_threshold++;
                } else if (evaluation.reason === 'insufficient_trades') {
                  summary.anomalies_no_baseline++;
                }
              } else {
                summary.anomalies_no_baseline++;
              }
            } catch (anomalyErr) {
              // Non-fatal - log and continue
              console.warn('[collect-trades] Anomaly check failed:', String(anomalyErr).slice(0, 100));
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        summary.errors.push(`Insert failed: ${errMsg}`);
        if (summary.errors.length <= 5) {
          console.error('[collect-trades] Insert error:', err);
        }
      }
    }

    // Step 8: Update watermark ONLY after successful persistence AND if we crossed boundary
    if (canAdvanceWatermark &&
        (scanHighWaterTs > watermarkTs ||
         (scanHighWaterTs === watermarkTs && scanHighWaterDedupeId > watermarkDedupeId))) {
      await sql`
        UPDATE trade_ingest_watermark
        SET last_timestamp = ${scanHighWaterTs},
            last_trade_dedupe_id = ${scanHighWaterDedupeId},
            updated_at = NOW()
        WHERE id = 'default'
      `;
      summary.watermark_after = { timestamp: scanHighWaterTs, dedupeId: scanHighWaterDedupeId };
      console.log(`[collect-trades] Watermark updated: ts=${scanHighWaterTs}, id=${scanHighWaterDedupeId.slice(0, 30)}...`);
    } else {
      summary.watermark_after = summary.watermark_before;
      console.log(`[collect-trades] Watermark unchanged (no newer trade persisted this run)`);
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
    jobStatus = 'error';
    jobError = err instanceof Error ? err.message : String(err);
    summary.errors.push(`Fatal: ${jobError}`);

    return NextResponse.json(
      {
        success: false,
        error: 'Ingestion failed',
        summary,
        durationMs: Date.now() - startTime,
      },
      { status: 500 }
    );
  } finally {
    // Record job run to job_runs table (never crashes the handler)
    const durationMs = Date.now() - startTime;
    try {
      const metrics = jobStatus === 'success'
        ? { ...summary, durationMs }
        : { error: jobError, durationMs, summary };

      await sql`
        INSERT INTO job_runs (id, job_name, status, started_at, finished_at, duration_ms, metrics)
        VALUES (
          ${crypto.randomUUID()},
          'collect-trades',
          ${jobStatus},
          ${startedAt}::timestamptz,
          NOW(),
          ${durationMs},
          ${JSON.stringify(metrics)}::jsonb
        )
      `;
    } catch (logErr) {
      // Non-fatal: log but don't crash the handler
      console.error('[collect-trades] Failed to record job_runs:', logErr);
    }
  }
}

// Reject GET requests
export async function GET() {
  return NextResponse.json(
    { error: 'Method not allowed. Use POST with x-cron-secret header.' },
    { status: 405, headers: { 'Allow': 'POST' } }
  );
}
