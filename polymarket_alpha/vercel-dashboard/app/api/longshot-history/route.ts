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
    const result = await sql`
      SELECT
        id,
        wallet,
        name,
        market_id,
        event_slug,
        title,
        outcome,
        timestamp,
        price,
        size,
        value,
        resolved,
        won,
        pnl,
        created_at
      FROM longshot_history
      ORDER BY created_at DESC
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

      // Calculate inferred status based on resolution or price
      let inferredStatus: 'pending' | 'likely_lost' | 'likely_won' = 'pending';
      if (row.resolved) {
        inferredStatus = row.won ? 'likely_won' : 'likely_lost';
      } else if (curPrice >= 0.98) {
        // Price at 98%+ = market effectively settled to YES
        inferredStatus = 'likely_won';
      } else if (entryPrice > 0 && curPrice / entryPrice <= 0.01) {
        // Position value dropped 99%+ from entry = effectively lost
        inferredStatus = 'likely_lost';
      }

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
        createdAt: row.created_at,
        // New fields
        curPrice,
        position,
        potential,
        inferredStatus,
      };
    });

    // Get summary stats
    const statsResult = await sql`
      SELECT
        COUNT(*) as total_trades,
        COUNT(DISTINCT wallet) as unique_wallets,
        SUM(value) as total_value,
        COUNT(CASE WHEN resolved = true THEN 1 END) as resolved_count,
        COUNT(CASE WHEN won = true THEN 1 END) as won_count
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
