// /app/api/jobs/scan-nonsports/route.ts
// Scans non-sports markets to discover wallets with large longshot positions
// Complements scan-positions by focusing specifically on non-sports markets

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
const GAMMA_API = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const SPORTS_TAG_ID = '1'; // Tag ID that all sports events have
const MIN_POSITION_VALUE = 2500;
const LONGSHOT_THRESHOLD = 0.25; // 25% odds or less = longshot
const WALLET_CONCURRENCY = 10;
const MAX_WALLETS_PER_RUN = 500;
const MAX_EVENTS_TO_SCAN = 100;
const TRADES_PER_EVENT = 200;
const POSITION_LIMIT_PER_WALLET = 100;
const JOB_NAME = 'scan-nonsports';

const walletLimit = pLimit(WALLET_CONCURRENCY);
const eventLimit = pLimit(5); // Limit concurrent event API calls

interface JobMetrics {
  eventsScanned: number;
  walletsDiscovered: number;
  walletsScanned: number;
  positionsFound: number;
  positionsInserted: number;
  positionsSkippedExists: number;
  positionsSkippedResolved: number;
  positionsSkippedNotLongshot: number;
  errors: string[];
}

interface GammaEvent {
  slug: string;
  title: string;
  volume?: number;
  tags?: Array<{ id: string; label: string }>;
  markets?: Array<{
    conditionId: string;
    volume?: string;
  }>;
}

// Fetch active non-sports events from Gamma API
async function fetchNonSportsEvents(): Promise<GammaEvent[]> {
  const allEvents: GammaEvent[] = [];
  let offset = 0;
  const limit = 100;

  try {
    // Fetch up to 500 active events
    for (let i = 0; i < 5; i++) {
      const url = `${GAMMA_API}/events?closed=false&limit=${limit}&offset=${offset}`;
      const res = await fetch(url, { cache: 'no-store' });

      if (!res.ok) {
        console.error(`[${JOB_NAME}] Gamma API returned ${res.status}`);
        break;
      }

      const events: GammaEvent[] = await res.json();
      if (!Array.isArray(events) || events.length === 0) break;

      // Filter out sports events (those with tag "1")
      const nonSportsEvents = events.filter(event => {
        if (!event.tags || !Array.isArray(event.tags)) return true;
        return !event.tags.some(tag => tag.id === SPORTS_TAG_ID);
      });

      allEvents.push(...nonSportsEvents);
      offset += limit;

      if (events.length < limit) break; // No more pages
    }

    // Sort by volume (highest first) and take top events
    return allEvents
      .sort((a, b) => (b.volume || 0) - (a.volume || 0))
      .slice(0, MAX_EVENTS_TO_SCAN);

  } catch (err) {
    console.error(`[${JOB_NAME}] Failed to fetch events:`, err);
    return [];
  }
}

