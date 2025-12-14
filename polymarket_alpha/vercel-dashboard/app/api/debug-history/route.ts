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

    // 3. Get sample rows - raw query with all fields to see data
    const sampleRows = await sql`
      SELECT id, wallet, title, timestamp, price, size, value, outcome, market_id
      FROM longshot_history
      ORDER BY timestamp DESC
      LIMIT 20
    `;

    // 4. Check for NULL or weird timestamp values
    const timestampCheck = await sql`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN timestamp IS NULL THEN 1 END) as null_timestamps,
        COUNT(CASE WHEN timestamp = 0 THEN 1 END) as zero_timestamps,
        MIN(timestamp) as min_ts,
        MAX(timestamp) as max_ts
      FROM longshot_history
    `;

    // 5. Check for duplicate IDs or any constraint issues
    const duplicateCheck = await sql`
      SELECT id, COUNT(*) as cnt
      FROM longshot_history
      GROUP BY id
      HAVING COUNT(*) > 1
      LIMIT 10
    `;

    // 6. Check unique market_id count
    const marketCount = await sql`
      SELECT COUNT(DISTINCT market_id) as unique_markets FROM longshot_history
    `;

    // 7. Get distribution by value range
    const valueDistribution = await sql`
      SELECT
        CASE
          WHEN value < 5000 THEN '<5K'
          WHEN value < 10000 THEN '5K-10K'
          WHEN value < 50000 THEN '10K-50K'
          ELSE '50K+'
        END as range,
        COUNT(*) as cnt
      FROM longshot_history
      GROUP BY 1
      ORDER BY MIN(value)
    `;

    // 8. Raw row count from result object
    const rawQuery = await sql`SELECT * FROM longshot_history ORDER BY timestamp DESC LIMIT 500`;

    return NextResponse.json({
      tableSchema: tableCheck.rows,
      rowCount: countResult.rows[0]?.cnt,
      rawQueryRowCount: rawQuery.rows.length,
      rawQueryFields: rawQuery.fields?.map(f => f.name),
      sampleRows: sampleRows.rows,
      timestampCheck: timestampCheck.rows[0],
      duplicates: duplicateCheck.rows,
      uniqueMarkets: marketCount.rows[0]?.unique_markets,
      valueDistribution: valueDistribution.rows,
    });
  } catch (err) {
    console.error("Debug error:", err);
    return NextResponse.json(
      { error: "Debug failed", details: String(err) },
      { status: 500 }
    );
  }
}
