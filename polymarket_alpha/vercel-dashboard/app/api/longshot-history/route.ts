// app/api/longshot-history/route.ts
// Returns all historical longshot trades (permanent, never pruned)

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Fetch all historical longshot trades, newest first
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
      ORDER BY timestamp DESC
      LIMIT 500
    `;

    const trades = result.rows.map((row) => ({
      id: row.id,
      wallet: row.wallet,
      name: row.name || "Anonymous",
      marketId: row.market_id,
      eventSlug: row.event_slug,
      title: row.title,
      outcome: row.outcome,
      timestamp: Number(row.timestamp),
      price: Number(row.price),
      size: Number(row.size),
      value: Number(row.value),
      resolved: row.resolved,
      won: row.won,
      pnl: row.pnl ? Number(row.pnl) : null,
      createdAt: row.created_at,
    }));

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
