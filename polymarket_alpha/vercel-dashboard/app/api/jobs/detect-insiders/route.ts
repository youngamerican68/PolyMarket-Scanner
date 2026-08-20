// /app/api/jobs/detect-insiders/route.ts
// Narrow insider-pattern detector.
//
// Pattern: fresh wallet (<=1 lifetime alerts in DB) places a small bet ($100-$500)
// on a deep longshot (<10% implied probability). Verify via Polymarket trades API
// that the wallet truly has minimal lifetime trading history (<=3 trades). If yes,
// record as a confirmed insider candidate for the /insiders dashboard.
//
// Scheduled via GitHub Actions every 15 minutes.

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import pLimit from 'p-limit';
import { isCronAuthed, cronUnauthorized } from '@/lib/cronAuth';
import { sendTelegramMessage, escapeHtml, isTelegramConfigured } from '@/lib/telegram';
import { fetchPositionsWithRetry } from '@/lib/polymarket';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

// Filter thresholds (derived from observed-edge analysis)
const MAX_FILL_PRICE = 0.10;        // deep longshot
const MIN_FILL_USD = 100;           // exclude dust
const MAX_FILL_USD = 500;           // sweet spot bucket from the analysis
const SCAN_WINDOW_HOURS = 48;       // catch-up window per run
const MAX_CANDIDATES_PER_RUN = 100; // cap API calls per run

// Verification thresholds
const MAX_LIFETIME_TRADES = 3;      // including the trade that triggered -> 'confirmed'
const WATCH_MAX_LIFETIME_TRADES = 10; // 4..10 -> 'watch': near-miss tier, shown but never alerted

// Corroboration: a second position by the same wallet on the SAME event at a high
// implied probability. A lottery-ticket buyer takes the longshot only; someone who
// believes they know the outcome also parks money on the near-certainty. Computed at
// detection time and stored, because winning positions get redeemed and disappear
// from the positions API within days.
const CORROBORATION_MIN_AVG_PRICE = 0.60;

// Wallet-history paging. Pre-fill trades are the oldest, so freshness is only exact
// once we reach the end of a wallet's history; 2000 covers any plausible one-shot.
const HISTORY_PAGE_SIZE = 500;
const HISTORY_MAX_PAGES = 4;

// API concurrency
const API_CONCURRENCY = 5;

// Notification: cap per run so a backlog or bug can never turn into a message flood.
const MAX_NOTIFY_PER_RUN = 10;
const POLYMARKET_TRADES_URL = 'https://data-api.polymarket.com/trades';

interface CandidateRow {
  id: string;
  wallet: string;
  condition_id: string;
  outcome: string;
  fill_price: string;
  fill_value_usd: string;
  fill_timestamp: string;
  title: string | null;
  event_slug: string | null;
  slug: string | null;
}

interface PolymarketTrade {
  timestamp: number;
}

interface WalletHistory {
  lifetimeTrades: number;    // as of NOW -- drifts upward, kept for reference only
  timestamps: number[];      // every fetched trade time, for point-in-time counting
  firstTradeAt: Date | null;
  lookupOk: boolean;
  historyTruncated: boolean; // could not page back far enough to be certain
}

/**
 * Point-in-time freshness: how many trades this wallet had made at or before the
 * triggering fill (inclusive). This is what the tiering uses.
 *
 * Counting "trades now" instead is a look-ahead bug: the Eurovision wallet had 1
 * trade when it bet and has 13 today, so the best signal this system ever produced
 * would be classified rejected_established on re-verification.
 */
function countAtOrBefore(timestamps: number[], fillTimestampSec: number): number {
  return timestamps.reduce((n, t) => (t <= fillTimestampSec ? n + 1 : n), 0);
}

