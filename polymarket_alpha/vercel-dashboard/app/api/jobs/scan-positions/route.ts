// /app/api/jobs/scan-positions/route.ts
// Position scanner job - finds wallets with $2,500+ positions we may have missed
// Complements collect-trades by catching positions built through many small trades

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import pLimit from 'p-limit';
import { fetchPositionsWithRetry, Position } from '@/lib/polymarket';
import { isCronAuthed, cronUnauthorized } from '@/lib/cronAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes max

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

// Configuration
const MIN_POSITION_VALUE = 2500;
const LONGSHOT_THRESHOLD = 0.25; // 25% odds or less = longshot
const WALLET_CONCURRENCY = 5;
const MAX_WALLETS_PER_RUN = 200;
const POSITION_LIMIT_PER_WALLET = 100;
const JOB_NAME = 'scan-positions';

const walletLimit = pLimit(WALLET_CONCURRENCY);

interface JobMetrics {
  walletsScanned: number;
  positionsFound: number;
  positionsInserted: number;
  positionsSkippedExists: number;
  positionsSkippedResolved: number;
  positionsSkippedNotLongshot: number;
  errors: string[];
}

// Get wallets to scan from recent trades we may have skipped
// These are wallets that traded recently but we might not have captured
// because their position was below threshold at the time
async function getWalletsToScan(): Promise<string[]> {
  // Get wallets from recent trades that might have positions we missed
  // Use the trades API to discover active wallets
  const tradesUrl = `https://data-api.polymarket.com/trades?limit=500&filterType=CASH&filterAmount=100&takerOnly=true`;

  try {
    const res = await fetch(tradesUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    });

    if (!res.ok) {
      throw new Error(`Trades API returned ${res.status}`);
    }

    const trades = await res.json();

    if (!Array.isArray(trades)) {
      throw new Error('Expected array from trades API');
    }

    // Extract unique wallets
    const wallets = new Set<string>();
    for (const trade of trades) {
      if (trade.proxyWallet) {
        wallets.add(trade.proxyWallet.toLowerCase());
      }
    }

    // Limit to prevent timeout
    return Array.from(wallets).slice(0, MAX_WALLETS_PER_RUN);
  } catch (err) {
    console.error('[scan-positions] Failed to fetch trades for wallet discovery:', err);
    return [];
  }
}

// Check if we already have this position in alert_events
async function positionExists(
  wallet: string,
  conditionId: string,
  outcome: string
): Promise<boolean> {
  const result = await sql`
    SELECT 1 FROM alert_events
    WHERE wallet = ${wallet.toLowerCase()}
      AND condition_id = ${conditionId}
      AND outcome = ${outcome}
    LIMIT 1
  `;
  return result.rows.length > 0;
}

// Check if market is resolved
async function isMarketResolved(conditionId: string): Promise<boolean> {
  const result = await sql`
    SELECT 1 FROM market_status
    WHERE condition_id = ${conditionId}
      AND market_resolved = TRUE
      AND winning_outcome IS NOT NULL
      AND TRIM(winning_outcome) != ''
    LIMIT 1
  `;
  return result.rows.length > 0;
}

// Insert a position into alert_events
async function insertPosition(
  wallet: string,
  position: Position,
  metrics: JobMetrics
): Promise<void> {
  const walletLower = wallet.toLowerCase();
  const conditionId = position.conditionId;
  const outcome = position.outcome || 'Yes';

  // Skip if already exists
  if (await positionExists(walletLower, conditionId, outcome)) {
    metrics.positionsSkippedExists++;
    return;
  }

  // Skip resolved markets
  if (await isMarketResolved(conditionId)) {
    metrics.positionsSkippedResolved++;
    return;
  }

  const positionSize = position.size ?? 0;
  const avgPrice = position.avgPrice ?? 0;
  const curPrice = position.curPrice ?? 0;
  const currentValue = positionSize * curPrice;
  const initialValue = position.initialValue ?? currentValue;

  // Generate a unique dedupe_id for this position discovery
  const dedupeId = `scan-${walletLower}-${conditionId}-${outcome}-${Date.now()}`;
  const now = new Date().toISOString();

  await sql`
    INSERT INTO alert_events (
      dedupe_id,
      wallet,
      condition_id,
      outcome,
      title,
      slug,
      event_slug,
      fill_price,
      fill_size,
      fill_timestamp,
      position_size,
      position_avg_price,
      position_cur_price,
      position_initial_value,
      position_current_value,
      position_cash_pnl,
      snapshot_at,
      longshot_threshold,
      min_position_threshold,
      qualifies_longshot,
      qualifies_min_position,
      threshold_value,
      threshold_source
    ) VALUES (
      ${dedupeId},
      ${walletLower},
      ${conditionId},
      ${outcome},
      ${position.title || null},
      ${position.slug || null},
      ${position.eventSlug || null},
      ${avgPrice},
      ${positionSize},
      ${now}::timestamptz,
      ${positionSize},
      ${avgPrice},
      ${curPrice},
      ${initialValue},
      ${currentValue},
      ${position.cashPnl || 0},
      ${now}::timestamptz,
      ${0.25},
      ${MIN_POSITION_VALUE},
      ${avgPrice <= 0.25},
      ${true},
      ${currentValue},
      ${'scan-positions'}
    )
  `;

  metrics.positionsInserted++;
}