// Fetch recent trades for a specific market to discover wallets
async function fetchTradesForMarket(conditionId: string): Promise<string[]> {
  try {
    const url = `${DATA_API}/trades?conditionId=${conditionId}&limit=${TRADES_PER_EVENT}&filterType=CASH&filterAmount=100`;
    const res = await fetch(url, { cache: 'no-store' });

    if (!res.ok) return [];

    const trades = await res.json();
    if (!Array.isArray(trades)) return [];

    const wallets = new Set<string>();
    for (const trade of trades) {
      if (trade.proxyWallet) {
        wallets.add(trade.proxyWallet.toLowerCase());
      }
    }

    return Array.from(wallets);
  } catch (err) {
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

  // Generate UUID and dedupe_id for this position discovery
  const id = crypto.randomUUID();
  const tradeDedupeId = `nonsports-${walletLower}-${conditionId}-${outcome}-${Date.now()}`;
  const now = new Date().toISOString();

  // Calculate fill value (cost basis = size × avgPrice)
  const fillValueUsd = (positionSize * avgPrice).toFixed(2);

  // Derive outcome_index if not provided (Yes = 0, No = 1)
  const outcomeIndex = position.outcomeIndex ?? (outcome === 'Yes' ? 0 : 1);

  await sql`
    INSERT INTO alert_events (
      id,
      trade_dedupe_id,
      wallet,
      asset,
      condition_id,
      outcome,
      outcome_index,
      side,
      title,
      slug,
      event_slug,
      fill_price,
      fill_size,
      fill_value_usd,
      fill_timestamp,
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
      threshold_source
    ) VALUES (
      ${id},
      ${tradeDedupeId},
      ${walletLower},
      ${position.asset},
      ${conditionId},
      ${outcome},
      ${outcomeIndex},
      ${'BUY'},
      ${position.title || null},
      ${position.slug || null},
      ${position.eventSlug || null},
      ${avgPrice},
      ${positionSize},
      ${fillValueUsd},
      ${now}::timestamptz,
      ${positionSize},
      ${avgPrice},
      ${curPrice},
      ${initialValue},
      ${currentValue},
      ${position.cashPnl || 0},
      ${now}::timestamptz,
      ${LONGSHOT_THRESHOLD},
      ${MIN_POSITION_VALUE},
      ${avgPrice <= LONGSHOT_THRESHOLD},
      ${true},
      ${currentValue},
      ${'scan-nonsports'}
    )
    ON CONFLICT (trade_dedupe_id) DO NOTHING
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
      const avgPrice = position.avgPrice ?? 0;
      const curPrice = position.curPrice ?? 0;
      const currentValue = positionSize * curPrice;

      // Only process positions with value >= $2,500
      if (currentValue >= MIN_POSITION_VALUE) {
        // Check if it was BOUGHT at longshot odds (avgPrice <= 25%)
        if (avgPrice > LONGSHOT_THRESHOLD) {
          metrics.positionsSkippedNotLongshot++;
          continue;
        }
        metrics.positionsFound++;
        await insertPosition(wallet, position, metrics);
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (metrics.errors.length < 10) {
      metrics.errors.push(`${wallet}: ${errorMsg.slice(0, 100)}`);
    }
  }
}

export async function POST(request: Request) {
  if (!isCronAuthed(request)) {
    return cronUnauthorized();
  }

  const startTime = Date.now();
  const metrics: JobMetrics = {
    eventsScanned: 0,
    walletsDiscovered: 0,
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

    // Step 1: Get non-sports events
    console.log(`[${JOB_NAME}] Fetching non-sports events...`);
    const events = await fetchNonSportsEvents();
    metrics.eventsScanned = events.length;

    if (events.length === 0) {
      const durationMs = Date.now() - startTime;
      await sql`
        UPDATE job_runs
        SET status = 'success', finished_at = NOW(), duration_ms = ${durationMs}, metrics = ${JSON.stringify(metrics)}
        WHERE id = ${jobRunId}
      `;
      return NextResponse.json({
        jobRunId,
        status: 'success',
        message: 'No non-sports events found',
        ...metrics,
        durationMs,
      }, { headers: NO_CACHE_HEADERS });
    }

    console.log(`[${JOB_NAME}] Found ${events.length} non-sports events`);

    // Step 2: Discover wallets from trades on these events
    const allWallets = new Set<string>();

    await Promise.all(
      events.map(event =>
        eventLimit(async () => {
          if (!event.markets) return;

          for (const market of event.markets.slice(0, 5)) { // Max 5 markets per event
            const wallets = await fetchTradesForMarket(market.conditionId);
            wallets.forEach(w => allWallets.add(w));
          }
        })
      )
    );

    metrics.walletsDiscovered = allWallets.size;
    console.log(`[${JOB_NAME}] Discovered ${allWallets.size} unique wallets from non-sports trades`);

    // Step 3: Limit wallets and scan for positions
    const walletsToScan = Array.from(allWallets).slice(0, MAX_WALLETS_PER_RUN);
    metrics.walletsScanned = walletsToScan.length;

    console.log(`[${JOB_NAME}] Scanning ${walletsToScan.length} wallets for longshot positions...`);

    await Promise.all(
      walletsToScan.map(wallet =>
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
      eventsScanned: metrics.eventsScanned,
      walletsDiscovered: metrics.walletsDiscovered,
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
      { error: 'Non-sports scan failed', details: errorMessage },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}

// GET endpoint for Vercel Cron compatibility
export async function GET(request: Request) {
  return POST(request);
}