async function fetchWalletHistory(wallet: string): Promise<WalletHistory> {
  const EMPTY: WalletHistory = {
    lifetimeTrades: 0, timestamps: [],
    firstTradeAt: null, lookupOk: false, historyTruncated: false,
  };

  const all: PolymarketTrade[] = [];
  let truncated = false;

  try {
    for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
      const res = await fetch(
        `${POLYMARKET_TRADES_URL}?user=${wallet}&limit=${HISTORY_PAGE_SIZE}&offset=${page * HISTORY_PAGE_SIZE}`,
        { cache: 'no-store' }
      );
      if (!res.ok) return EMPTY;

      const batch = (await res.json()) as PolymarketTrade[];
      if (!Array.isArray(batch)) return EMPTY;
      all.push(...batch);

      if (batch.length < HISTORY_PAGE_SIZE) break;      // reached end of history
      if (page === HISTORY_MAX_PAGES - 1) truncated = true;
    }
  } catch {
    return EMPTY;
  }

  const timestamps = all
    .map(t => t.timestamp)
    .filter((t): t is number => typeof t === 'number');

  const firstTs = all.reduce<number | null>((min, t) => {
    if (typeof t.timestamp !== 'number') return min;
    return min === null || t.timestamp < min ? t.timestamp : min;
  }, null);

  return {
    lifetimeTrades: all.length,
    timestamps,
    firstTradeAt: firstTs !== null ? new Date(firstTs * 1000) : null,
    lookupOk: true,
    historyTruncated: truncated,
  };
}

interface Corroboration {
  corroborated: boolean;
  title: string | null;
  avgPrice: number | null;
  valueUsd: number | null;
}

const NO_CORROBORATION: Corroboration = {
  corroborated: false, title: null, avgPrice: null, valueUsd: null,
};

/**
 * Look for a sibling position: same event, different market, high implied probability.
 * Best-effort -- a lookup failure means "not corroborated", never an error.
 */
async function checkCorroboration(
  wallet: string,
  eventSlug: string | null,
  conditionId: string
): Promise<Corroboration> {
  if (!eventSlug) return NO_CORROBORATION;
  try {
    const { positions } = await fetchPositionsWithRetry(wallet, 200);
    const siblings = positions.filter(
      (pos) =>
        pos.eventSlug === eventSlug &&
        pos.conditionId !== conditionId &&
        pos.avgPrice != null &&
        pos.avgPrice >= CORROBORATION_MIN_AVG_PRICE &&
        // Affirmative positions only. A high-priced "No" is the market's default
        // expectation -- betting against a hopeless outcome is near-riskless and
        // carries almost no information. The Eurovision case that motivated this
        // check was "Yes" at 93.5c: paying up for something to HAPPEN.
        (pos.outcome ?? '').toLowerCase() !== 'no'
    );
    if (siblings.length === 0) return NO_CORROBORATION;

    // Report the largest such position.
    const best = siblings.reduce((a, b) =>
      (b.initialValue ?? 0) > (a.initialValue ?? 0) ? b : a
    );
    return {
      corroborated: true,
      title: best.title ?? null,
      avgPrice: best.avgPrice ?? null,
      valueUsd: best.initialValue ?? null,
    };
  } catch {
    return NO_CORROBORATION;
  }
}

interface NotifyMetrics { pending: number; sent: number; failed: number; skipped: number }

/**
 * Send Telegram alerts for confirmed candidates that have not been notified yet.
 *
 * Driven off notified_at rather than fired inline at confirm time, so a Telegram
 * outage retries on the next run instead of dropping the alert. MUST run on every
 * invocation -- including runs with zero new candidates -- otherwise a confirm
 * recorded during a busy run would wait for the next busy run to be delivered.
 *
 * Never throws: notification failure must not fail the detection job.
 */
