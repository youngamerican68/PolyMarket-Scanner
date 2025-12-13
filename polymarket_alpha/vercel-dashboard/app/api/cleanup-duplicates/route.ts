// app/api/cleanup-duplicates/route.ts
// One-time cleanup to remove duplicate entries from longshot_history
// Run once then delete this file

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    console.log("Starting duplicate cleanup...");

    // Step 1: Find all unique positions (wallet + market_id + outcome)
    // Keep only the one with the highest value (most accurate aggregation)
    const dedupeResult = await sql`
      WITH ranked AS (
        SELECT
          id,
          wallet,
          market_id,
          outcome,
          value,
          ROW_NUMBER() OVER (
            PARTITION BY wallet, market_id, outcome
            ORDER BY value DESC, timestamp DESC
          ) as rn
        FROM longshot_history
      ),
      to_delete AS (
        SELECT id FROM ranked WHERE rn > 1
      )
      DELETE FROM longshot_history
      WHERE id IN (SELECT id FROM to_delete)
      RETURNING id
    `;

    const deletedCount = dedupeResult.rowCount || 0;
    console.log(`Deleted ${deletedCount} duplicate entries`);

    // Step 2: Get remaining count
    const countResult = await sql`SELECT COUNT(*) as count FROM longshot_history`;
    const remaining = countResult.rows[0].count;

    // Step 3: Show what's left
    const sampleResult = await sql`
      SELECT name, title, outcome, value, timestamp
      FROM longshot_history
      ORDER BY timestamp DESC
      LIMIT 20
    `;

    return NextResponse.json({
      success: true,
      duplicatesDeleted: deletedCount,
      remainingEntries: remaining,
      sample: sampleResult.rows.map(r => ({
        name: r.name,
        title: r.title?.slice(0, 40),
        outcome: r.outcome,
        value: `$${Number(r.value).toFixed(0)}`,
      })),
    });
  } catch (err) {
    console.error("Error in cleanup:", err);
    return NextResponse.json(
      { error: "Failed to cleanup", details: String(err) },
      { status: 500 }
    );
  }
}
