// app/api/backfill-history/route.ts
// One-time endpoint to backfill longshot_history from existing trades
// Delete this file after running once

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    console.log('Backfilling longshot_history from existing trades...');

    // Find all trades with value >= $5000 that aren't in history yet
    const result = await sql`
      INSERT INTO longshot_history (id, wallet, name, market_id, event_slug, title, outcome, timestamp, price, size, value)
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
        (price * size) as value
      FROM trades
      WHERE (price * size) >= 5000
        AND id NOT IN (SELECT id FROM longshot_history)
      ON CONFLICT (id) DO NOTHING
    `;

    const inserted = result.rowCount || 0;

    // Get new total
    const countResult = await sql`SELECT COUNT(*) as count FROM longshot_history`;
    const total = countResult.rows[0].count;

    return NextResponse.json({
      success: true,
      message: "Backfill complete",
      inserted,
      totalHistory: total,
    });
  } catch (err) {
    console.error("Error backfilling:", err);
    return NextResponse.json(
      { error: "Failed to backfill", details: String(err) },
      { status: 500 }
    );
  }
}
