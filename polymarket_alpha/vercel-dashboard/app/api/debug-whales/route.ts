// Debug endpoint to check whale tables
import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Test 1: Count whale_watchlist
    const watchlistCount = await sql`SELECT COUNT(*) as count FROM whale_watchlist`;

    // Test 2: Get first 5 entries
    const watchlistSample = await sql`SELECT * FROM whale_watchlist LIMIT 5`;

    // Test 3: Count whale_trades
    const tradesCount = await sql`SELECT COUNT(*) as count FROM whale_trades`;

    // Test 4: Stats query
    const stats = await sql`
      SELECT
        COUNT(*) as total,
        COUNT(wallet) as with_wallet,
        COUNT(CASE WHEN tier = 'whale' THEN 1 END) as whales,
        COUNT(CASE WHEN tier = 'shark' THEN 1 END) as sharks,
        COUNT(CASE WHEN tier = 'dolphin' THEN 1 END) as dolphins
      FROM whale_watchlist
    `;

    return NextResponse.json({
      watchlistCount: watchlistCount.rows[0],
      watchlistSample: watchlistSample.rows,
      tradesCount: tradesCount.rows[0],
      stats: stats.rows[0],
      success: true
    });
  } catch (err) {
    return NextResponse.json({
      error: String(err),
      stack: err instanceof Error ? err.stack : undefined,
      success: false
    }, { status: 500 });
  }
}