async function runNotificationSweep(errors: string[]): Promise<NotifyMetrics> {
  const notify: NotifyMetrics = { pending: 0, sent: 0, failed: 0, skipped: 0 };
  try {
    const pending = await sql<{
      alert_event_id: string; wallet: string; outcome: string; fill_price: string;
      fill_value_usd: string; title: string | null; event_slug: string | null;
      slug: string | null; polymarket_lifetime_trades: number | null;
      corroborated: boolean; corroborating_title: string | null;
      corroborating_avg_price: string | null; corroborating_value_usd: string | null;
    }>`
      SELECT alert_event_id, wallet, outcome, fill_price::text, fill_value_usd::text,
             title, event_slug, slug, polymarket_lifetime_trades,
             corroborated, corroborating_title,
             corroborating_avg_price::text, corroborating_value_usd::text
      FROM insider_candidates
      WHERE notified_at IS NULL AND verification_status = 'confirmed'
      ORDER BY verified_at ASC
      LIMIT ${MAX_NOTIFY_PER_RUN}
    `;
    notify.pending = pending.rows.length;
    if (pending.rows.length === 0) return notify;

    if (!isTelegramConfigured()) {
      // Leave notified_at NULL so these send once the env vars are configured.
      notify.skipped = pending.rows.length;
      console.warn(`[detect-insiders] ${pending.rows.length} confirmed candidate(s) pending notification, but TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are not set`);
      return notify;
    }

    for (const r of pending.rows) {
      const price = Number(r.fill_price);
      const value = Number(r.fill_value_usd);
      const marketSlug = r.event_slug || r.slug;
      const text = [
        '\u{1F6A8} <b>Insider pattern confirmed</b>',
        '',
        `<b>${escapeHtml(r.title ?? 'Unknown market')}</b>`,
        `Bet: <b>${escapeHtml(r.outcome)}</b> @ ${(price * 100).toFixed(1)}%`,
        `Size: $${value.toFixed(0)}`,
        `Wallet: <code>${escapeHtml(r.wallet)}</code>`,
        `Lifetime trades: <b>${r.polymarket_lifetime_trades ?? '?'}</b>`,
        ...(r.corroborated
          ? [
              '',
              '\u{2705} <b>Corroborated</b> \u2014 same wallet, same event:',
              `<i>${escapeHtml(r.corroborating_title ?? 'another market')}</i>`,
              `at ${((Number(r.corroborating_avg_price) || 0) * 100).toFixed(1)}% for $${(Number(r.corroborating_value_usd) || 0).toFixed(0)}`,
            ]
          : []),
        '',
        marketSlug
          ? `<a href="https://polymarket.com/event/${encodeURIComponent(marketSlug)}">Market</a> \u00B7 <a href="https://polymarket.com/profile/${encodeURIComponent(r.wallet)}">Wallet</a>`
          : `<a href="https://polymarket.com/profile/${encodeURIComponent(r.wallet)}">Wallet</a>`,
      ].join('\n');

      const result = await sendTelegramMessage(text);
      if (result.status === 'sent') {
        await sql`UPDATE insider_candidates SET notified_at = NOW() WHERE alert_event_id = ${r.alert_event_id}`;
        notify.sent++;
      } else if (result.status === 'skipped') {
        notify.skipped++;
      } else {
        notify.failed++;
        errors.push(`telegram: ${result.error}`);
        console.error(`[detect-insiders] Telegram send failed for ${r.alert_event_id}: ${result.error}`);
      }
    }
  } catch (e) {
    errors.push(`notify-sweep: ${String(e).slice(0, 80)}`);
    console.error('[detect-insiders] Notification sweep failed:', e);
  }
  return notify;
}

