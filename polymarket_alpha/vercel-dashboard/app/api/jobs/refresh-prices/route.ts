// /app/api/jobs/refresh-prices/route.ts
// Phase 3: Price refresh cron job (hardened)
// Fetches current prices from Polymarket CLOB API and caches them in DB
// Wrapped with Phase 4 job tracking + advisory lock to prevent overlaps

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes max for cron job

const CLOB_API = 'https://clob.polymarket.com';
const JOB_NAME = 'refresh-prices';
const MAX_OUTCOMES_PER_RUN = 1000; // Hard cap to prevent runaway jobs
const ADVISORY_LOCK_KEY = 123456789; // Arbitrary constant for pg_advisory_lock

// Response headers to prevent caching
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

// Auth check - Bearer token (for cron), x-cron-secret header, query param, or Basic Auth (via middleware)
function isAuthorized(request: Request): boolean {
  const url = new URL(request.url);
  const authHeader = request.headers.get('authorization');

  // Check for Bearer token (CRON_SECRET)
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const expectedSecret = process.env.CRON_SECRET;
    if (expectedSecret && token === expectedSecret) {
      console.log('[refresh-prices] Auth: Bearer token');
      return true;
    }
  }

  // Check for x-cron-secret header (alternative)
  const cronSecretHeader = request.headers.get('x-cron-secret');
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret && cronSecretHeader === expectedSecret) {
    console.log('[refresh-prices] Auth: x-cron-secret header');
    return true;
  }

  // Check for query param fallback (for /api/jobs/* only)
  const cronSecretParam = url.searchParams.get('cronSecret');
  if (expectedSecret && cronSecretParam === expectedSecret) {
    console.log('[refresh-prices] Auth: query param');
    return true;
  }

  // If CRON_SECRET is not set, allow only in dev mode
  if (!expectedSecret) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[refresh-prices] CRON_SECRET not set - allowing in dev mode');
      return true;
    }
    console.error('[refresh-prices] CRON_SECRET not set - denying in production');
    return false;
  }

  // Check if middleware passed the request (Basic Auth)
  const middlewareAuth = request.headers.get('x-middleware-auth');
  if (middlewareAuth === 'passed') {
    console.log('[refresh-prices] Auth: middleware Basic Auth');
    return true;
  }

  return false;
}

interface JobMetrics {
  requested: number;
  updated: number;
  failed: number;
  batches: number;
  distinctMarkets: number;
  capApplied: boolean;
  oldestFetchedAt: string | null;
}

type OutcomeKey = {
  condition_id: string;
  outcome: string;
  asset: string;
};

