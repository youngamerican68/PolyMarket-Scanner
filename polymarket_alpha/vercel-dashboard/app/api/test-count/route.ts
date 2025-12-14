// Minimal test endpoint
import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
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
      success: true
    });
  } catch (err) {
    return NextResponse.json({
      error: String(err),
      success: false
    }, { status: 500 });
  }
}
