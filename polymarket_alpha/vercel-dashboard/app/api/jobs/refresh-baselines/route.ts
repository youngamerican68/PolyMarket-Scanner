// /app/api/jobs/refresh-baselines/route.ts
// Phase 5 (Hardened): Baseline refresh job for conviction sizing anomaly detection
// Computes median and MAD for wallet trade sizes over 90-day lookback
// Optimized: Uses set-based SQL instead of per-wallet loops where possible

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import {
  BASELINE_LOOKBACK_DAYS,
  MIN_TRADES,
  ACTIVE_DAYS,
  constantTimeCompare,
} from '@/lib/anomaly-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes max for cron job

const JOB_NAME = 'refresh-baselines';
const ADVISORY_LOCK_KEY = 987654321; // Different key from refresh-prices

// Response headers to prevent caching
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

// Auth check using constant-time comparison
function isAuthorized(request: Request): boolean {
  const url = new URL(request.url);
  const authHeader = request.headers.get('authorization');
  const expectedSecret = process.env.CRON_SECRET;

  // Check for Bearer token (CRON_SECRET)
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (expectedSecret && constantTimeCompare(token, expectedSecret)) {
      return true;
    }
  }

  // Check for x-cron-secret header (alternative)
  const cronSecretHeader = request.headers.get('x-cron-secret');
  if (expectedSecret && cronSecretHeader && constantTimeCompare(cronSecretHeader, expectedSecret)) {
    return true;
  }

  // Check for query param fallback (for /api/jobs/* only)
  const cronSecretParam = url.searchParams.get('cronSecret');
  if (expectedSecret && cronSecretParam && constantTimeCompare(cronSecretParam, expectedSecret)) {
    return true;
  }

  // If CRON_SECRET is not set, allow only in dev mode
  if (!expectedSecret) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[refresh-baselines] CRON_SECRET not set - allowing in dev mode');
      return true;
    }
    console.error('[refresh-baselines] CRON_SECRET not set - denying in production');
    return false;
  }

  // Check if middleware passed the request (Basic Auth)
  const middlewareAuth = request.headers.get('x-middleware-auth');
  if (middlewareAuth === 'passed') {
    return true;
  }

  return false;
}

interface JobMetrics {
  walletsFound: number;
  baselinesComputed: number;
  walletsSkipped: number;
  errors: number;
  method: 'set-based' | 'per-wallet';
}

// Try to acquire advisory lock
async function tryAcquireLock(): Promise<boolean> {
  try {
    const result = await sql<{ acquired: boolean }>`
      SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) as acquired
    `;
    return result.rows[0]?.acquired === true;
  } catch (err) {
    console.error('[refresh-baselines] Failed to acquire advisory lock:', err);
    return false;
  }
}

// Release advisory lock
async function releaseLock(): Promise<void> {
  try {
    await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
  } catch (err) {
    console.error('[refresh-baselines] Failed to release advisory lock:', err);
  }
}

