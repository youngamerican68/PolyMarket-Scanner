// /app/api/jobs/sync-positions/route.ts
// Cron job to sync positions from Polymarket API into position_sync_overlay
// Runs every 15 minutes to keep dashboard data fresh
//
// This reuses the same logic as the manual sync endpoint (/api/positions/refresh)
// but is triggered automatically by Vercel Cron.

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import pLimit from 'p-limit';
import { fetchPositionsWithRetry, Position } from '@/lib/polymarket';
import { isCronAuthed, cronUnauthorized } from '@/lib/cronAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes max for cron job

// Response headers to prevent caching
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

// Configuration
const SYNC_CONCURRENCY = 5; // Wallets synced in parallel
const POSITION_LIMIT_PER_WALLET = 100;
const ALERT_WINDOW_HOURS = 72;
const MAX_WALLETS_PER_RUN = 100; // Cap per cron run to prevent timeouts
const JOB_NAME = 'sync-positions';

// Create concurrency limiter
const syncLimit = pLimit(SYNC_CONCURRENCY);

interface JobMetrics {
  walletsRequested: number;
  walletsSynced: number;
  walletsFailed: number;
  rowsUpdated: number;
  rowsNotFound: number;
  errors: string[];
}

// Get distinct wallets from alert_events (unresolved markets only)
async function getWalletsToSync(): Promise<string[]> {
  const cutoff = new Date(Date.now() - ALERT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const result = await sql<{ wallet: string }>`
    SELECT DISTINCT ae.wallet
    FROM alert_events ae
    LEFT JOIN market_status ms ON ae.condition_id = ms.condition_id
    WHERE ae.fill_timestamp >= ${cutoff}::timestamptz
      AND ae.position_current_value IS NOT NULL
      AND (
        ms.market_resolved IS NOT TRUE
        OR ms.winning_outcome IS NULL
        OR TRIM(ms.winning_outcome) = ''
      )
    ORDER BY ae.wallet
    LIMIT ${MAX_WALLETS_PER_RUN}
  `;

  return result.rows.map(r => r.wallet);
}

// Get condition_id + outcome pairs for a wallet
async function getDashboardRowsForWallet(
  wallet: string
): Promise<Array<{ condition_id: string; outcome: string }>> {
  const cutoff = new Date(Date.now() - ALERT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const result = await sql<{ condition_id: string; outcome: string }>`
    SELECT DISTINCT ae.condition_id, ae.outcome
    FROM alert_events ae
    LEFT JOIN market_status ms ON ae.condition_id = ms.condition_id
    WHERE ae.wallet = ${wallet.toLowerCase()}
      AND ae.fill_timestamp >= ${cutoff}::timestamptz
      AND ae.position_current_value IS NOT NULL
      AND (
        ms.market_resolved IS NOT TRUE
        OR ms.winning_outcome IS NULL
        OR TRIM(ms.winning_outcome) = ''
      )
  `;

  return result.rows;
}

// Sync positions for a single wallet
async function syncWalletPositions(
  wallet: string,
  metrics: JobMetrics
): Promise<void> {
  const walletLower = wallet.toLowerCase();

  try {
    // Fetch positions from Polymarket API
    const { positions } = await fetchPositionsWithRetry(walletLower, POSITION_LIMIT_PER_WALLET);

    // Get dashboard rows for this wallet (unresolved markets only)
    const dashboardRows = await getDashboardRowsForWallet(walletLower);

    // Create sync timestamp for this batch
    const syncTimestamp = new Date().toISOString();

    // For each dashboard row, find matching position and upsert overlay
    for (const row of dashboardRows) {
      const matchingPosition = positions.find(
        p => p.conditionId === row.condition_id && p.outcome === row.outcome
      );

      if (matchingPosition) {
        // Position found - update synced_* AND last_known_* fields
        const positionSize = matchingPosition.size ?? 0;
        const avgPrice = matchingPosition.avgPrice ?? 0;
        const currentValue = matchingPosition.currentValue ?? 0;
        const payoutIfWins = positionSize;

        await sql`
          INSERT INTO position_sync_overlay (
            wallet, condition_id, outcome,
            synced_position_size, synced_avg_price, synced_current_value, synced_payout_if_wins,
            last_known_position_size, last_known_avg_price, last_known_current_value, last_known_payout_if_wins,
            synced_at, sync_status, sync_error, position_state, last_nonzero_at
          )
          VALUES (
            ${walletLower}, ${row.condition_id}, ${row.outcome},
            ${positionSize}, ${avgPrice}, ${currentValue}, ${payoutIfWins},
            ${positionSize}, ${avgPrice}, ${currentValue}, ${payoutIfWins},
            ${syncTimestamp}::timestamptz, 'synced', NULL, 'open', ${syncTimestamp}::timestamptz
          )
          ON CONFLICT (wallet, condition_id, outcome) DO UPDATE SET
            synced_position_size = EXCLUDED.synced_position_size,
            synced_avg_price = EXCLUDED.synced_avg_price,
            synced_current_value = EXCLUDED.synced_current_value,
            synced_payout_if_wins = EXCLUDED.synced_payout_if_wins,
            last_known_position_size = EXCLUDED.last_known_position_size,
            last_known_avg_price = EXCLUDED.last_known_avg_price,
            last_known_current_value = EXCLUDED.last_known_current_value,
            last_known_payout_if_wins = EXCLUDED.last_known_payout_if_wins,
            synced_at = EXCLUDED.synced_at,
            sync_status = 'synced',
            sync_error = NULL,
            position_state = 'open',
            last_nonzero_at = EXCLUDED.last_nonzero_at
          WHERE position_sync_overlay.synced_at IS NULL
             OR position_sync_overlay.synced_at <= EXCLUDED.synced_at
        `;
        metrics.rowsUpdated++;
      } else {
        // Position not found - set synced_* to NULL, preserve last_known_*
        await sql`
          INSERT INTO position_sync_overlay (
            wallet, condition_id, outcome,
            synced_position_size, synced_avg_price, synced_current_value, synced_payout_if_wins,
            synced_at, sync_status, sync_error, position_state
          )
          VALUES (
            ${walletLower}, ${row.condition_id}, ${row.outcome},
            NULL, NULL, NULL, NULL,
            ${syncTimestamp}::timestamptz, 'not_found', 'Position not found in API response', 'not_found_in_sync'
          )
          ON CONFLICT (wallet, condition_id, outcome) DO UPDATE SET
            synced_position_size = NULL,
            synced_avg_price = NULL,
            synced_current_value = NULL,
            synced_payout_if_wins = NULL,
            synced_at = EXCLUDED.synced_at,
            sync_status = 'not_found',
            sync_error = EXCLUDED.sync_error,
            position_state = CASE
              WHEN position_sync_overlay.position_state IN ('closed_confirmed', 'redeemed_confirmed')
              THEN position_sync_overlay.position_state
              ELSE 'not_found_in_sync'
            END
          WHERE (
            position_sync_overlay.synced_at IS NULL
            OR position_sync_overlay.synced_at < EXCLUDED.synced_at
            OR (
              position_sync_overlay.synced_at = EXCLUDED.synced_at
              AND position_sync_overlay.sync_status IS DISTINCT FROM 'synced'
            )
          )
          AND position_sync_overlay.position_state NOT IN ('closed_confirmed', 'redeemed_confirmed')
        `;
        metrics.rowsNotFound++;
      }
    }

    // Update wallet sync state
    await sql`
      INSERT INTO wallet_sync_state (wallet, last_synced_at, last_sync_status, positions_count)
      VALUES (${walletLower}, NOW(), 'success', ${positions.length})
      ON CONFLICT (wallet) DO UPDATE SET
        last_synced_at = NOW(),
        last_sync_status = 'success',
        positions_count = EXCLUDED.positions_count,
        last_sync_error = NULL
    `;

    metrics.walletsSynced++;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    metrics.walletsFailed++;
    metrics.errors.push(`${wallet}: ${errorMsg.slice(0, 100)}`);

    // Update wallet sync state with error
    await sql`
      INSERT INTO wallet_sync_state (wallet, last_synced_at, last_sync_status, last_sync_error)
      VALUES (${walletLower}, NOW(), 'error', ${errorMsg.slice(0, 500)})
      ON CONFLICT (wallet) DO UPDATE SET
        last_synced_at = NOW(),
        last_sync_status = 'error',
        last_sync_error = EXCLUDED.last_sync_error
    `;
  }
}

export async function POST(request: Request) {
  // Auth check
  if (!isCronAuthed(request)) {
    return cronUnauthorized();
  }

  const startTime = Date.now();
  const metrics: JobMetrics = {
    walletsRequested: 0,
    walletsSynced: 0,
    walletsFailed: 0,
    rowsUpdated: 0,
    rowsNotFound: 0,
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

    // Get wallets to sync (unresolved markets only)
    const wallets = await getWalletsToSync();
    metrics.walletsRequested = wallets.length;

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
        message: 'No wallets to sync',
        ...metrics,
        durationMs,
      }, { headers: NO_CACHE_HEADERS });
    }

    console.log(`[${JOB_NAME}] Syncing ${wallets.length} wallets`);

    // Sync wallets with concurrency limit
    await Promise.all(
      wallets.map(wallet =>
        syncLimit(() => syncWalletPositions(wallet, metrics))
      )
    );

    // Record job completion
    const durationMs = Date.now() - startTime;
    await sql`
      UPDATE job_runs
      SET status = 'success', finished_at = NOW(), duration_ms = ${durationMs}, metrics = ${JSON.stringify(metrics)}
      WHERE id = ${jobRunId}
    `;

    // Structured JSON log for observability (grep-friendly)
    console.info(JSON.stringify({
      job: JOB_NAME,
      ok: true,
      durationMs,
      walletsConsidered: metrics.walletsRequested,
      walletsSynced: metrics.walletsSynced,
      positionsUpserted: metrics.rowsUpdated,
      positionsNotFound: metrics.rowsNotFound,
      errorCount: metrics.walletsFailed,
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

    // Structured JSON log for observability (grep-friendly)
    console.info(JSON.stringify({
      job: JOB_NAME,
      ok: false,
      durationMs,
      walletsConsidered: metrics.walletsRequested,
      walletsSynced: metrics.walletsSynced,
      positionsUpserted: metrics.rowsUpdated,
      positionsNotFound: metrics.rowsNotFound,
      errorCount: metrics.walletsFailed + 1, // +1 for the fatal error
      error: errorMessage.slice(0, 200),
    }));

    return NextResponse.json(
      { error: 'Position sync job failed', details: errorMessage },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}

// GET endpoint for Vercel Cron compatibility
export async function GET(request: Request) {
  // Vercel Cron sends GET requests, so we forward to POST
  return POST(request);
}
