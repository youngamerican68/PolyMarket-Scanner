// /app/api/jobs/refresh-prices/route.ts
// Phase 3: Price refresh cron job (hardened)
// Phase 6: Also checks market resolution status
// Fetches current prices from Polymarket CLOB API and caches them in DB
// Wrapped with Phase 4 job tracking + advisory lock to prevent overlaps

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { isCronAuthed, cronUnauthorized } from '@/lib/cronAuth';

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

// Auth check delegated to shared helper (lib/cronAuth.ts)
// Validates: Authorization: Bearer <CRON_SECRET> or x-cron-secret header (legacy)
// Uses constant-time comparison to prevent timing attacks

interface JobMetrics {
  requested: number;
  updated: number;
  failed: number;
  batches: number;
  distinctMarkets: number;
  capApplied: boolean;
  oldestFetchedAt: string | null;
  // Phase 6: Market resolution metrics
  marketsChecked: number;
  marketsResolved: number;
  marketsClosed: number;
  marketsSkipped: number;
}

// Phase 6: Market resolution data from CLOB API
interface MarketData {
  condition_id: string;
  closed: boolean;
  tokens: {
    token_id: string;
    outcome: string;
    winner: boolean;
    price?: number;
  }[];
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

// Phase 6: Fetch market resolution status from CLOB API
async function fetchMarketStatus(conditionId: string): Promise<MarketData | null> {
  try {
    const res = await fetch(`${CLOB_API}/markets/${conditionId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    });

    if (!res.ok) {
      if (res.status === 404) {
        // Market not found - skip silently
        return null;
      }
      console.warn(`[refresh-prices] Market status fetch failed for ${conditionId}: ${res.status}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    console.warn(`[refresh-prices] Error fetching market ${conditionId}:`, err);
    return null;
  }
}

// Phase 6: Check resolution status for markets and update market_status table
async function updateMarketResolutionStatus(
  conditionIds: string[],
  metrics: JobMetrics
): Promise<void> {
  const BATCH_SIZE = 10; // Concurrency limit
  const BATCH_DELAY_MS = 200; // Delay between batches

  // Check if market_status table exists (graceful degradation before migration runs)
  try {
    const tableCheck = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'market_status'
      ) as exists
    `;
    if (!tableCheck.rows[0]?.exists) {
      console.log('[refresh-prices] market_status table not found - skipping resolution check (run migration first)');
      return;
    }
  } catch (err) {
    console.warn('[refresh-prices] Could not check for market_status table:', err);
    return;
  }

  for (let i = 0; i < conditionIds.length; i += BATCH_SIZE) {
    const batch = conditionIds.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (conditionId) => {
        const marketData = await fetchMarketStatus(conditionId);
        return { conditionId, marketData };
      })
    );

    for (const { conditionId, marketData } of results) {
      metrics.marketsChecked++;

      if (!marketData) {
        metrics.marketsSkipped++;
        continue;
      }

      try {
        // Parse resolution status
        const winnerToken = marketData.tokens?.find(t => t.winner === true);
        // Only mark as resolved if we have a valid winning outcome (not just winner=true)
        const winningOutcome = winnerToken?.outcome?.trim() || null;
        const marketResolved = !!winnerToken && !!winningOutcome;
        const marketClosed = marketData.closed || marketResolved; // resolved implies closed

        if (marketResolved) metrics.marketsResolved++;
        if (marketClosed && !marketResolved) metrics.marketsClosed++;

        // UPSERT with first-seen timestamp preservation
        await sql`
          INSERT INTO market_status (
            condition_id, market_closed, market_resolved, winning_outcome,
            market_closed_first_seen_at, market_resolved_first_seen_at, updated_at
          )
          VALUES (
            ${conditionId},
            ${marketClosed},
            ${marketResolved},
            ${winningOutcome},
            CASE WHEN ${marketClosed} = TRUE THEN NOW() ELSE NULL END,
            CASE WHEN ${marketResolved} = TRUE THEN NOW() ELSE NULL END,
            NOW()
          )
          ON CONFLICT (condition_id) DO UPDATE SET
            market_closed = EXCLUDED.market_closed,
            market_closed_first_seen_at = CASE
              WHEN market_status.market_closed = FALSE AND EXCLUDED.market_closed = TRUE
              THEN NOW()
              ELSE market_status.market_closed_first_seen_at
            END,
            market_resolved = EXCLUDED.market_resolved,
            market_resolved_first_seen_at = CASE
              WHEN market_status.market_resolved = FALSE AND EXCLUDED.market_resolved = TRUE
              THEN NOW()
              ELSE market_status.market_resolved_first_seen_at
            END,
            winning_outcome = COALESCE(EXCLUDED.winning_outcome, market_status.winning_outcome),
            updated_at = NOW()
        `;
      } catch (err) {
        console.warn(`[refresh-prices] Failed to update market_status for ${conditionId}:`, err);
        metrics.marketsSkipped++;
      }
    }

    // Delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < conditionIds.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }
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
  // Auth check (defense-in-depth; middleware also validates)
  if (!isCronAuthed(request)) {
    return cronUnauthorized();
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
    // Phase 6: Market resolution metrics
    marketsChecked: 0,
    marketsResolved: 0,
    marketsClosed: 0,
    marketsSkipped: 0,
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

    // Phase 6: Check market resolution status for distinct condition_ids (last 14 days)
    // Uses a separate query with bounded time window to avoid DDOSing ourselves
    try {
      const distinctMarketsResult = await sql<{ condition_id: string }>`
        SELECT DISTINCT condition_id
        FROM alert_events
        WHERE fill_timestamp > NOW() - INTERVAL '14 days'
          AND condition_id IS NOT NULL
          AND condition_id != ''
        ORDER BY condition_id
        LIMIT 500
      `;

      const conditionIds = distinctMarketsResult.rows.map(r => r.condition_id);
      if (conditionIds.length > 0) {
        console.log(`[refresh-prices] Checking resolution status for ${conditionIds.length} markets`);
        await updateMarketResolutionStatus(conditionIds, metrics);
        console.log(`[refresh-prices] Resolution check: ${metrics.marketsResolved} resolved, ${metrics.marketsClosed} closed, ${metrics.marketsSkipped} skipped`);
      }
    } catch (err) {
      // Non-critical - don't fail the whole job if resolution check fails
      console.warn('[refresh-prices] Resolution status check failed:', err);
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

    console.log(`[refresh-prices] Completed: ${metrics.updated} prices updated, ${metrics.failed} failed, ${metrics.marketsResolved} resolved, ${durationMs}ms`);

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
