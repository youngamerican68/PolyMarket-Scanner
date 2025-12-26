// /app/api/positions/refresh/route.ts
// Phase 10: Position Sync Overlay - on-demand position refresh
// Feature flag: ENABLE_POSITION_SYNC
// Fetches current positions for wallets in scope and updates overlay table

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import pLimit from 'p-limit';
import { fetchPositionsWithRetry, Position } from '@/lib/polymarket';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120; // 2 minutes max for refresh

// Response headers to prevent caching
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

// Configuration (can be overridden via env vars)
const SYNC_TTL_MS = parseInt(process.env.POSITION_SYNC_TTL_MS || '120000', 10); // 2 minutes default
const SYNC_CONCURRENCY = parseInt(process.env.POSITION_SYNC_CONCURRENCY || '5', 10); // 5 wallets at once
const POSITION_LIMIT_PER_WALLET = 100;

// Create concurrency limiter
const syncLimit = pLimit(SYNC_CONCURRENCY);

interface RefreshRequest {
  scope: 'wallets' | 'filter';
  wallets?: string[];
  // Filter params (when scope = 'filter')
  alertWindowHours?: number;
  whalesOnly?: boolean;
  includeResolved?: boolean;
  excludeCategory?: string;
  maxOdds?: number;
  minPosition?: number;
}

interface SyncResult {
  walletsRequested: number;
  walletsSynced: number;
  walletsSkippedTtl: number;
  walletsFailed: number;
  rowsUpdated: number;
  errors: string[];
  durationMs: number;
}

// Check if position sync is enabled
function isPositionSyncEnabled(): boolean {
  return process.env.ENABLE_POSITION_SYNC === 'true' || process.env.ENABLE_POSITION_SYNC === '1';
}

// Check if wallet was recently synced (TTL check)
async function shouldSkipWallet(wallet: string): Promise<boolean> {
  // Compute TTL cutoff in JS (can't interpolate inside SQL string literals)
  const ttlCutoff = new Date(Date.now() - SYNC_TTL_MS).toISOString();
  const result = await sql<{ last_synced_at: string }>`
    SELECT last_synced_at::text
    FROM wallet_sync_state
    WHERE wallet = ${wallet.toLowerCase()}
      AND last_synced_at > ${ttlCutoff}::timestamptz
  `;
  return result.rows.length > 0;
}

// Get distinct wallets from alert_events based on filter params
async function getWalletsFromFilter(params: RefreshRequest): Promise<string[]> {
  const {
    alertWindowHours = 72,
    whalesOnly = false,
    includeResolved = false,
    excludeCategory,
    maxOdds = 0.25,
    minPosition = 2500,
  } = params;

  const cutoff = new Date(Date.now() - alertWindowHours * 60 * 60 * 1000).toISOString();

  // Build query to get distinct wallets matching current filter
  const result = await sql<{ wallet: string }>`
    SELECT DISTINCT ae.wallet
    FROM alert_events ae
    LEFT JOIN market_status ms ON ae.condition_id = ms.condition_id
    WHERE ae.fill_timestamp >= ${cutoff}::timestamptz
      AND ae.fill_price <= ${maxOdds}
      AND ae.position_current_value IS NOT NULL
      AND ae.position_current_value >= ${minPosition}
      AND (${whalesOnly}::boolean = FALSE OR ae.is_whale = TRUE)
      AND (
        ${excludeCategory}::text IS NULL
        OR ${excludeCategory} != 'crypto'
        OR (
          ae.whale_category IS DISTINCT FROM 'crypto'
          AND ae.title NOT ILIKE '%bitcoin%'
          AND ae.title NOT ILIKE '%btc%'
          AND ae.title NOT ILIKE '%ethereum%'
          AND ae.title NOT ILIKE '%crypto%'
          AND ae.title NOT ILIKE '%token%'
          AND ae.title NOT ILIKE '%market cap%'
          AND ae.title NOT ILIKE '%fdv%'
        )
      )
      AND (
        CASE WHEN ${includeResolved}::boolean = TRUE
          THEN ms.market_resolved = TRUE AND ms.winning_outcome IS NOT NULL
          ELSE ms.market_resolved IS NOT TRUE OR ms.winning_outcome IS NULL
        END
      )
    ORDER BY ae.wallet
    LIMIT 500
  `;

  return result.rows.map(r => r.wallet);
}

