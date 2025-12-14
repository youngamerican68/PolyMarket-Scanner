// app/api/debug-wallet/route.ts
// Debug endpoint to check specific wallet data

import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet") || "0xa103eee98ac104a676c202d7afe5e859881c255c";

  try {
    // Check trades table
    const tradesResult = await sql`
      SELECT id, wallet, title, outcome, market_id, timestamp, price, size, (price * size) as value
      FROM trades
      WHERE LOWER(wallet) = LOWER(${wallet})
      ORDER BY timestamp DESC
      LIMIT 50
    `;

    // Check history table
    const historyResult = await sql`
      SELECT id, wallet, title, outcome, market_id, timestamp, price, size, value
      FROM longshot_history
      WHERE LOWER(wallet) = LOWER(${wallet})
      ORDER BY timestamp DESC
      LIMIT 20
    `;

    // Check for XRP specifically
    const xrpHistory = await sql`
      SELECT id, title, outcome, price, size, value, market_id
      FROM longshot_history
      WHERE LOWER(wallet) = LOWER(${wallet})
      AND title LIKE '%XRP%'
    `;

    return NextResponse.json({
      wallet,
      tradesCount: tradesResult.rows.length,
      trades: tradesResult.rows.slice(0, 20).map(r => ({
        title: r.title?.slice(0, 40),
        outcome: r.outcome,
        price: r.price,
        size: r.size,
        value: r.value,
        market_id: r.market_id?.slice(0, 20),
      })),
      historyCount: historyResult.rows.length,
      history: historyResult.rows.map(r => ({
        title: r.title?.slice(0, 40),
        outcome: r.outcome,
        price: r.price,
        size: r.size,
        value: r.value,
        market_id: r.market_id?.slice(0, 20),
      })),
      xrpHistory: xrpHistory.rows.map(r => ({
        title: r.title,
        outcome: r.outcome,
        price: r.price,
        size: r.size,
        value: r.value,
        market_id: r.market_id,
      })),
    });
  } catch (err) {
    console.error("Debug error:", err);
    return NextResponse.json(
      { error: "Debug failed", details: String(err) },
      { status: 500 }
    );
  }
}