// Scan a single wallet's positions
async function scanWalletPositions(
  wallet: string,
  metrics: JobMetrics
): Promise<void> {
  try {
    const { positions } = await fetchPositionsWithRetry(wallet, POSITION_LIMIT_PER_WALLET);

    for (const position of positions) {
      const positionSize = position.size ?? 0;
      const curPrice = position.curPrice ?? 0;
      const currentValue = positionSize * curPrice;

      // Only process longshot positions (odds <= 25%) with value >= $2,500
      if (currentValue >= MIN_POSITION_VALUE) {
        // Check if it's a longshot (current price <= 25%)
        if (curPrice > LONGSHOT_THRESHOLD) {
          metrics.positionsSkippedNotLongshot++;
          continue;
        }
        metrics.positionsFound++;
        await insertPosition(wallet, position, metrics);
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    metrics.errors.push(`${wallet}: ${errorMsg.slice(0, 100)}`);
  }
}

export async function POST(request: Request) {
  if (!isCronAuthed(request)) {
    return cronUnauthorized();
  }

  const startTime = Date.now();
  const metrics: JobMetrics = {
    walletsScanned: 0,
    positionsFound: 0,
    positionsInserted: 0,
    positionsSkippedExists: 0,
    positionsSkippedResolved: 0,
    positionsSkippedNotLongshot: 0,
    errors: [],
  };

  try {
    // Record job start
    const jobRunResult = await sql<{ id: string }>`
      INSERT INTO job_runs (job_name, status, started_at, metrics)
      VALUES (${JOB_NAME}, 'running', NOW(), ${JSON.stringify(metrics)})
      RETURNING id
    `;
    const jobRunId = jobRunResult.rows[0]?.id;
    console.log(`[${JOB_NAME}] Started job ${jobRunId}`);

    // Get wallets to scan
    const wallets = await getWalletsToScan();
    metrics.walletsScanned = wallets.length;

    if (wallets.length === 0) {
      const durationMs = Date.now() - startTime;
      await sql`
        UPDATE job_runs
        SET status = 'success', finished_at = NOW(), duration_ms = ${durationMs}, metrics = ${JSON.stringify(metrics)}
        WHERE id = ${jobRunId}
      `;
      return NextResponse.json({
        jobRunId,
        status: 'success',
        message: 'No wallets to scan',
        ...metrics,
        durationMs,
      }, { headers: NO_CACHE_HEADERS });
    }

    console.log(`[${JOB_NAME}] Scanning ${wallets.length} wallets for $${MIN_POSITION_VALUE}+ positions`);

    // Scan wallets with concurrency limit
    await Promise.all(
      wallets.map(wallet =>
        walletLimit(() => scanWalletPositions(wallet, metrics))
      )
    );

    // Record job completion
    const durationMs = Date.now() - startTime;
    await sql`
      UPDATE job_runs
      SET status = 'success', finished_at = NOW(), duration_ms = ${durationMs}, metrics = ${JSON.stringify(metrics)}
      WHERE id = ${jobRunId}
    `;

    // Structured log for observability
    console.info(JSON.stringify({
      job: JOB_NAME,
      ok: true,
      durationMs,
      walletsScanned: metrics.walletsScanned,
      positionsFound: metrics.positionsFound,
      positionsInserted: metrics.positionsInserted,
      positionsSkippedExists: metrics.positionsSkippedExists,
      positionsSkippedResolved: metrics.positionsSkippedResolved,
      positionsSkippedNotLongshot: metrics.positionsSkippedNotLongshot,
      errorCount: metrics.errors.length,
    }));

    return NextResponse.json({
      jobRunId,
      status: 'success',
      ...metrics,
      durationMs,
    }, { headers: NO_CACHE_HEADERS });

  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    console.error(`[${JOB_NAME}] Job failed:`, errorMessage);

    return NextResponse.json(
      { error: 'Position scan failed', details: errorMessage },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}

// GET endpoint for Vercel Cron compatibility
export async function GET(request: Request) {
  return POST(request);
}
