// app/api/debug-history/route.ts
// Debug endpoint to diagnose history table issues

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // 1. Check if table exists and get its structure
    const tableCheck = await sql`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'longshot_history'
      ORDER BY ordinal_position
    `;

    // 2. Count rows directly
    const countResult = await sql`SELECT COUNT(*) as cnt FROM longshot_history`;

    // 3. Get sample rows
    const sampleRows = await sql`SELECT id, wallet, title, value FROM longshot_history LIMIT 10`;

    // 4. Check trades table for qualifying trades
    const qualifyingTrades = await sql`
      SELECT COUNT(*) as cnt FROM trades WHERE (price * size) >= 5000
    `;

    // 5. Try direct insert and see what happens
    const testId = `test-${Date.now()}`;
    let insertResult = null;
    let insertError = null;
    try {
      const res = await sql`
        INSERT INTO longshot_history (id, wallet, name, market_id, event_slug, title, outcome, timestamp, price, size, value)
        VALUES (${testId}, 'test', 'test', 'test', 'test', 'test', 'test', ${Math.floor(Date.now()/1000)}, 0.1, 100000, 10000)
        RETURNING id
      `;
      insertResult = res.rows;

      // Delete the test row
      await sql`DELETE FROM longshot_history WHERE id = ${testId}`;
    } catch (e) {
      insertError = String(e);
    }

    // 6. Final count after test
    const finalCount = await sql`SELECT COUNT(*) as cnt FROM longshot_history`;

    return NextResponse.json({
      tableSchema: tableCheck.rows,
      rowCount: countResult.rows[0]?.cnt,
      sampleRows: sampleRows.rows,
      qualifyingTradesInTradesTable: qualifyingTrades.rows[0]?.cnt,
      testInsert: {
        result: insertResult,
        error: insertError
      },
      finalCount: finalCount.rows[0]?.cnt,
    });
  } catch (err) {
    console.error("Debug error:", err);
    return NextResponse.json(
      { error: "Debug failed", details: String(err) },
      { status: 500 }
    );
  }
}
