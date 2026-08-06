// /app/api/jobs/refresh-prices/route.ts
// Phase 3: Price refresh cron job (hardened)
// Phase 6: Also checks market resolution status
// Fetches current prices from Polymarket CLOB API and caches them in DB
// Wrapped with Phase 4 job tracking + advisory lock to prevent overlaps

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { isCronAuthed, cronUnauthorized } from '@/lib/cronAuth';
import { finalizeResolvedPnL } from '@/lib/finalize-resolved-pnl';
import { fetchPositionsWithRetry } from '@/lib/polymarket';

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
  skippedResolved: number; // Markets skipped because already resolved
  batches: number;
  distinctMarkets: number;
  capApplied: boolean;
  oldestFetchedAt: string | null;
  // Phase 6: Market resolution metrics
  marketsChecked: number;
  marketsResolved: number;
  marketsClosed: number;
  marketsSkipped: number;
  // Phase 8: Final P&L metrics
  pnlMarketsFinalized: number;
  pnlUpserts: number;
  // Phase 9: Position snapshot metrics
  snapshotWalletsFetched: number;
  snapshotPositionsUpserted: number;
  snapshotErrors: number;
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

    // Mark every scheduled attempt before calling CLOB. This includes 404s,
    // other fetch failures, and closed markets without a detectable winner,
    // so permanently unresolvable markets rotate to the back of the queue.
    await sql`
      UPDATE market_status
      SET updated_at = NOW()
      WHERE condition_id IN (
        SELECT jsonb_array_elements_text(${JSON.stringify(batch)}::jsonb)
      )
    `;

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
        // Parse resolution status with robust winner detection
        // Handle various truthy variants: true, "true", 1, "1"
        const isWinner = (t: Record<string, unknown>): boolean =>
          t.winner === true || t.winner === 'true' || t.winner === 1 || t.winner === '1';

        const winnerToken = marketData.tokens?.find(isWinner);

        // Extract outcome from multiple possible fields (API schema varies)
        const extractOutcome = (t: Record<string, unknown> | undefined): string | null => {
          if (!t) return null;
          const raw = t.outcome ?? t.label ?? t.name ?? t.symbol;
          return typeof raw === 'string' ? raw.trim() : null;
        };

        const winningOutcome = extractOutcome(winnerToken);
        const marketResolved = !!winnerToken && !!winningOutcome;
        const marketClosed = marketData.closed || marketResolved; // resolved implies closed

        // Debug: Log when we find a closed market without detectable winner
        if (marketData.closed && !marketResolved) {
          const winnerCount = marketData.tokens?.filter(isWinner).length ?? 0;
          const firstToken = marketData.tokens?.[0];
          const tokenKeys = firstToken ? Object.keys(firstToken).join(',') : 'no-tokens';
          const tokenInfo = marketData.tokens?.slice(0, 3).map((t: Record<string, unknown>) =>
            `${extractOutcome(t) || 'no-outcome'}:winner=${t.winner}`
          ).join(', ');
          console.log(`[refresh-prices] Closed but no winner: ${conditionId} | winnerCount=${winnerCount} | keys=[${tokenKeys}] | tokens=[${tokenInfo}]`);
        }

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