// Dry-run mode: return stats without mutations
async function handleDryRun() {
  try {
    const activeCutoff = new Date(Date.now() - ACTIVE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const lookbackCutoff = new Date(Date.now() - BASELINE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const statsResult = await sql<{
      active_wallets: number;
      eligible_wallets: number;
      total_trades_in_lookback: number;
      existing_baselines: number;
      stale_baselines: number;
    }>`
      WITH active_wallets AS (
        SELECT DISTINCT wallet
        FROM alert_events
        WHERE fill_timestamp >= ${activeCutoff}::timestamptz
      ),
      eligible_wallets AS (
        SELECT wallet, COUNT(*) as cnt
        FROM alert_events ae
        INNER JOIN active_wallets aw USING (wallet)
        WHERE ae.fill_timestamp >= ${lookbackCutoff}::timestamptz
        GROUP BY wallet
        HAVING COUNT(*) >= ${MIN_TRADES}
      )
      SELECT
        (SELECT COUNT(*) FROM active_wallets)::int as active_wallets,
        (SELECT COUNT(*) FROM eligible_wallets)::int as eligible_wallets,
        (SELECT COUNT(*) FROM alert_events WHERE fill_timestamp >= ${lookbackCutoff}::timestamptz)::int as total_trades_in_lookback,
        (SELECT COUNT(*) FROM wallet_trade_size_baselines)::int as existing_baselines,
        (SELECT COUNT(*) FROM wallet_trade_size_baselines WHERE computed_at < NOW() - INTERVAL '1 day')::int as stale_baselines
    `;

    const stats = statsResult.rows[0];

    return NextResponse.json({
      dryRun: true,
      message: 'Dry-run mode: no mutations performed',
      config: {
        ACTIVE_DAYS,
        BASELINE_LOOKBACK_DAYS,
        MIN_TRADES,
        activeCutoff,
        lookbackCutoff,
      },
      stats: {
        activeWallets: stats?.active_wallets || 0,
        eligibleWallets: stats?.eligible_wallets || 0,
        totalTradesInLookback: stats?.total_trades_in_lookback || 0,
        existingBaselines: stats?.existing_baselines || 0,
        staleBaselines: stats?.stale_baselines || 0,
        wouldCompute: stats?.eligible_wallets || 0,
      },
    }, { headers: NO_CACHE_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: 'Dry-run failed', details: String(err) },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}

export async function POST(request: Request) {
  // Auth check
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: NO_CACHE_HEADERS }
    );
  }

  // Check for dry-run mode (stats only, no mutations)
  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';

  if (dryRun) {
    return handleDryRun();
  }

  // Try to acquire advisory lock
  const lockAcquired = await tryAcquireLock();
  if (!lockAcquired) {
    console.warn('[refresh-baselines] Another job is already running');
    return NextResponse.json(
      { error: 'Job already running', code: 'LOCK_NOT_ACQUIRED' },
      { status: 409, headers: NO_CACHE_HEADERS }
    );
  }

  const startTime = Date.now();
  const jobRunId = crypto.randomUUID();
  const metrics: JobMetrics = {
    walletsFound: 0,
    baselinesComputed: 0,
    walletsSkipped: 0,
    errors: 0,
    method: 'set-based',
  };

  try {
    // Insert job_runs record
    await sql`
      INSERT INTO job_runs (id, job_name, status, started_at)
      VALUES (${jobRunId}, ${JOB_NAME}, 'running', NOW())
    `;
    console.log(`[refresh-baselines] Started job ${jobRunId}`);

    // Calculate cutoffs
    const activeCutoff = new Date(Date.now() - ACTIVE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const lookbackCutoff = new Date(Date.now() - BASELINE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Try set-based approach first: compute all baselines in a single query
    // This is much faster but requires PostgreSQL to handle PERCENTILE_CONT per group
    try {
      const setBasedResult = await sql`
        WITH active_wallets AS (
          SELECT DISTINCT wallet
          FROM alert_events
          WHERE fill_timestamp >= ${activeCutoff}::timestamptz
        ),
        wallet_stats AS (
          SELECT
            ae.wallet,
            COUNT(*)::int as trade_count,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ae.fill_value_usd) as median_notional,
            MIN(ae.fill_timestamp) as lookback_start,
            MAX(ae.fill_timestamp) as lookback_end
          FROM alert_events ae
          INNER JOIN active_wallets aw ON ae.wallet = aw.wallet
          WHERE ae.fill_timestamp >= ${lookbackCutoff}::timestamptz
          GROUP BY ae.wallet
          HAVING COUNT(*) >= ${MIN_TRADES}
        ),
        wallet_mad AS (
          SELECT
            ws.wallet,
            ws.trade_count,
            ws.median_notional,
            ws.lookback_start,
            ws.lookback_end,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(ae.fill_value_usd - ws.median_notional)) as mad
          FROM wallet_stats ws
          INNER JOIN alert_events ae ON ws.wallet = ae.wallet
          WHERE ae.fill_timestamp >= ${lookbackCutoff}::timestamptz
          GROUP BY ws.wallet, ws.trade_count, ws.median_notional, ws.lookback_start, ws.lookback_end
        )
        INSERT INTO wallet_trade_size_baselines
          (wallet, trade_count, median_notional, mad, lookback_start, lookback_end, computed_at)
        SELECT
          wallet,
          trade_count,
          median_notional,
          COALESCE(mad, 0),
          lookback_start,
          lookback_end,
          NOW()
        FROM wallet_mad
        ON CONFLICT (wallet)
        DO UPDATE SET
          trade_count = EXCLUDED.trade_count,
          median_notional = EXCLUDED.median_notional,
          mad = EXCLUDED.mad,
          lookback_start = EXCLUDED.lookback_start,
          lookback_end = EXCLUDED.lookback_end,
          computed_at = NOW()
      `;

      metrics.baselinesComputed = setBasedResult.rowCount || 0;
      metrics.method = 'set-based';

      // Count active wallets and skipped
      const countResult = await sql<{ active: number; eligible: number }>`
        WITH active_wallets AS (
          SELECT DISTINCT wallet
          FROM alert_events
          WHERE fill_timestamp >= ${activeCutoff}::timestamptz
        ),
        eligible_wallets AS (
          SELECT wallet, COUNT(*) as cnt
          FROM alert_events ae
          INNER JOIN active_wallets aw USING (wallet)
          WHERE ae.fill_timestamp >= ${lookbackCutoff}::timestamptz
          GROUP BY wallet
          HAVING COUNT(*) >= ${MIN_TRADES}
        )
        SELECT
          (SELECT COUNT(*) FROM active_wallets)::int as active,
          (SELECT COUNT(*) FROM eligible_wallets)::int as eligible
      `;

      metrics.walletsFound = countResult.rows[0]?.active || 0;
      metrics.walletsSkipped = metrics.walletsFound - metrics.baselinesComputed;

      console.log(`[refresh-baselines] Set-based: ${metrics.baselinesComputed} baselines computed from ${metrics.walletsFound} active wallets`);

    } catch (setBasedErr) {
      // Fall back to per-wallet approach if set-based fails
      console.warn('[refresh-baselines] Set-based approach failed, falling back to per-wallet:', String(setBasedErr).slice(0, 100));
      metrics.method = 'per-wallet';

      // Get active wallets
      const activeWalletsResult = await sql<{ wallet: string }>`
        SELECT DISTINCT wallet
        FROM alert_events
        WHERE fill_timestamp >= ${activeCutoff}::timestamptz
        ORDER BY wallet
      `;

      const activeWallets = activeWalletsResult.rows.map(r => r.wallet);
      metrics.walletsFound = activeWallets.length;

      // Process each wallet
      for (const wallet of activeWallets) {
        try {
          // Get stats
          const statsResult = await sql<{
            trade_count: number;
            median_notional: number;
            lookback_start: string;
            lookback_end: string;
          }>`
            WITH wallet_trades AS (
              SELECT fill_value_usd, fill_timestamp
              FROM alert_events
              WHERE wallet = ${wallet}
                AND fill_timestamp >= ${lookbackCutoff}::timestamptz
            )
            SELECT
              COUNT(*)::int as trade_count,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY fill_value_usd) as median_notional,
              MIN(fill_timestamp)::text as lookback_start,
              MAX(fill_timestamp)::text as lookback_end
            FROM wallet_trades
          `;

          const stats = statsResult.rows[0];
          if (!stats || stats.trade_count < MIN_TRADES) {
            metrics.walletsSkipped++;
            continue;
          }

          // Get MAD
          const madResult = await sql<{ mad: number }>`
            WITH wallet_trades AS (
              SELECT fill_value_usd
              FROM alert_events
              WHERE wallet = ${wallet}
                AND fill_timestamp >= ${lookbackCutoff}::timestamptz
            ),
            median_val AS (
              SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY fill_value_usd) as med
              FROM wallet_trades
            )
            SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(fill_value_usd - median_val.med)) as mad
            FROM wallet_trades, median_val
          `;

          const mad = madResult.rows[0]?.mad ?? 0;

          // Upsert
          await sql`
            INSERT INTO wallet_trade_size_baselines
              (wallet, trade_count, median_notional, mad, lookback_start, lookback_end, computed_at)
            VALUES
              (${wallet}, ${stats.trade_count}, ${stats.median_notional}, ${mad},
               ${stats.lookback_start}::timestamptz, ${stats.lookback_end}::timestamptz, NOW())
            ON CONFLICT (wallet)
            DO UPDATE SET
              trade_count = EXCLUDED.trade_count,
              median_notional = EXCLUDED.median_notional,
              mad = EXCLUDED.mad,
              lookback_start = EXCLUDED.lookback_start,
              lookback_end = EXCLUDED.lookback_end,
              computed_at = NOW()
          `;

          metrics.baselinesComputed++;
        } catch (walletErr) {
          console.error(`[refresh-baselines] Error processing wallet:`, String(walletErr).slice(0, 80));
          metrics.errors++;
        }
      }
    }

    // Mark job as success
    const durationMs = Date.now() - startTime;
    await sql`
      UPDATE job_runs
      SET status = 'success',
          finished_at = NOW(),
          duration_ms = ${durationMs},
          metrics = ${JSON.stringify(metrics)}
      WHERE id = ${jobRunId}
    `;

    console.log(`[refresh-baselines] Completed: ${metrics.baselinesComputed} baselines (${metrics.method}), ${durationMs}ms`);

    return NextResponse.json({
      jobRunId,
      status: 'success',
      ...metrics,
      durationMs,
    }, { headers: NO_CACHE_HEADERS });

  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    console.error('[refresh-baselines] Job failed:', String(err).slice(0, 200));

    try {
      await sql`
        UPDATE job_runs
        SET status = 'error',
            finished_at = NOW(),
            duration_ms = ${durationMs},
            metrics = ${JSON.stringify(metrics)},
            error = ${errorMessage.slice(0, 500)}
        WHERE id = ${jobRunId}
      `;
    } catch (updateErr) {
      console.error('[refresh-baselines] Failed to update job_runs');
    }

    return NextResponse.json({
      jobRunId,
      status: 'error',
      error: errorMessage.slice(0, 200),
      ...metrics,
      durationMs,
    }, { status: 500, headers: NO_CACHE_HEADERS });

  } finally {
    await releaseLock();
  }
}

// GET method for manual triggering
export async function GET(request: Request) {
  return POST(request);
}
