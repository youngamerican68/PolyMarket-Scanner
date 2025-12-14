// app/api/test-history/route.ts
// Test endpoint to debug history issue - mimics longshot-history flow

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Step 1: Run the exact same query as longshot-history
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

    // Also try without ORDER BY
    const resultNoOrder = await sql`
      SELECT id, wallet, title, timestamp, value
      FROM longshot_history
      LIMIT 500
    `;

    // And try with just created_at order
    const resultByCreatedAt = await sql`
      SELECT id, wallet, title, timestamp, value
      FROM longshot_history
      ORDER BY created_at DESC
      LIMIT 500
    `;

    const queryRowCount = result.rows.length;
    const firstRow = result.rows[0] || null;
    const lastRow = result.rows[result.rows.length - 1] || null;

    // Step 2: Skip price fetching, just transform the rows
    const trades = result.rows.map((row) => {
      return {
        id: row.id,
        wallet: row.wallet,
        name: row.name || "Anonymous",
        marketId: row.market_id,
        title: row.title,
        outcome: row.outcome,
        timestamp: Number(row.timestamp),
        price: Number(row.price),
        size: Number(row.size),
        value: Number(row.value),
      };
    });

    // Step 3: Get stats separately
    const statsResult = await sql`
      SELECT
        COUNT(*) as total_trades,
        COUNT(DISTINCT wallet) as unique_wallets,
        SUM(value) as total_value
      FROM longshot_history
    `;
    const stats = statsResult.rows[0];

    return NextResponse.json({
      debug: {
        queryRowCount,
        queryNoOrderRowCount: resultNoOrder.rows.length,
        queryByCreatedAtRowCount: resultByCreatedAt.rows.length,
        tradesArrayLength: trades.length,
        firstRow: firstRow ? { id: firstRow.id?.slice(0, 50), title: firstRow.title } : null,
        lastRow: lastRow ? { id: lastRow.id?.slice(0, 50), title: lastRow.title } : null,
        statsFromQuery: {
          totalTrades: stats.total_trades,
          uniqueWallets: stats.unique_wallets,
          totalValue: stats.total_value,
        },
        noOrderFirstRows: resultNoOrder.rows.slice(0, 3).map(r => ({ id: r.id?.slice(0, 30), title: r.title?.slice(0, 30) })),
        byCreatedAtFirstRows: resultByCreatedAt.rows.slice(0, 3).map(r => ({ id: r.id?.slice(0, 30), title: r.title?.slice(0, 30) })),
      },
      tradesCount: trades.length,
      trades: trades.slice(0, 10), // Only return first 10 to keep response small
    });
  } catch (err) {
    console.error("Test error:", err);
    return NextResponse.json(
      { error: "Test failed", details: String(err) },
      { status: 500 }
    );
  }
}
