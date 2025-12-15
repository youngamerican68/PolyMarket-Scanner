// app/api/longshot-history/route.ts
// Returns all historical longshot trades (permanent, never pruned)

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CLOB_API = "https://clob.polymarket.com";

// Fetch current prices for a market
async function fetchMarketPrices(marketId: string): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  try {
    const res = await fetch(`${CLOB_API}/markets/${marketId}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      if (data.tokens && Array.isArray(data.tokens)) {
        for (const token of data.tokens) {
          prices.set(token.outcome, Number(token.price ?? 0));
        }
      }
    }
  } catch (err) {
    console.error(`Error fetching prices for ${marketId}:`, err);
  }
  return prices;
}

export async function GET() {
  try {
    // Fetch all historical longshot trades, newest first
    // NOTE: Using created_at for ordering because ORDER BY timestamp has index issues
    // JOIN with whale_watchlist to flag whale trades
    const result = await sql`
      SELECT
        lh.id,
        lh.wallet,
        lh.name,
        lh.market_id,
        lh.event_slug,
        lh.title,
        lh.outcome,
        lh.timestamp,
        lh.price,
        lh.size,
        lh.value,
        lh.resolved,
        lh.won,
        lh.pnl,
        lh.resolution_state,
        lh.resolution_source,
        lh.created_at,
        ww.tier as whale_tier
      FROM longshot_history lh
      LEFT JOIN whale_watchlist ww ON lh.wallet = ww.wallet
      ORDER BY lh.created_at DESC
      LIMIT 500
    `;

    console.log('[longshot-history] Query returned', result.rows.length, 'rows');

    // Get unique market IDs and fetch current prices (limit to recent 50 markets to avoid timeout)
    const uniqueMarkets = Array.from(new Set(result.rows.map(r => r.market_id))).slice(0, 50);
    const marketPrices = new Map<string, Map<string, number>>();

    // Fetch prices in parallel (batch of 10 at a time)
    for (let i = 0; i < uniqueMarkets.length; i += 10) {
      const batch = uniqueMarkets.slice(i, i + 10);
      const pricePromises = batch.map(async (marketId) => {
        const prices = await fetchMarketPrices(marketId);
        return { marketId, prices };
      });
      const results = await Promise.all(pricePromises);
      for (const { marketId, prices } of results) {
        marketPrices.set(marketId, prices);
      }
    }

    const trades = result.rows.map((row) => {
      const entryPrice = Number(row.price);
      const size = Number(row.size);
      const marketId = row.market_id;
      const outcome = row.outcome;

      // Get current price from cached market prices
      const prices = marketPrices.get(marketId);
      let curPrice = prices?.get(outcome) ?? 0;

      // If market is resolved, use resolution result instead of live price
      // (live price lookup can fail or return stale data)
      if (row.resolved) {
        curPrice = row.won ? 1.0 : 0.0;
      }

      // Calculate position and potential
      const position = size * curPrice;
      const potential = size;

      // Determine status based on resolution_state column
      // Priority: 1) confirmed resolution, 2) inferred resolution from DB, 3) live price inference
      let inferredStatus: 'confirmed_won' | 'confirmed_lost' | 'inferred_won' | 'inferred_lost' | 'likely_won' | 'likely_lost' | 'holding' = 'holding';

      const resolutionState = row.resolution_state || 'unresolved';

      if (resolutionState === 'confirmed') {
        // Officially confirmed by Polymarket API (market.closed = true with winner)
        inferredStatus = row.won ? 'confirmed_won' : 'confirmed_lost';
      } else if (resolutionState === 'inferred') {
        // Inferred from price by check-resolutions cron (stored in DB)
        inferredStatus = row.won ? 'inferred_won' : 'inferred_lost';
      } else if (curPrice >= 0.98) {
        // Live price at 98%+ = market effectively settled to YES (not yet in DB)
        inferredStatus = 'likely_won';
      } else if (curPrice <= 0.02 && curPrice > 0) {
        // Live price at 2% or less = market effectively settled to NO (not yet in DB)
        inferredStatus = 'likely_lost';
      }
      // Note: If curPrice is 0, it's likely a price fetch failure - keep as 'holding'

      return {
        id: row.id,
        wallet: row.wallet,
        name: row.name || "Anonymous",
        marketId,
        eventSlug: row.event_slug,
        title: row.title,
        outcome,
        timestamp: Number(row.timestamp),
        price: entryPrice,
        size,
        value: Number(row.value),
        resolved: row.resolved,
        won: row.won,
        pnl: row.pnl ? Number(row.pnl) : null,
        resolutionState: row.resolution_state || 'unresolved',
        resolutionSource: row.resolution_source || null,
        createdAt: row.created_at,
        // Calculated fields
        curPrice,
        position,
        potential,
        inferredStatus,
        // Whale watchlist indicator
        whaleTier: row.whale_tier || null,
      };
    });

    // Get summary stats
    const statsResult = await sql`
      SELECT
        COUNT(*) as total_trades,
        COUNT(DISTINCT wallet) as unique_wallets,
        SUM(value) as total_value,
        COUNT(CASE WHEN resolved = true THEN 1 END) as resolved_count,
        COUNT(CASE WHEN won = true THEN 1 END) as won_count,
        COUNT(CASE WHEN resolution_state = 'confirmed' THEN 1 END) as confirmed_count,
        COUNT(CASE WHEN resolution_state = 'inferred' THEN 1 END) as inferred_count
      FROM longshot_history
    `;

    const stats = statsResult.rows[0];

    console.log('[longshot-history] Returning', trades.length, 'trades, stats:', stats);

    return NextResponse.json({
      trades,
      stats: {
        totalTrades: Number(stats.total_trades),
        uniqueWallets: Number(stats.unique_wallets),
        totalValue: Number(stats.total_value || 0),
        resolvedCount: Number(stats.resolved_count),
        confirmedCount: Number(stats.confirmed_count || 0),
        inferredCount: Number(stats.inferred_count || 0),
        wonCount: Number(stats.won_count),
        winRate: stats.resolved_count > 0
          ? (Number(stats.won_count) / Number(stats.resolved_count) * 100).toFixed(1)
          : null,
      },
      timestamp: new Date().toISOString(),
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      }
    });
  } catch (err) {
    console.error("Error fetching history:", err);
    return NextResponse.json(
      { error: "Failed to fetch history", details: String(err) },
      { status: 500 }
    );
  }
}