// Fetch price for a single token from CLOB API
async function fetchTokenPrice(tokenId: string): Promise<number | null> {
  try {
    const res = await fetch(`${CLOB_API}/midpoint?token_id=${tokenId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    });

    if (!res.ok) {
      console.warn(`[refresh-prices] CLOB midpoint failed for ${tokenId}: ${res.status}`);
      return null;
    }

    const data = await res.json();
    // Response format: { mid: "0.25" } or similar
    if (data && data.mid !== undefined && data.mid !== null) {
      const price = parseFloat(data.mid);
      if (Number.isFinite(price) && price >= 0 && price <= 1) {
        return price;
      }
    }

    return null;
  } catch (err) {
    console.warn(`[refresh-prices] Error fetching price for ${tokenId}:`, err);
    return null;
  }
}

// Batch fetch prices with concurrency control
async function fetchPricesBatch(
  outcomes: OutcomeKey[],
  batchSize: number = 50
): Promise<Map<string, number>> {
  const results = new Map<string, number>();

  // Group by asset to avoid duplicate fetches
  const assetToOutcomes = new Map<string, OutcomeKey[]>();
  for (const o of outcomes) {
    const existing = assetToOutcomes.get(o.asset) || [];
    existing.push(o);
    assetToOutcomes.set(o.asset, existing);
  }

  const uniqueAssets = Array.from(assetToOutcomes.keys());

  // Process in batches with concurrency limit
  for (let i = 0; i < uniqueAssets.length; i += batchSize) {
    const batch = uniqueAssets.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (asset) => {
        const price = await fetchTokenPrice(asset);
        return { asset, price };
      })
    );

    for (const { asset, price } of batchResults) {
      if (price !== null) {
        results.set(asset, price);
      }
    }

    // Small delay between batches to avoid rate limiting
    if (i + batchSize < uniqueAssets.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  return results;
}

// Try to acquire advisory lock, returns true if acquired
async function tryAcquireLock(): Promise<boolean> {
  try {
    const result = await sql<{ acquired: boolean }>`
      SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) as acquired
    `;
    return result.rows[0]?.acquired === true;
  } catch (err) {
    console.error('[refresh-prices] Failed to acquire advisory lock:', err);
    return false;
  }
}

// Release advisory lock
async function releaseLock(): Promise<void> {
  try {
    await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
  } catch (err) {
    console.error('[refresh-prices] Failed to release advisory lock:', err);
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

  // Try to acquire advisory lock to prevent overlapping runs
  const lockAcquired = await tryAcquireLock();
  if (!lockAcquired) {
    console.warn('[refresh-prices] Another job is already running (lock not acquired)');
    return NextResponse.json(
      { error: 'Job already running', code: 'LOCK_NOT_ACQUIRED' },
      { status: 409, headers: NO_CACHE_HEADERS }
    );
  }

  const startTime = Date.now();
  const jobRunId = crypto.randomUUID();
  const metrics: JobMetrics = {
    requested: 0,
    updated: 0,
    failed: 0,
    batches: 0,
    distinctMarkets: 0,
    capApplied: false,
    oldestFetchedAt: null,
  };

  try {
    // Insert job_runs record with status 'running'
    await sql`
      INSERT INTO job_runs (id, job_name, status, started_at)
      VALUES (${jobRunId}, ${JOB_NAME}, 'running', NOW())
    `;
    console.log(`[refresh-prices] Started job ${jobRunId}`);

    // Step 1: Query distinct (condition_id, outcome, asset) from recent alert_events (72h)
    // Use deterministic ordering (by condition_id, outcome) with hard cap
    const recentOutcomes = await sql<OutcomeKey>`
      SELECT DISTINCT condition_id, outcome, asset
      FROM alert_events
      WHERE fill_timestamp >= NOW() - INTERVAL '72 hours'
        AND asset IS NOT NULL
      ORDER BY condition_id, outcome
      LIMIT ${MAX_OUTCOMES_PER_RUN}
    `;

    const outcomes = recentOutcomes.rows;
    metrics.requested = outcomes.length;
    metrics.capApplied = outcomes.length === MAX_OUTCOMES_PER_RUN;

    if (outcomes.length === 0) {
      // No outcomes to refresh - mark success
      const durationMs = Date.now() - startTime;
      await sql`
        UPDATE job_runs
        SET status = 'success',
            finished_at = NOW(),
            duration_ms = ${durationMs},
            metrics = ${JSON.stringify(metrics)}
        WHERE id = ${jobRunId}
      `;

      return NextResponse.json({
        jobRunId,
        status: 'success',
        message: 'No outcomes to refresh',
        ...metrics,
        durationMs,
      }, { headers: NO_CACHE_HEADERS });
    }

    // Count distinct markets
    const marketSet = new Set(outcomes.map(o => o.condition_id));
    metrics.distinctMarkets = marketSet.size;

    console.log(`[refresh-prices] Fetching prices for ${outcomes.length} outcomes across ${metrics.distinctMarkets} markets${metrics.capApplied ? ' (cap applied)' : ''}`);

    // Step 2: Fetch prices from CLOB API
    const pricesByAsset = await fetchPricesBatch(outcomes, 50);
    metrics.batches = Math.ceil(new Set(outcomes.map(o => o.asset)).size / 50);

    // Step 3: Upsert into outcome_price_cache
    for (const outcome of outcomes) {
      const price = pricesByAsset.get(outcome.asset);

      if (price !== null && price !== undefined) {
        try {
          await sql`
            INSERT INTO outcome_price_cache (condition_id, outcome, price, fetched_at, source)
            VALUES (${outcome.condition_id}, ${outcome.outcome}, ${price}, NOW(), 'clob_midpoint')
            ON CONFLICT (condition_id, outcome)
            DO UPDATE SET price = EXCLUDED.price, fetched_at = NOW(), source = 'clob_midpoint'
          `;
          metrics.updated++;
        } catch (err) {
          console.error(`[refresh-prices] Upsert failed for ${outcome.condition_id}/${outcome.outcome}:`, err);
          metrics.failed++;
        }
      } else {
        metrics.failed++;
      }
    }

    // Get oldest fetched_at for metrics
    try {
      const oldestResult = await sql<{ oldest: string }>`
        SELECT MIN(fetched_at)::text as oldest FROM outcome_price_cache
      `;
      metrics.oldestFetchedAt = oldestResult.rows[0]?.oldest || null;
    } catch {
      // Non-critical, ignore
    }

    // Step 4: Mark job as success
    const durationMs = Date.now() - startTime;
    await sql`
      UPDATE job_runs
      SET status = 'success',
          finished_at = NOW(),
          duration_ms = ${durationMs},
          metrics = ${JSON.stringify(metrics)}
      WHERE id = ${jobRunId}
    `;

    console.log(`[refresh-prices] Completed: ${metrics.updated} updated, ${metrics.failed} failed, ${durationMs}ms`);

    return NextResponse.json({
      jobRunId,
      status: 'success',
      ...metrics,
      durationMs,
    }, { headers: NO_CACHE_HEADERS });

  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    console.error('[refresh-prices] Job failed:', err);

    // Try to update job_runs with error status
    try {
      await sql`
        UPDATE job_runs
        SET status = 'error',
            finished_at = NOW(),
            duration_ms = ${durationMs},
            metrics = ${JSON.stringify(metrics)},
            error = ${errorMessage}
        WHERE id = ${jobRunId}
      `;
    } catch (updateErr) {
      console.error('[refresh-prices] Failed to update job_runs:', updateErr);
    }

    return NextResponse.json({
      jobRunId,
      status: 'error',
      error: errorMessage,
      ...metrics,
      durationMs,
    }, { status: 500, headers: NO_CACHE_HEADERS });

  } finally {
    // Always release the advisory lock
    await releaseLock();
  }
}

// GET method for manual triggering or health check
export async function GET(request: Request) {
  // Allow GET to trigger the job for easy testing
  return POST(request);
}
