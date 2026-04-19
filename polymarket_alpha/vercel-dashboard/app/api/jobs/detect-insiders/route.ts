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
const MAX_LIFETIME_TRADES = 3;      // including the trade that triggered

// API concurrency
const API_CONCURRENCY = 5;
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
  lifetimeTrades: number;
  firstTradeAt: Date | null;
  lookupOk: boolean;
}

async function fetchWalletHistory(wallet: string): Promise<WalletHistory> {
  try {
    // limit=1000 is well above our threshold; we only need to know if the wallet
    // has more than MAX_LIFETIME_TRADES trades. Fetching more is cheap and
    // gives us first-trade timestamp as a bonus.
    const res = await fetch(
      `${POLYMARKET_TRADES_URL}?user=${wallet}&limit=1000`,
      { cache: 'no-store' }
    );
    if (!res.ok) {
      return { lifetimeTrades: 0, firstTradeAt: null, lookupOk: false };
    }
    const trades = (await res.json()) as PolymarketTrade[];
    if (!Array.isArray(trades)) {
      return { lifetimeTrades: 0, firstTradeAt: null, lookupOk: false };
    }
    const lifetimeTrades = trades.length;
    const firstTs = trades.reduce<number | null>((min, t) => {
      if (typeof t.timestamp !== 'number') return min;
      return min === null || t.timestamp < min ? t.timestamp : min;
    }, null);
    return {
      lifetimeTrades,
      firstTradeAt: firstTs !== null ? new Date(firstTs * 1000) : null,
      lookupOk: true,
    };
  } catch {
    return { lifetimeTrades: 0, firstTradeAt: null, lookupOk: false };
  }
}

export async function GET(request: Request) {
  if (!isCronAuthed(request)) return cronUnauthorized();

  const startedAt = Date.now();

  const metrics = {
    candidatesScanned: 0,
    apiCalls: 0,
    confirmed: 0,
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
      return NextResponse.json(
        { ok: true, metrics, durationMs: Date.now() - startedAt },
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

      const isConfirmed = hist.lifetimeTrades > 0 && hist.lifetimeTrades <= MAX_LIFETIME_TRADES;
      const status = isConfirmed ? 'confirmed' : 'rejected_established';

      try {
        await sql`
          INSERT INTO insider_candidates
            (alert_event_id, wallet, condition_id, outcome, fill_price, fill_value_usd,
             fill_timestamp, title, event_slug, slug, verification_status,
             polymarket_lifetime_trades, polymarket_first_trade_at, verified_at)
          VALUES
            (${c.id}, ${c.wallet}, ${c.condition_id}, ${c.outcome},
             ${c.fill_price}, ${c.fill_value_usd}, ${c.fill_timestamp},
             ${c.title}, ${c.event_slug}, ${c.slug},
             ${status},
             ${hist.lifetimeTrades},
             ${hist.firstTradeAt ? hist.firstTradeAt.toISOString() : null},
             NOW())
          ON CONFLICT (alert_event_id) DO NOTHING
        `;
        if (isConfirmed) metrics.confirmed++;
        else metrics.rejectedEstablished++;
      } catch (e) {
        metrics.errors.push(`insert-verified: ${String(e).slice(0, 80)}`);
      }
    }

    return NextResponse.json(
      { ok: true, metrics, durationMs: Date.now() - startedAt },
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
