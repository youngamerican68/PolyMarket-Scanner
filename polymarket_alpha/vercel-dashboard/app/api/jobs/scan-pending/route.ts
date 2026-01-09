// /app/api/jobs/scan-pending/route.ts
// Re-scans wallets that made longshot trades but were skipped due to position below threshold
// Captures them once their positions grow to meet the $2,500 threshold

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
const LONGSHOT_THRESHOLD = 0.25;
const WALLET_CONCURRENCY = 10;
const MAX_WALLETS_PER_RUN = 200;
const POSITION_LIMIT_PER_WALLET = 100;
const EXPIRE_AFTER_DAYS = 30; // Expire wallets pending for over 30 days
const JOB_NAME = 'scan-pending';

const walletLimit = pLimit(WALLET_CONCURRENCY);

interface JobMetrics {
  pendingWalletsFound: number;
  walletsScanned: number;
  positionsFound: number;
  positionsInserted: number;
  positionsSkippedExists: number;
  positionsSkippedResolved: number;
  walletsCaptured: number;
  walletsExpired: number;
  errors: string[];
}

interface PendingWallet {
  wallet: string;
  first_seen_at: string;
  last_condition_id: string;
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
): Promise<boolean> {
  const walletLower = wallet.toLowerCase();
  const conditionId = position.conditionId;
  const outcome = position.outcome || 'Yes';

  if (await positionExists(walletLower, conditionId, outcome)) {
    metrics.positionsSkippedExists++;
    return false;
  }

  if (await isMarketResolved(conditionId)) {
    metrics.positionsSkippedResolved++;
    return false;
  }

  const positionSize = position.size ?? 0;
  const avgPrice = position.avgPrice ?? 0;
  const curPrice = position.curPrice ?? 0;
  const currentValue = positionSize * curPrice;
  const initialValue = position.initialValue ?? currentValue;

  const id = crypto.randomUUID();
  const tradeDedupeId = `pending-${walletLower}-${conditionId}-${outcome}-${Date.now()}`;
  const now = new Date().toISOString();
  const fillValueUsd = (positionSize * avgPrice).toFixed(2);
  const outcomeIndex = position.outcomeIndex ?? (outcome === 'Yes' ? 0 : 1);

  await sql`
    INSERT INTO alert_events (
      id, trade_dedupe_id, wallet, asset, condition_id, outcome, outcome_index,
      side, title, slug, event_slug, fill_price, fill_size, fill_value_usd,
      fill_timestamp, position_size, position_avg_price, position_cur_price,
      position_initial_value, position_current_value, position_cash_pnl,
      position_snapshot_at, longshot_threshold, min_position_threshold,
      qualifies_longshot, qualifies_min_position, threshold_value_used, threshold_source
    ) VALUES (
      ${id}, ${tradeDedupeId}, ${walletLower}, ${position.asset}, ${conditionId},
      ${outcome}, ${outcomeIndex}, ${'BUY'}, ${position.title || null},
      ${position.slug || null}, ${position.eventSlug || null}, ${avgPrice},
      ${positionSize}, ${fillValueUsd}, ${now}::timestamptz, ${positionSize},
      ${avgPrice}, ${curPrice}, ${initialValue}, ${currentValue},
      ${position.cashPnl || 0}, ${now}::timestamptz, ${LONGSHOT_THRESHOLD},
      ${MIN_POSITION_VALUE}, ${avgPrice <= LONGSHOT_THRESHOLD}, ${true},
      ${currentValue}, ${'scan-pending'}
    )
    ON CONFLICT (trade_dedupe_id) DO NOTHING
  `;

  metrics.positionsInserted++;
  return true;
}