// Get condition_id + outcome pairs for a wallet from current dashboard rows
async function getDashboardRowsForWallet(
  wallet: string,
  alertWindowHours: number = 72
): Promise<Array<{ condition_id: string; outcome: string }>> {
  const cutoff = new Date(Date.now() - alertWindowHours * 60 * 60 * 1000).toISOString();

  const result = await sql<{ condition_id: string; outcome: string }>`
    SELECT DISTINCT condition_id, outcome
    FROM alert_events
    WHERE wallet = ${wallet.toLowerCase()}
      AND fill_timestamp >= ${cutoff}::timestamptz
      AND position_current_value IS NOT NULL
  `;

  return result.rows;
}

// Sync positions for a single wallet
async function syncWalletPositions(
  wallet: string,
  alertWindowHours: number = 72
): Promise<{ rowsUpdated: number; error?: string }> {
  const startTime = Date.now();
  const walletLower = wallet.toLowerCase();

  try {
    // Fetch positions from Polymarket API
    const { positions, atLimit } = await fetchPositionsWithRetry(walletLower, POSITION_LIMIT_PER_WALLET);

    // Get dashboard rows for this wallet
    const dashboardRows = await getDashboardRowsForWallet(walletLower, alertWindowHours);

    let rowsUpdated = 0;

    // IMPORTANT: Create sync timestamp ONCE per wallet sync request
    // This ensures all rows in this sync batch have the same timestamp
    // for consistent "last checked" display and proper concurrency handling
    const syncTimestamp = new Date().toISOString();

    // For each dashboard row, find matching position and upsert overlay
    for (const row of dashboardRows) {
      // Find matching position by condition_id and outcome
      const matchingPosition = positions.find(
        p => p.conditionId === row.condition_id && p.outcome === row.outcome
      );

      if (matchingPosition) {
        // Calculate payout if wins = position size (each share pays $1)
        const positionSize = matchingPosition.size ?? 0;
        const avgPrice = matchingPosition.avgPrice ?? 0;
        const currentValue = matchingPosition.currentValue ?? 0;
        const payoutIfWins = positionSize; // Each share pays $1 if outcome wins

        // Upsert overlay - update both synced_* AND last_known_* fields
        // Set position_state = 'open' since we found an active position
        // CONCURRENCY SAFETY with quality-based tie-breaker:
        //   - sync_status='synced' is highest quality (found position)
        //   - At equal timestamps, higher quality always wins
        //   - 'synced' can overwrite anything at equal or newer timestamps
        const result = await sql`
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
            -- Also update last_known_* when position is found
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
        if (result.rowCount && result.rowCount > 0) {
          rowsUpdated++;
        }
      } else {
        // Position not found in API response
        // CRITICAL FIX: Do NOT overwrite last_known_* values!
        // Set synced_* to NULL to indicate "no current open position"
        // Keep last_known_* intact for historical display
        // Set position_state = 'not_found_in_sync' to indicate reason is unknown
        // CONCURRENCY SAFETY with quality-based tie-breaker:
        //   - sync_status='not_found' is lower quality than 'synced'
        //   - At equal timestamps, REJECT if existing is 'synced' (don't downgrade)
        //   - At strictly newer timestamps, allow the update
        //   - Never overwrite confirmed position_states
        const result = await sql`
          INSERT INTO position_sync_overlay (
            wallet, condition_id, outcome,
            synced_position_size, synced_avg_price, synced_current_value, synced_payout_if_wins,
            synced_at, sync_status, sync_error, position_state
          )
          VALUES (
            ${walletLower}, ${row.condition_id}, ${row.outcome},
            NULL, NULL, NULL, NULL,
            ${syncTimestamp}::timestamptz, 'not_found', 'Position not found in API response (may be closed/redeemed)', 'not_found_in_sync'
          )
          ON CONFLICT (wallet, condition_id, outcome) DO UPDATE SET
            -- Set synced_* to NULL to indicate no current open position
            synced_position_size = NULL,
            synced_avg_price = NULL,
            synced_current_value = NULL,
            synced_payout_if_wins = NULL,
            synced_at = EXCLUDED.synced_at,
            sync_status = 'not_found',
            sync_error = EXCLUDED.sync_error,
            position_state = CASE
              -- Don't overwrite confirmed states
              WHEN position_sync_overlay.position_state IN ('closed_confirmed', 'redeemed_confirmed')
              THEN position_sync_overlay.position_state
              ELSE 'not_found_in_sync'
            END
            -- IMPORTANT: Do NOT update last_known_* fields - they preserve historical values
          WHERE (
            -- Allow if never synced before
            position_sync_overlay.synced_at IS NULL
            -- Allow if incoming timestamp is strictly newer
            OR position_sync_overlay.synced_at < EXCLUDED.synced_at
            -- At equal timestamps: only allow if existing is NOT 'synced' (quality-based tie-breaker)
            OR (
              position_sync_overlay.synced_at = EXCLUDED.synced_at
              AND position_sync_overlay.sync_status IS DISTINCT FROM 'synced'
            )
          )
          -- Additionally, never overwrite confirmed position_states regardless of timestamp
          AND position_sync_overlay.position_state NOT IN ('closed_confirmed', 'redeemed_confirmed')
        `;
        if (result.rowCount && result.rowCount > 0) {
          rowsUpdated++;
        }
      }
    }

    // Update wallet sync state
    const durationMs = Date.now() - startTime;
    await sql`
      INSERT INTO wallet_sync_state (wallet, last_synced_at, last_sync_status, positions_count, last_sync_duration_ms)
      VALUES (${walletLower}, NOW(), 'success', ${positions.length}, ${durationMs})
      ON CONFLICT (wallet) DO UPDATE SET
        last_synced_at = NOW(),
        last_sync_status = 'success',
        positions_count = EXCLUDED.positions_count,
        last_sync_error = NULL,
        last_sync_duration_ms = EXCLUDED.last_sync_duration_ms
    `;

    return { rowsUpdated };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;

    // Update wallet sync state with error
    await sql`
      INSERT INTO wallet_sync_state (wallet, last_synced_at, last_sync_status, last_sync_error, last_sync_duration_ms)
      VALUES (${walletLower}, NOW(), 'error', ${errorMsg.slice(0, 500)}, ${durationMs})
      ON CONFLICT (wallet) DO UPDATE SET
        last_synced_at = NOW(),
        last_sync_status = 'error',
        last_sync_error = EXCLUDED.last_sync_error,
        last_sync_duration_ms = EXCLUDED.last_sync_duration_ms
    `;

    return { rowsUpdated: 0, error: errorMsg };
  }
}

export async function POST(request: Request) {
  // Feature flag check
  if (!isPositionSyncEnabled()) {
    return NextResponse.json(
      { error: 'Position sync is disabled. Set ENABLE_POSITION_SYNC=true to enable.' },
      { status: 403, headers: NO_CACHE_HEADERS }
    );
  }

  const startTime = Date.now();

  try {
    const body: RefreshRequest = await request.json();
    const { scope, wallets: providedWallets } = body;

    // Determine wallets to sync
    let wallets: string[];

    if (scope === 'wallets' && providedWallets && providedWallets.length > 0) {
      // Use provided wallets
      wallets = providedWallets.map(w => w.toLowerCase());
    } else if (scope === 'filter') {
      // Get wallets from filter params
      wallets = await getWalletsFromFilter(body);
    } else {
      return NextResponse.json(
        { error: 'Invalid request: must specify scope=wallets with wallets[] or scope=filter with filter params' },
        { status: 400, headers: NO_CACHE_HEADERS }
      );
    }

    if (wallets.length === 0) {
      return NextResponse.json({
        success: true,
        result: {
          walletsRequested: 0,
          walletsSynced: 0,
          walletsSkippedTtl: 0,
          walletsFailed: 0,
          rowsUpdated: 0,
          errors: [],
          durationMs: Date.now() - startTime,
        },
      }, { headers: NO_CACHE_HEADERS });
    }

    // Cap wallets to prevent abuse
    const cappedWallets = wallets.slice(0, 200);
    const alertWindowHours = body.alertWindowHours || 72;

    // Check TTL for each wallet
    const walletsToSync: string[] = [];
    let walletsSkippedTtl = 0;

    for (const wallet of cappedWallets) {
      const skip = await shouldSkipWallet(wallet);
      if (skip) {
        walletsSkippedTtl++;
      } else {
        walletsToSync.push(wallet);
      }
    }

    // Sync wallets with concurrency limit
    const results = await Promise.all(
      walletsToSync.map(wallet =>
        syncLimit(async () => {
          const result = await syncWalletPositions(wallet, alertWindowHours);
          return { wallet, ...result };
        })
      )
    );

    // Aggregate results
    let walletsSynced = 0;
    let walletsFailed = 0;
    let rowsUpdated = 0;
    const errors: string[] = [];

    for (const result of results) {
      if (result.error) {
        walletsFailed++;
        errors.push(`${result.wallet}: ${result.error}`);
      } else {
        walletsSynced++;
        rowsUpdated += result.rowsUpdated;
      }
    }

    const syncResult: SyncResult = {
      walletsRequested: cappedWallets.length,
      walletsSynced,
      walletsSkippedTtl,
      walletsFailed,
      rowsUpdated,
      errors: errors.slice(0, 10), // Limit error messages
      durationMs: Date.now() - startTime,
    };

    console.log('[positions/refresh] Sync complete:', syncResult);

    return NextResponse.json({
      success: true,
      result: syncResult,
    }, { headers: NO_CACHE_HEADERS });

  } catch (err) {
    console.error('[positions/refresh] Error:', err);
    return NextResponse.json(
      { error: 'Position refresh failed', details: String(err) },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}

// GET endpoint to check sync status
export async function GET(request: Request) {
  // Feature flag check
  if (!isPositionSyncEnabled()) {
    return NextResponse.json(
      { enabled: false, message: 'Position sync is disabled' },
      { headers: NO_CACHE_HEADERS }
    );
  }

  try {
    // Get overall sync stats
    const statsResult = await sql<{
      total_synced: number;
      last_sync_at: string | null;
      recent_syncs_1h: number;
    }>`
      SELECT
        COUNT(*)::int as total_synced,
        MAX(last_synced_at)::text as last_sync_at,
        COUNT(*) FILTER (WHERE last_synced_at > NOW() - INTERVAL '1 hour')::int as recent_syncs_1h
      FROM wallet_sync_state
    `;

    const overlayStatsResult = await sql<{
      total_overlays: number;
      recent_overlays_10m: number;
      last_overlay_at: string | null;
    }>`
      SELECT
        COUNT(*)::int as total_overlays,
        COUNT(*) FILTER (WHERE synced_at > NOW() - INTERVAL '10 minutes')::int as recent_overlays_10m,
        MAX(synced_at)::text as last_overlay_at
      FROM position_sync_overlay
    `;

    const stats = statsResult.rows[0];
    const overlayStats = overlayStatsResult.rows[0];

    return NextResponse.json({
      enabled: true,
      config: {
        ttlMs: SYNC_TTL_MS,
        concurrency: SYNC_CONCURRENCY,
        positionLimitPerWallet: POSITION_LIMIT_PER_WALLET,
      },
      walletSyncState: {
        totalWalletsSynced: stats?.total_synced ?? 0,
        lastSyncAt: stats?.last_sync_at ?? null,
        recentSyncsLastHour: stats?.recent_syncs_1h ?? 0,
      },
      overlayStats: {
        totalOverlays: overlayStats?.total_overlays ?? 0,
        recentOverlaysLast10Min: overlayStats?.recent_overlays_10m ?? 0,
        lastOverlayAt: overlayStats?.last_overlay_at ?? null,
      },
    }, { headers: NO_CACHE_HEADERS });

  } catch (err) {
    console.error('[positions/refresh] GET Error:', err);
    return NextResponse.json(
      { enabled: true, error: 'Failed to get sync status', details: String(err) },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}
