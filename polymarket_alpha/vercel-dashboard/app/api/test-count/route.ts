// Minimal test endpoint
import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // First query - SELECT * like seed-whales does
    const warmup = await sql`SELECT * FROM whale_watchlist LIMIT 1`;

    const result = await sql`
      SELECT
        COUNT(*) as total,
        COUNT(wallet) as with_wallet,
        COUNT(CASE WHEN tier = 'whale' THEN 1 END) as whales,
        COUNT(CASE WHEN tier = 'shark' THEN 1 END) as sharks,
        COUNT(CASE WHEN tier = 'dolphin' THEN 1 END) as dolphins
      FROM whale_watchlist
    `;

    return NextResponse.json({
      stats: result.rows[0],
      rowCount: result.rowCount,
      warmupRows: warmup.rowCount,
      success: true,
      version: "v2-warmup"
    });
  } catch (err) {
    return NextResponse.json({
      error: String(err),
      success: false
    }, { status: 500 });
  }
}