// Scan a wallet's positions and capture qualifying ones
async function scanWalletPositions(
  pendingWallet: PendingWallet,
  metrics: JobMetrics
): Promise<boolean> {
  const { wallet } = pendingWallet;
  let captured = false;

  try {
    const { positions } = await fetchPositionsWithRetry(wallet, POSITION_LIMIT_PER_WALLET);

    for (const position of positions) {
      const positionSize = position.size ?? 0;
      const avgPrice = position.avgPrice ?? 0;
      const curPrice = position.curPrice ?? 0;
      const currentValue = positionSize * curPrice;
      const costBasis = positionSize * avgPrice;

      // Use max of currentValue and costBasis for threshold
      const thresholdValue = Math.max(currentValue, costBasis);

      // Only process positions that qualify
      if (thresholdValue >= MIN_POSITION_VALUE && avgPrice <= LONGSHOT_THRESHOLD) {
        metrics.positionsFound++;
        const inserted = await insertPosition(wallet, position, metrics);
        if (inserted) {
          captured = true;
        }
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (metrics.errors.length < 10) {
      metrics.errors.push(`${wallet.slice(0, 10)}: ${errorMsg.slice(0, 50)}`);
    }
  }

  return captured;
}

export async function POST(request: Request) {
  if (!isCronAuthed(request)) {
    return cronUnauthorized();
  }

  const startTime = Date.now();
  const metrics: JobMetrics = {
    pendingWalletsFound: 0,
    walletsScanned: 0,
    positionsFound: 0,
    positionsInserted: 0,
    positionsSkippedExists: 0,
    positionsSkippedResolved: 0,
    walletsCaptured: 0,
    walletsExpired: 0,
    errors: [],
  };

  try {
    const jobRunResult = await sql<{ id: string }>`
      INSERT INTO job_runs (job_name, status, started_at, metrics)
      VALUES (${JOB_NAME}, 'running', NOW(), ${JSON.stringify(metrics)})
      RETURNING id
    `;
    const jobRunId = jobRunResult.rows[0]?.id;
    console.log(`[${JOB_NAME}] Started job ${jobRunId}`);

    // Step 1: Expire old pending wallets (30+ days old)
    const expireResult = await sql`
      UPDATE pending_longshot_wallets
      SET status = 'expired'
      WHERE status = 'pending'
        AND first_seen_at < NOW() - INTERVAL '30 days'
      RETURNING wallet
    `;
    metrics.walletsExpired = expireResult.rows.length;
    if (metrics.walletsExpired > 0) {
      console.log(`[${JOB_NAME}] Expired ${metrics.walletsExpired} old pending wallets`);
    }

    // Step 2: Get pending wallets to scan
    const pendingResult = await sql<PendingWallet>`
      SELECT wallet, first_seen_at, last_condition_id
      FROM pending_longshot_wallets
      WHERE status = 'pending'
      ORDER BY last_trade_at DESC
      LIMIT ${MAX_WALLETS_PER_RUN}
    `;

    const pendingWallets = pendingResult.rows;
    metrics.pendingWalletsFound = pendingWallets.length;

    if (pendingWallets.length === 0) {
      const durationMs = Date.now() - startTime;
      await sql`
        UPDATE job_runs
        SET status = 'success', finished_at = NOW(), duration_ms = ${durationMs}, metrics = ${JSON.stringify(metrics)}
        WHERE id = ${jobRunId}
      `;
      return NextResponse.json({
        jobRunId,
        status: 'success',
        message: 'No pending wallets to scan',
        ...metrics,
        durationMs,
      }, { headers: NO_CACHE_HEADERS });
    }

    console.log(`[${JOB_NAME}] Scanning ${pendingWallets.length} pending wallets...`);

    // Step 3: Scan wallets concurrently
    const results = await Promise.all(
      pendingWallets.map(pendingWallet =>
        walletLimit(async () => {
          metrics.walletsScanned++;
          const captured = await scanWalletPositions(pendingWallet, metrics);
          return { wallet: pendingWallet.wallet, captured };
        })
      )
    );

    // Step 4: Mark captured wallets
    const capturedWallets = results.filter(r => r.captured).map(r => r.wallet);
    if (capturedWallets.length > 0) {
      // Update each captured wallet individually (safer for @vercel/postgres)
      for (const wallet of capturedWallets) {
        await sql`
          UPDATE pending_longshot_wallets
          SET status = 'captured'
          WHERE wallet = ${wallet}
        `;
      }
      metrics.walletsCaptured = capturedWallets.length;
      console.log(`[${JOB_NAME}] Captured ${capturedWallets.length} wallets`);
    }

    // Step 5: Update last_scanned_at for all scanned wallets
    for (const pendingWallet of pendingWallets) {
      await sql`
        UPDATE pending_longshot_wallets
        SET last_scanned_at = NOW()
        WHERE wallet = ${pendingWallet.wallet}
      `;
    }

    // Record job completion
    const durationMs = Date.now() - startTime;
    await sql`
      UPDATE job_runs
      SET status = 'success', finished_at = NOW(), duration_ms = ${durationMs}, metrics = ${JSON.stringify(metrics)}
      WHERE id = ${jobRunId}
    `;

    console.info(JSON.stringify({
      job: JOB_NAME,
      ok: true,
      durationMs,
      ...metrics,
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
      { error: 'Pending wallet scan failed', details: errorMessage },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}

export async function GET(request: Request) {
  return POST(request);
}