export async function GET(request: Request) {
  if (!isCronAuthed(request)) return cronUnauthorized();

  const startedAt = Date.now();

  const metrics = {
    candidatesScanned: 0,
    apiCalls: 0,
    confirmed: 0,
    watch: 0,
    corroborated: 0,
    historyTruncated: 0,
    rejectedEstablished: 0,
    rejectedLookupFailed: 0,
    skippedExisting: 0,
    errors: [] as string[],
  };

  try {
    // Pre-filter candidates in SQL: recent, qualifying trades from wallets that
    // look like one-shots in our own data (at most 1 lifetime alert in DB).
    // Also skip any alert_event already processed (insider_candidates.alert_event_id).
    const { rows: candidates } = await sql<CandidateRow>`
      WITH wallet_counts AS (
        SELECT wallet, COUNT(*)::int AS cnt FROM alert_events GROUP BY wallet
      )
      SELECT
        ae.id,
        ae.wallet,
        ae.condition_id,
        ae.outcome,
        ae.fill_price::text,
        ae.fill_value_usd::text,
        ae.fill_timestamp::text,
        ae.title,
        ae.event_slug,
        ae.slug
      FROM alert_events ae
      JOIN wallet_counts wc ON wc.wallet = ae.wallet
      LEFT JOIN insider_candidates ic ON ic.alert_event_id = ae.id
      WHERE ic.alert_event_id IS NULL
        AND ae.side = 'BUY'
        AND ae.fill_price < ${MAX_FILL_PRICE}
        AND ae.fill_value_usd >= ${MIN_FILL_USD}
        AND ae.fill_value_usd <= ${MAX_FILL_USD}
        AND ae.fill_timestamp >= NOW() - (INTERVAL '1 hour' * ${SCAN_WINDOW_HOURS})
        AND wc.cnt <= 1
      ORDER BY ae.fill_timestamp DESC
      LIMIT ${MAX_CANDIDATES_PER_RUN}
    `;

    metrics.candidatesScanned = candidates.length;

    if (candidates.length === 0) {
      // Still sweep: a confirm from an earlier run may be waiting on delivery.
      const notify = await runNotificationSweep(metrics.errors);
      return NextResponse.json(
        { ok: true, metrics, notify, durationMs: Date.now() - startedAt },
        { headers: NO_CACHE_HEADERS }
      );
    }

    const limit = pLimit(API_CONCURRENCY);

    // One API call per distinct wallet in the candidate batch.
    const uniqueWallets = Array.from(new Set(candidates.map(c => c.wallet)));
    metrics.apiCalls = uniqueWallets.length;

    const walletHistories = new Map<string, WalletHistory>();
    await Promise.all(
      uniqueWallets.map(w =>
        limit(async () => {
          walletHistories.set(w, await fetchWalletHistory(w));
        })
      )
    );

    // Persist results row-by-row (small batch, clearer error handling).
    for (const c of candidates) {
      const hist = walletHistories.get(c.wallet);
      if (!hist || !hist.lookupOk) {
        try {
          await sql`
            INSERT INTO insider_candidates
              (alert_event_id, wallet, condition_id, outcome, fill_price, fill_value_usd,
               fill_timestamp, title, event_slug, slug, verification_status, verified_at)
            VALUES
              (${c.id}, ${c.wallet}, ${c.condition_id}, ${c.outcome},
               ${c.fill_price}, ${c.fill_value_usd}, ${c.fill_timestamp},
               ${c.title}, ${c.event_slug}, ${c.slug},
               'rejected_lookup_failed', NOW())
            ON CONFLICT (alert_event_id) DO NOTHING
          `;
          metrics.rejectedLookupFailed++;
        } catch (e) {
          metrics.errors.push(`insert-failed-lookup: ${String(e).slice(0, 80)}`);
        }
        continue;
      }

      // Freshness is measured AT THE FILL, not now. See countAtOrBefore().
      const fillTsSec = Math.floor(new Date(c.fill_timestamp).getTime() / 1000);
      const atFill = countAtOrBefore(hist.timestamps, fillTsSec);

      // If we could not page back to the end of this wallet's history, a small
      // at-fill count is not trustworthy (there may be older trades we never saw).
      // Reject rather than report a confident-looking wrong number.
      const trustworthy = !hist.historyTruncated && Number.isFinite(fillTsSec);

      const isConfirmed = trustworthy && atFill > 0 && atFill <= MAX_LIFETIME_TRADES;
      const isWatch =
        trustworthy && !isConfirmed && atFill > 0 && atFill <= WATCH_MAX_LIFETIME_TRADES;
      const status = isConfirmed ? 'confirmed' : isWatch ? 'watch' : 'rejected_established';
      if (hist.historyTruncated) metrics.historyTruncated++;

      // Only worth an API call for tiers we actually surface.
      const corr =
        isConfirmed || isWatch
          ? await checkCorroboration(c.wallet, c.event_slug, c.condition_id)
          : NO_CORROBORATION;
      if (corr.corroborated) metrics.corroborated++;

      try {
        await sql`
          INSERT INTO insider_candidates
            (alert_event_id, wallet, condition_id, outcome, fill_price, fill_value_usd,
             fill_timestamp, title, event_slug, slug, verification_status,
             polymarket_lifetime_trades, polymarket_first_trade_at, verified_at,
             corroborated, corroborating_title, corroborating_avg_price, corroborating_value_usd,
             lifetime_trades_at_fill, history_truncated)
          VALUES
            (${c.id}, ${c.wallet}, ${c.condition_id}, ${c.outcome},
             ${c.fill_price}, ${c.fill_value_usd}, ${c.fill_timestamp},
             ${c.title}, ${c.event_slug}, ${c.slug},
             ${status},
             ${hist.lifetimeTrades},
             ${hist.firstTradeAt ? hist.firstTradeAt.toISOString() : null},
             NOW(),
             ${corr.corroborated}, ${corr.title}, ${corr.avgPrice}, ${corr.valueUsd},
             ${atFill}, ${hist.historyTruncated})
          ON CONFLICT (alert_event_id) DO NOTHING
        `;
        if (isConfirmed) metrics.confirmed++;
        else if (isWatch) metrics.watch++;
        else metrics.rejectedEstablished++;
      } catch (e) {
        metrics.errors.push(`insert-verified: ${String(e).slice(0, 80)}`);
      }
    }

    const notify = await runNotificationSweep(metrics.errors);
    return NextResponse.json(
      { ok: true, metrics, notify, durationMs: Date.now() - startedAt },
      { headers: NO_CACHE_HEADERS }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: msg, metrics, durationMs: Date.now() - startedAt },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}