// Phase 9: Snapshot open positions for tracked wallets (before resolution)
// This allows us to estimate P&L when positions disappear after resolution
async function snapshotOpenPositions(
  metrics: JobMetrics
): Promise<void> {
  // Check if snapshot table exists
  try {
    const tableCheck = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'wallet_position_snapshot'
      ) as exists
    `;
    if (!tableCheck.rows[0]?.exists) {
      console.log('[refresh-prices] wallet_position_snapshot table not found - skipping (run migration first)');
      return;
    }
  } catch (err) {
    console.warn('[refresh-prices] Could not check for wallet_position_snapshot table:', err);
    return;
  }

  // Get distinct wallets from unresolved markets (limit to avoid rate limiting)
  const walletsResult = await sql<{ wallet: string }>`
    SELECT DISTINCT wallet
    FROM alert_events ae
    WHERE ae.wallet IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM market_status ms
        WHERE ms.condition_id = ae.condition_id
          AND ms.market_resolved = TRUE
          AND ms.winning_outcome IS NOT NULL
          AND TRIM(ms.winning_outcome) != ''
      )
    LIMIT 50
  `;

  const wallets = walletsResult.rows.map(r => r.wallet);
  if (wallets.length === 0) {
    console.log('[refresh-prices] No wallets with unresolved positions to snapshot');
    return;
  }

  // Get condition_ids we care about (from alert_events) for filtering
  const conditionsResult = await sql<{ condition_id: string }>`
    SELECT DISTINCT condition_id FROM alert_events WHERE condition_id IS NOT NULL
  `;
  const trackedConditions = new Set(conditionsResult.rows.map(r => r.condition_id));

  console.log(`[refresh-prices] Snapshotting positions for ${wallets.length} wallets`);

  // Process wallets with concurrency limit
  const BATCH_SIZE = 5;
  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batch = wallets.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (wallet) => {
        try {
          const { positions } = await fetchPositionsWithRetry(wallet, 100);
          metrics.snapshotWalletsFetched++;

          for (const pos of positions) {
            // Only snapshot positions for markets we track
            if (!pos.conditionId || !trackedConditions.has(pos.conditionId)) continue;
            if (!pos.outcome) continue;

            // Get shares and avgPrice
            const shares = pos.size;
            let avgPrice = pos.avgPrice;

            // Skip if no valid position data
            if (shares === null || shares === undefined || shares <= 0) continue;
            if (avgPrice === null || avgPrice === undefined) continue;

            // Defensive normalization: avgPrice should be 0-1
            if (avgPrice > 1) {
              avgPrice = avgPrice / 100; // Assume 0-100 scale
            }
            avgPrice = Math.max(0, Math.min(1, avgPrice)); // Clamp to [0,1]

            // Upsert snapshot
            try {
              await sql`
                INSERT INTO wallet_position_snapshot (wallet, condition_id, outcome, shares, avg_price, updated_at)
                VALUES (${wallet}, ${pos.conditionId}, ${pos.outcome}, ${shares}, ${avgPrice}, NOW())
                ON CONFLICT (wallet, condition_id, outcome)
                DO UPDATE SET shares = EXCLUDED.shares, avg_price = EXCLUDED.avg_price, updated_at = NOW()
              `;
              metrics.snapshotPositionsUpserted++;
            } catch (err) {
              console.warn(`[refresh-prices] Failed to upsert snapshot for ${wallet}/${pos.conditionId}:`, err);
              metrics.snapshotErrors++;
            }
          }
        } catch (err) {
          console.warn(`[refresh-prices] Failed to fetch positions for wallet ${wallet}:`, err);
          metrics.snapshotErrors++;
        }
      })
    );

    // Rate limit between batches
    if (i + BATCH_SIZE < wallets.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`[refresh-prices] Snapshots: ${metrics.snapshotWalletsFetched} wallets, ${metrics.snapshotPositionsUpserted} positions, ${metrics.snapshotErrors} errors`);
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
    skippedResolved: 0,
    batches: 0,
    distinctMarkets: 0,
    capApplied: false,
    oldestFetchedAt: null,
    // Phase 6: Market resolution metrics
    marketsChecked: 0,
    marketsResolved: 0,
    marketsClosed: 0,
    marketsSkipped: 0,
    // Phase 8: Final P&L metrics
    pnlMarketsFinalized: 0,
    pnlUpserts: 0,
    // Phase 9: Position snapshot metrics
    snapshotWalletsFetched: 0,
    snapshotPositionsUpserted: 0,
    snapshotErrors: 0,
  };

  try {
    // Insert job_runs record with status 'running'
    await sql`
      INSERT INTO job_runs (id, job_name, status, started_at)
      VALUES (${jobRunId}, ${JOB_NAME}, 'running', NOW())
    `;
    console.log(`[refresh-prices] Started job ${jobRunId}`);

    // Step 1: Query distinct (condition_id, outcome, asset) from recent alert_events (72h)
    // EXCLUDING markets already resolved with a known winner (to avoid 404s on closed order books)
    const recentOutcomes = await sql<OutcomeKey>`
      SELECT DISTINCT ae.condition_id, ae.outcome, ae.asset
      FROM alert_events ae
      WHERE ae.fill_timestamp >= NOW() - INTERVAL '72 hours'
        AND ae.asset IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM market_status ms
          WHERE ms.condition_id = ae.condition_id
            AND ms.market_resolved = TRUE
            AND ms.winning_outcome IS NOT NULL
            AND TRIM(ms.winning_outcome) != ''
        )
      ORDER BY ae.condition_id, ae.outcome
      LIMIT ${MAX_OUTCOMES_PER_RUN}
    `;

    // Also count how many we're skipping due to resolution
    const skippedCount = await sql<{ count: number }>`
      SELECT COUNT(DISTINCT ae.asset)::int as count
      FROM alert_events ae
      WHERE ae.fill_timestamp >= NOW() - INTERVAL '72 hours'
        AND ae.asset IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM market_status ms
          WHERE ms.condition_id = ae.condition_id
            AND ms.market_resolved = TRUE
            AND ms.winning_outcome IS NOT NULL
            AND TRIM(ms.winning_outcome) != ''
        )
    `;
    metrics.skippedResolved = skippedCount.rows[0]?.count ?? 0;

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

      const msg = metrics.skippedResolved > 0
        ? `No active outcomes to refresh (${metrics.skippedResolved} skipped - already resolved)`
        : 'No outcomes to refresh';

      return NextResponse.json({
        jobRunId,
        status: 'success',
        message: msg,
        ...metrics,
        durationMs,
      }, { headers: NO_CACHE_HEADERS });
    }

    // Count distinct markets
    const marketSet = new Set(outcomes.map(o => o.condition_id));
    metrics.distinctMarkets = marketSet.size;

    const skipMsg = metrics.skippedResolved > 0 ? ` (${metrics.skippedResolved} resolved assets skipped)` : '';
    console.log(`[refresh-prices] Fetching prices for ${outcomes.length} outcomes across ${metrics.distinctMarkets} markets${metrics.capApplied ? ' (cap applied)' : ''}${skipMsg}`);

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

    // Phase 9: Snapshot open positions for tracked wallets
    // Run BEFORE resolution check/finalization so snapshots are available
    try {
      await snapshotOpenPositions(metrics);
    } catch (err) {
      // Non-critical - don't fail the whole job if snapshotting fails
      console.warn('[refresh-prices] Position snapshotting failed (non-fatal):', err);
    }

    // Phase 6: Check market resolution status for condition_ids from DB
    // Scope: all condition_ids in alert_events that are NOT yet resolved.
    // This ensures we don't miss markets just because they fell outside an arbitrary time window
    try {
      // Give every alerted market a queue row. Skeleton rows make even CLOB 404s and
      // other no-data responses schedulable without requiring a schema migration.
      await sql`
        INSERT INTO market_status (condition_id, market_closed, market_resolved, updated_at)
        SELECT DISTINCT ae.condition_id, FALSE, FALSE, NOW()
        FROM alert_events ae
        WHERE ae.condition_id IS NOT NULL
          AND ae.condition_id != ''
        ON CONFLICT (condition_id) DO NOTHING
      `;

      // Oldest-check-first scheduling prevents an unresolvable prefix from
      // monopolizing the capped batch. condition_id is only a stable tie-breaker.
      const distinctMarketsResult = await sql<{ condition_id: string }>`
        SELECT ms.condition_id
        FROM market_status ms
        WHERE EXISTS (
            SELECT 1 FROM alert_events ae
            WHERE ae.condition_id = ms.condition_id
          )
          AND NOT (
            ms.market_resolved = TRUE
            AND ms.winning_outcome IS NOT NULL
            AND TRIM(ms.winning_outcome) != ''
          )
        ORDER BY ms.updated_at ASC, ms.condition_id ASC
        LIMIT 500
      `;

      const conditionIds = distinctMarketsResult.rows.map(r => r.condition_id);
      if (conditionIds.length > 0) {
        console.log(`[refresh-prices] Checking resolution status for ${conditionIds.length} unresolved/unknown markets`);
        await updateMarketResolutionStatus(conditionIds, metrics);
        console.log(`[refresh-prices] Resolution check: ${metrics.marketsResolved} newly resolved, ${metrics.marketsClosed} closed, ${metrics.marketsSkipped} skipped`);
      } else {
        console.log('[refresh-prices] All known markets already resolved - no resolution checks needed');
      }
    } catch (err) {
      // Non-critical - don't fail the whole job if resolution check fails
      console.warn('[refresh-prices] Resolution status check failed:', err);
    }

    // Phase 8: Finalize P&L for newly resolved markets
    // Run after resolution check so we have fresh market_status data
    try {
      // Limit to 10 markets per run to avoid timeout (job runs every 10 min)
      const pnlResult = await finalizeResolvedPnL({ marketLimit: 10, walletConcurrency: 4 });
      metrics.pnlMarketsFinalized = pnlResult.marketsFinalized;
      metrics.pnlUpserts = pnlResult.upserts;
      if (pnlResult.marketsFinalized > 0) {
        console.log(`[refresh-prices] Finalized P&L: ${pnlResult.marketsFinalized} markets, ${pnlResult.upserts} wallet/outcomes`);
      }
    } catch (err) {
      // Non-critical - don't fail the whole job if P&L finalization fails
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[refresh-prices] P&L finalization failed (non-fatal): ${errMsg}`);
      // Continue with the rest of the job - finalization will retry on next run
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

    // Structured JSON log for observability (grep-friendly)
    console.info(JSON.stringify({
      job: JOB_NAME,
      ok: true,
      durationMs,
      outcomesConsidered: metrics.requested,
      outcomesRefreshed: metrics.updated,
      cacheUpserts: metrics.updated,
      skippedResolved: metrics.skippedResolved,
      marketsResolved: metrics.marketsResolved,
      pnlFinalized: metrics.pnlMarketsFinalized,
      snapshotsUpserted: metrics.snapshotPositionsUpserted,
      errorCount: metrics.failed,
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

    // Structured JSON log for observability (grep-friendly)
    console.info(JSON.stringify({
      job: JOB_NAME,
      ok: false,
      durationMs,
      outcomesConsidered: metrics.requested,
      outcomesRefreshed: metrics.updated,
      cacheUpserts: metrics.updated,
      skippedResolved: metrics.skippedResolved,
      marketsResolved: metrics.marketsResolved,
      pnlFinalized: metrics.pnlMarketsFinalized,
      snapshotsUpserted: metrics.snapshotPositionsUpserted,
      errorCount: metrics.failed + 1, // +1 for the fatal error
      error: errorMessage.slice(0, 200),
    }));

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
