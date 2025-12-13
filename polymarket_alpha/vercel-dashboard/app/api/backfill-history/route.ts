// app/api/backfill-history/route.ts
// One-time endpoint to backfill longshot_history from existing trades
// Delete this file after running once

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    console.log('Backfilling longshot_history from existing trades...');

    // Get qualifying trades from the trades table
    const tradesResult = await sql`
      SELECT id, wallet, name, market_id, event_slug, title, outcome, timestamp, price, size
      FROM trades
      WHERE (price * size) >= 5000
    `;

    console.log(`Found ${tradesResult.rows.length} qualifying trades`);

    let inserted = 0;
    for (const t of tradesResult.rows) {
      try {
        const value = Number(t.price) * Number(t.size);
        const result = await sql`
          INSERT INTO longshot_history (id, wallet, name, market_id, event_slug, title, outcome, timestamp, price, size, value)
          VALUES (
            ${t.id},
            ${t.wallet},
            ${t.name},
            ${t.market_id},
            ${t.event_slug},
            ${t.title},
            ${t.outcome},
            ${t.timestamp},
            ${t.price},
            ${t.size},
            ${value}
          )
          ON CONFLICT (id) DO NOTHING
        `;
        if (result.rowCount && result.rowCount > 0) {
          inserted++;
        }
      } catch (e) {
        console.error(`Error inserting trade ${t.id}:`, e);
      }
    }

    // Get new total
    const countResult = await sql`SELECT COUNT(*) as count FROM longshot_history`;
    const total = countResult.rows[0].count;

    return NextResponse.json({
      success: true,
      message: "Backfill complete",
      qualifyingTrades: tradesResult.rows.length,
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
