// Minimal test endpoint
import { NextResponse } from "next/server";
import { db } from "@vercel/postgres";

export const dynamic = "force-dynamic";

export async function GET() {
  const client = await db.connect();
  try {
    // Use transaction to ensure we hit the primary
    await client.query('BEGIN');

    const result = await client.query(`
      SELECT
        COUNT(*) as total,
        COUNT(wallet) as with_wallet,
        COUNT(CASE WHEN tier = 'whale' THEN 1 END) as whales,
        COUNT(CASE WHEN tier = 'shark' THEN 1 END) as sharks,
        COUNT(CASE WHEN tier = 'dolphin' THEN 1 END) as dolphins
      FROM whale_watchlist
    `);

    await client.query('COMMIT');

    return NextResponse.json({
      stats: result.rows[0],
      rowCount: result.rowCount,
      success: true,
      version: "v3-transaction"
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return NextResponse.json({
      error: String(err),
      success: false
    }, { status: 500 });
  }
}
