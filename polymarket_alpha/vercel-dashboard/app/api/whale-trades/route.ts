// app/api/whale-trades/route.ts
// Returns longshot trades from whale watchlist wallets

import { NextResponse } from "next/server";
import { sql, db } from "@vercel/postgres";

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

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const tier = searchParams.get("tier"); // whale, shark, dolphin
    const category = searchParams.get("category"); // sports, crypto, etc.
    const limit = Math.min(Number(searchParams.get("limit")) || 100, 500);

    // Use db.connect() with transaction to force primary database read
    // The sql template tag uses read replicas which have stale data
    const client = await db.connect();
    let watchlistStats;
    try {
      await client.query('BEGIN');
      const watchlistStatsResult = await client.query(`
        SELECT
          COUNT(*) as total_watchlist,
          COUNT(wallet) as with_wallet,
          COUNT(*) - COUNT(wallet) as pending_wallet,
          COUNT(CASE WHEN tier = 'whale' THEN 1 END) as whales,
          COUNT(CASE WHEN tier = 'shark' THEN 1 END) as sharks,
          COUNT(CASE WHEN tier = 'dolphin' THEN 1 END) as dolphins
        FROM whale_watchlist
      `);
      await client.query('COMMIT');
      watchlistStats = watchlistStatsResult.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    console.log("TRANSACTION watchlistStats:", JSON.stringify(watchlistStats));

    // Build query based on filters
    let result;
    if (tier && category) {
      result = await sql`
        SELECT
          wt.id,
          wt.wallet,
          wt.name,
          wt.whale_tier,
          wt.whale_category,
          wt.market_id,
          wt.event_slug,
          wt.title,
          wt.outcome,
          wt.timestamp,
          wt.price,
          wt.size,
          wt.value,
          wt.created_at,
          ww.profit as whale_profit
        FROM whale_trades wt
        LEFT JOIN whale_watchlist ww ON wt.wallet = ww.wallet
        WHERE wt.whale_tier = ${tier} AND wt.whale_category = ${category}
        ORDER BY wt.created_at DESC
        LIMIT ${limit}
      `;
    } else if (tier) {
      result = await sql`
        SELECT
          wt.id,
          wt.wallet,
          wt.name,
          wt.whale_tier,
          wt.whale_category,
          wt.market_id,
          wt.event_slug,
          wt.title,
          wt.outcome,
          wt.timestamp,
          wt.price,
          wt.size,
          wt.value,
          wt.created_at,
          ww.profit as whale_profit
        FROM whale_trades wt
        LEFT JOIN whale_watchlist ww ON wt.wallet = ww.wallet
        WHERE wt.whale_tier = ${tier}
        ORDER BY wt.created_at DESC
        LIMIT ${limit}
      `;
    } else if (category) {
      result = await sql`
        SELECT
          wt.id,
          wt.wallet,
          wt.name,
          wt.whale_tier,
          wt.whale_category,
          wt.market_id,
          wt.event_slug,
          wt.title,
          wt.outcome,
          wt.timestamp,
          wt.price,
          wt.size,
          wt.value,
          wt.created_at,
          ww.profit as whale_profit
        FROM whale_trades wt
        LEFT JOIN whale_watchlist ww ON wt.wallet = ww.wallet
        WHERE wt.whale_category = ${category}
        ORDER BY wt.created_at DESC
        LIMIT ${limit}
      `;
    } else {
      result = await sql`
        SELECT
          wt.id,
          wt.wallet,
          wt.name,
          wt.whale_tier,
          wt.whale_category,
          wt.market_id,
          wt.event_slug,
          wt.title,
          wt.outcome,
          wt.timestamp,
          wt.price,
          wt.size,
          wt.value,
          wt.created_at,
          ww.profit as whale_profit
        FROM whale_trades wt
        LEFT JOIN whale_watchlist ww ON wt.wallet = ww.wallet
        ORDER BY wt.created_at DESC
        LIMIT ${limit}
      `;
    }

    // Get unique market IDs and fetch current prices (limit to 30 markets)
    const uniqueMarkets = Array.from(new Set(result.rows.map(r => r.market_id))).slice(0, 30);
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

    // Format trades with current prices
    const trades = result.rows.map((row) => {
      const entryPrice = Number(row.price);
      const size = Number(row.size);
      const marketId = row.market_id;
      const outcome = row.outcome;

      // Get current price from cached market prices
      const prices = marketPrices.get(marketId);
      const curPrice = prices?.get(outcome) ?? 0;

      // Calculate position and potential
      const position = size * curPrice;
      const potential = size;

      // Calculate P/L percentage
      const plPercent = entryPrice > 0 ? ((curPrice - entryPrice) / entryPrice) * 100 : 0;

      return {
        id: row.id,
        wallet: row.wallet,
        name: row.name,
        tier: row.whale_tier,
        category: row.whale_category,
        profit: row.whale_profit,
        marketId,
        eventSlug: row.event_slug,
        title: row.title,
        outcome,
        timestamp: Number(row.timestamp),
        entryPrice,
        curPrice,
        size,
        value: Number(row.value),
        position,
        potential,
        plPercent,
        createdAt: row.created_at,
      };
    });

    // Get stats
    const statsResult = await sql`
      SELECT
        COUNT(*) as total_trades,
        COUNT(DISTINCT wallet) as unique_whales,
        SUM(value) as total_value,
        COUNT(CASE WHEN whale_tier = 'whale' THEN 1 END) as whale_trades,
        COUNT(CASE WHEN whale_tier = 'shark' THEN 1 END) as shark_trades,
        COUNT(CASE WHEN whale_tier = 'dolphin' THEN 1 END) as dolphin_trades
      FROM whale_trades
    `;

    const stats = statsResult.rows[0];
    // watchlistStats already queried at start of function

    return NextResponse.json({
      trades,
      stats: {
        totalTrades: Number(stats.total_trades),
        uniqueWhales: Number(stats.unique_whales),
        totalValue: Number(stats.total_value || 0),
        whaleTrades: Number(stats.whale_trades),
        sharkTrades: Number(stats.shark_trades),
        dolphinTrades: Number(stats.dolphin_trades),
      },
      watchlist: {
        total: Number(watchlistStats.total_watchlist),
        withWallet: Number(watchlistStats.with_wallet),
        pendingWallet: Number(watchlistStats.pending_wallet),
        whales: Number(watchlistStats.whales),
        sharks: Number(watchlistStats.sharks),
        dolphins: Number(watchlistStats.dolphins),
      },
      filters: { tier, category },
      timestamp: new Date().toISOString(),
      _apiVersion: "v6-transaction",
      _rawTotal: watchlistStats.total_watchlist,
    }, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
      },
    });
  } catch (err) {
    console.error("Error fetching whale trades:", err);
    return NextResponse.json(
      { error: "Failed to fetch whale trades", details: String(err) },
      { status: 500 }
    );
  }
}
// redeploy Sun Dec 14 15:07:00 EST 2025
