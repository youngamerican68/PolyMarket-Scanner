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
  // Source breakdown metrics
  walletsFromAlertEvents: number;
  walletsFromSnapshot: number;
  walletsWithStaleOverlay: number;
  walletsWithMissingOverlay: number;
  // Backlog-first metrics
  walletsFromBacklog: number;
  walletsFromLagging: number;
  // Reconciliation metric
  unresolvedSnapshotWalletsNotInOverlay: number;
}

// Selection reason for observability
type SelectionReason = 'backlog' | 'lagging' | 'stale' | 'alert_events' | 'snapshot' | 'other';

// Wallet selection result with metadata for metrics and observability
interface WalletSelectionResult {
  wallets: Array<{ wallet: string; reason: SelectionReason }>;
  fromAlertEvents: number;
  fromSnapshot: number;
  staleOverlay: number;
  missingOverlay: number;
  fromBacklog: number;
  fromLagging: number;
}

// Unified wallet sourcing with BACKLOG-FIRST selection
// Priority order:
//   1. BACKLOG: Wallets with snapshot positions missing valid overlay (sync_status='synced' AND synced_at IS NOT NULL)
//   2. LAGGING: Wallets where snapshot.updated_at > overlay.synced_at + LAG_THRESHOLD
//   3. STALE: Wallets where overlay is older than 30 minutes
//   4. FRESH: All other wallets from alert_events/snapshot sources
//
// Rule A: "Overlay row exists" = sync_status='synced' AND synced_at IS NOT NULL
async function getWalletsToSync(): Promise<WalletSelectionResult> {
  const cutoff = new Date(Date.now() - ALERT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  // Single unified query implementing backlog-first selection
  const result = await sql<{
    wallet: string;
    selection_reason: SelectionReason;
    source: string;
    priority: number;
    overlay_status: string;
  }>`
    WITH
    -- Unified unresolved market definition (single source of truth)
    -- PERF: Constrain alert_events to 72h window to avoid full table scan
    unresolved_conditions AS (
      SELECT DISTINCT condition_id
      FROM (
        SELECT DISTINCT condition_id
        FROM alert_events
        WHERE condition_id IS NOT NULL
          AND fill_timestamp >= ${cutoff}::timestamptz
        UNION
        SELECT DISTINCT condition_id
        FROM wallet_position_snapshot
        WHERE condition_id IS NOT NULL
      ) relevant_conditions
      WHERE NOT EXISTS (
        SELECT 1 FROM market_status ms
        WHERE ms.condition_id = relevant_conditions.condition_id
          AND ms.market_resolved = TRUE
          AND ms.winning_outcome IS NOT NULL
          AND TRIM(ms.winning_outcome) != ''
      )
    ),

    -- BACKLOG WALLETS (Priority 1): Snapshot positions with no valid overlay
    -- Rule A: overlay is valid only if sync_status='synced' AND synced_at IS NOT NULL
    backlog_wallets AS (
      SELECT DISTINCT wps.wallet
      FROM wallet_position_snapshot wps
      WHERE wps.wallet IS NOT NULL
        AND wps.shares > 0
        AND wps.condition_id IN (SELECT condition_id FROM unresolved_conditions)
        AND NOT EXISTS (
          SELECT 1 FROM position_sync_overlay pso
          WHERE pso.wallet = wps.wallet
            AND pso.condition_id = wps.condition_id
            AND pso.outcome = wps.outcome
            AND pso.sync_status = 'synced'
            AND pso.synced_at IS NOT NULL
        )
    ),

    -- LAGGING WALLETS (Priority 2): Snapshot updated more recently than overlay by > 10 minutes
    lagging_wallets AS (
      SELECT wps.wallet
      FROM wallet_position_snapshot wps
      WHERE wps.wallet IS NOT NULL
        AND wps.shares > 0
        AND wps.condition_id IN (SELECT condition_id FROM unresolved_conditions)
        AND wps.wallet NOT IN (SELECT wallet FROM backlog_wallets)
      GROUP BY wps.wallet
      HAVING MAX(wps.updated_at) > COALESCE(
        (SELECT MAX(pso.synced_at)
         FROM position_sync_overlay pso
         WHERE pso.wallet = wps.wallet
           AND pso.sync_status = 'synced'
           AND pso.synced_at IS NOT NULL),
        '1970-01-01'::timestamptz
      ) + INTERVAL '10 minutes'
    ),

    -- Source 1: Wallets from alert_events with recent fills (72h)
    alert_wallets AS (
      SELECT
        ae.wallet,
        'alert_events'::text AS source,
        MAX(ae.fill_timestamp) AS last_activity
      FROM alert_events ae
      WHERE ae.wallet IS NOT NULL
        AND ae.fill_timestamp >= ${cutoff}::timestamptz
        AND ae.condition_id IN (SELECT condition_id FROM unresolved_conditions)
      GROUP BY ae.wallet
    ),

    -- Source 2: Wallets from snapshot with unresolved positions
    snapshot_wallets AS (
      SELECT
        wps.wallet,
        'snapshot'::text AS source,
        MAX(wps.updated_at) AS last_activity
      FROM wallet_position_snapshot wps
      WHERE wps.wallet IS NOT NULL
        AND wps.condition_id IN (SELECT condition_id FROM unresolved_conditions)
      GROUP BY wps.wallet
    ),

    -- Combine sources and dedupe
    combined_wallets AS (
      SELECT wallet, source, last_activity FROM alert_wallets
      UNION ALL
      SELECT wallet, source, last_activity FROM snapshot_wallets
    ),

    deduped_wallets AS (
      SELECT
        wallet,
        CASE
          WHEN COUNT(DISTINCT source) > 1 THEN 'both'
          ELSE MAX(source)
        END AS primary_source,
        MAX(last_activity) AS last_activity
      FROM combined_wallets
      GROUP BY wallet
    ),

    -- Join with wallet_sync_state and assign selection_reason + priority
    wallet_with_priority AS (
      SELECT
        dw.wallet,
        dw.primary_source,
        dw.last_activity,
        wss.last_synced_at,
        -- Selection reason: backlog > lagging > stale > source-based
        CASE
          WHEN dw.wallet IN (SELECT wallet FROM backlog_wallets) THEN 'backlog'
          WHEN dw.wallet IN (SELECT wallet FROM lagging_wallets) THEN 'lagging'
          WHEN wss.wallet IS NULL OR wss.last_synced_at IS NULL THEN 'stale'
          WHEN wss.last_synced_at < NOW() - INTERVAL '30 minutes' THEN 'stale'
          WHEN dw.primary_source = 'alert_events' THEN 'alert_events'
          WHEN dw.primary_source = 'snapshot' THEN 'snapshot'
          ELSE 'other'
        END::text AS selection_reason,
        -- Priority: 1=backlog, 2=lagging, 3=stale, 4=alert_events, 5=snapshot, 6=other
        CASE
          WHEN dw.wallet IN (SELECT wallet FROM backlog_wallets) THEN 1
          WHEN dw.wallet IN (SELECT wallet FROM lagging_wallets) THEN 2
          WHEN wss.wallet IS NULL OR wss.last_synced_at IS NULL THEN 3
          WHEN wss.last_synced_at < NOW() - INTERVAL '30 minutes' THEN 3
          WHEN dw.primary_source = 'alert_events' THEN 4
          WHEN dw.primary_source = 'snapshot' THEN 5
          ELSE 6
        END AS priority,
        -- Overlay status for metrics
        CASE
          WHEN wss.wallet IS NULL THEN 'missing'
          WHEN wss.last_synced_at IS NULL THEN 'never_synced'
          WHEN wss.last_synced_at < NOW() - INTERVAL '30 minutes' THEN 'stale'
          ELSE 'fresh'
        END AS overlay_status
      FROM deduped_wallets dw
      LEFT JOIN wallet_sync_state wss ON wss.wallet = dw.wallet
    )

    -- Final selection: backlog-first, then lagging, then stale, then by activity
    SELECT
      wallet,
      selection_reason,
      primary_source AS source,
      priority,
      overlay_status
    FROM wallet_with_priority
    ORDER BY
      priority ASC,                    -- Backlog > lagging > stale > fresh
      last_activity DESC NULLS LAST,   -- Most recently active next
      wallet ASC                       -- Deterministic tiebreaker
    LIMIT ${MAX_WALLETS_PER_RUN}
  `;

  // Extract wallets with reasons and compute metrics
  const wallets = result.rows.map(r => ({
    wallet: r.wallet,
    reason: r.selection_reason as SelectionReason
  }));

  const fromAlertEvents = result.rows.filter(r => r.source === 'alert_events' || r.source === 'both').length;
  const fromSnapshot = result.rows.filter(r => r.source === 'snapshot' || r.source === 'both').length;
  const staleOverlay = result.rows.filter(r => r.overlay_status === 'stale').length;
  const missingOverlay = result.rows.filter(r => r.overlay_status === 'missing' || r.overlay_status === 'never_synced').length;
  const fromBacklog = result.rows.filter(r => r.selection_reason === 'backlog').length;
  const fromLagging = result.rows.filter(r => r.selection_reason === 'lagging').length;

  return {
    wallets,
    fromAlertEvents,
    fromSnapshot,
    staleOverlay,
    missingOverlay,
    fromBacklog,
    fromLagging,
  };
}

// Reconciliation check: count unresolved snapshot wallets not in overlay
// Rule A: "overlay row exists" = sync_status='synced' AND synced_at IS NOT NULL
// Excludes resolved markets to match sync logic
async function countUnresolvedSnapshotWalletsNotInOverlay(): Promise<number> {
  const result = await sql<{ count: number }>`
    SELECT COUNT(DISTINCT wps.wallet)::int AS count
    FROM wallet_position_snapshot wps
    WHERE wps.shares > 0
      -- Exclude resolved markets (match sync logic)
      AND NOT EXISTS (
        SELECT 1 FROM market_status ms
        WHERE ms.condition_id = wps.condition_id
          AND ms.market_resolved = TRUE
          AND ms.winning_outcome IS NOT NULL
          AND TRIM(ms.winning_outcome) != ''
      )
      -- Rule A: no valid overlay row
      AND NOT EXISTS (
        SELECT 1 FROM position_sync_overlay pso
        WHERE pso.wallet = wps.wallet
          AND pso.condition_id = wps.condition_id
          AND pso.outcome = wps.outcome
          AND pso.sync_status = 'synced'
          AND pso.synced_at IS NOT NULL
      )
  `;
  return result.rows[0]?.count ?? 0;
}

// Get condition_id + outcome + outcome_index for a wallet
// Sources from both alert_events AND snapshot for complete coverage
// Uses consistent unresolved-market predicate
// PERF: Constrains alert_events to 72h window to avoid full scan
async function getDashboardRowsForWallet(
  wallet: string
): Promise<Array<{ condition_id: string; outcome: string; outcome_index: number | null }>> {
  const cutoff = new Date(Date.now() - ALERT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const walletLower = wallet.toLowerCase();

  // Unified query: combines alert_events and snapshot positions
  // for unresolved markets only
  // Note: UNION on (condition_id, outcome) correctly dedupes by business key
  const result = await sql<{ condition_id: string; outcome: string; outcome_index: number | null }>`
    WITH
    -- Unified unresolved market predicate
    -- PERF: Constrain alert_events to 72h window for this wallet
    unresolved_conditions AS (
      SELECT DISTINCT condition_id
      FROM (
        -- Only recent alert_events (72h) for this wallet
        SELECT DISTINCT condition_id
        FROM alert_events
        WHERE wallet = ${walletLower}
          AND condition_id IS NOT NULL
          AND fill_timestamp >= ${cutoff}::timestamptz
        UNION
        -- All snapshot positions for this wallet
        SELECT DISTINCT condition_id
        FROM wallet_position_snapshot
        WHERE wallet = ${walletLower}
          AND condition_id IS NOT NULL
      ) wallet_conditions
      WHERE NOT EXISTS (
        SELECT 1 FROM market_status ms
        WHERE ms.condition_id = wallet_conditions.condition_id
          AND ms.market_resolved = TRUE
          AND ms.winning_outcome IS NOT NULL
          AND TRIM(ms.winning_outcome) != ''
      )
    ),

    -- Source 1: From alert_events (recent fills, 72h window)
    alert_positions AS (
      SELECT DISTINCT ae.condition_id, ae.outcome, ae.outcome_index
      FROM alert_events ae
      WHERE ae.wallet = ${walletLower}
        AND ae.fill_timestamp >= ${cutoff}::timestamptz
        AND ae.condition_id IN (SELECT condition_id FROM unresolved_conditions)
        AND ae.outcome IS NOT NULL
    ),

    -- Source 2: From snapshot (may have older positions not in recent alerts)
    snapshot_positions AS (
      SELECT DISTINCT wps.condition_id, wps.outcome, wps.outcome_index
      FROM wallet_position_snapshot wps
      WHERE wps.wallet = ${walletLower}
        AND wps.condition_id IN (SELECT condition_id FROM unresolved_conditions)
        AND wps.outcome IS NOT NULL
    )

    -- Combine both sources: UNION dedupes by (condition_id, outcome, outcome_index)
    SELECT condition_id, outcome, outcome_index FROM alert_positions
    UNION
    SELECT condition_id, outcome, outcome_index FROM snapshot_positions
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
      // Find matching position by condition_id (outcome matching is unreliable - API may return null)
      // Use same logic as matchTradeToPosition: match by conditionId, then verify by outcomeIndex if available
      const matchingPosition = positions.find(p => {
        if (p.conditionId !== row.condition_id) return false;
        // If we have outcomeIndex in row, use it for precise matching
        if (row.outcome_index !== null && row.outcome_index !== undefined) {
          return p.outcomeIndex === null || p.outcomeIndex === undefined || p.outcomeIndex === row.outcome_index;
        }
        // Fallback: accept any position with matching conditionId
        return true;
      });

      if (matchingPosition) {
        // Position found - update synced_* AND last_known_* fields
        const positionSize = matchingPosition.size ?? 0;
        const avgPrice = matchingPosition.avgPrice ?? 0;
        // Calculate current value from size × curPrice for accuracy
        // The API's pre-calculated currentValue can be stale
        const curPrice = matchingPosition.curPrice ?? 0;
        const currentValue = positionSize * curPrice;
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
    // Source breakdown metrics
    walletsFromAlertEvents: 0,
    walletsFromSnapshot: 0,
    walletsWithStaleOverlay: 0,
    walletsWithMissingOverlay: 0,
    // Backlog-first metrics
    walletsFromBacklog: 0,
    walletsFromLagging: 0,
    // Reconciliation metric
    unresolvedSnapshotWalletsNotInOverlay: 0,
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

    // Get wallets to sync (unified: alert_events + snapshot, unresolved markets only)
    const walletSelection = await getWalletsToSync();
    const walletItems = walletSelection.wallets;
    metrics.walletsRequested = walletItems.length;
    metrics.walletsFromAlertEvents = walletSelection.fromAlertEvents;
    metrics.walletsFromSnapshot = walletSelection.fromSnapshot;
    metrics.walletsWithStaleOverlay = walletSelection.staleOverlay;
    metrics.walletsWithMissingOverlay = walletSelection.missingOverlay;
    metrics.walletsFromBacklog = walletSelection.fromBacklog;
    metrics.walletsFromLagging = walletSelection.fromLagging;

    // Run reconciliation check (non-blocking)
    try {
      metrics.unresolvedSnapshotWalletsNotInOverlay = await countUnresolvedSnapshotWalletsNotInOverlay();
    } catch (err) {
      console.warn('[sync-positions] Reconciliation check failed (non-fatal):', err);
    }

    if (walletItems.length === 0) {
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

    console.log(`[${JOB_NAME}] Syncing ${walletItems.length} wallets (backlog: ${metrics.walletsFromBacklog}, lagging: ${metrics.walletsFromLagging}, alert_events: ${metrics.walletsFromAlertEvents}, snapshot: ${metrics.walletsFromSnapshot}, missing_overlay: ${metrics.walletsWithMissingOverlay})`);

    // Sync wallets with concurrency limit
    await Promise.all(
      walletItems.map(item =>
        syncLimit(() => syncWalletPositions(item.wallet, metrics))
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
      // Backlog-first selection metrics
      fromBacklog: metrics.walletsFromBacklog,
      fromLagging: metrics.walletsFromLagging,
      // Source breakdown
      fromAlertEvents: metrics.walletsFromAlertEvents,
      fromSnapshot: metrics.walletsFromSnapshot,
      missingOverlay: metrics.walletsWithMissingOverlay,
      staleOverlay: metrics.walletsWithStaleOverlay,
      // Reconciliation
      unresolvedNotInOverlay: metrics.unresolvedSnapshotWalletsNotInOverlay,
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
      // Backlog-first selection metrics
      fromBacklog: metrics.walletsFromBacklog,
      fromLagging: metrics.walletsFromLagging,
      // Source breakdown
      fromAlertEvents: metrics.walletsFromAlertEvents,
      fromSnapshot: metrics.walletsFromSnapshot,
      missingOverlay: metrics.walletsWithMissingOverlay,
      staleOverlay: metrics.walletsWithStaleOverlay,
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
