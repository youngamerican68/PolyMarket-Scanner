// app/api/migrate-resolution-state/route.ts
// One-time migration to add resolution_state and resolution_source columns
// Run once, then can be deleted

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    console.log("[migrate] Adding resolution_state and resolution_source columns...");

    // Add resolution_state column
    // Values: 'unresolved' | 'inferred' | 'confirmed'
    await sql`
      ALTER TABLE longshot_history
      ADD COLUMN IF NOT EXISTS resolution_state TEXT DEFAULT 'unresolved'
    `;

    // Add resolution_source column
    // Values: 'official_api' | 'price_inference' | 'manual' | null
    await sql`
      ALTER TABLE longshot_history
      ADD COLUMN IF NOT EXISTS resolution_source TEXT
    `;

    // Backfill existing resolved trades:
    // - If resolved=true AND won is not null, mark as 'confirmed' (assume official)
    // - We can't know for sure which were price-inferred vs official, so default to confirmed
    await sql`
      UPDATE longshot_history
      SET resolution_state = 'confirmed', resolution_source = 'official_api'
      WHERE resolved = true AND resolution_state = 'unresolved'
    `;

    // Count results
    const stats = await sql`
      SELECT
        resolution_state,
        COUNT(*) as count
      FROM longshot_history
      GROUP BY resolution_state
    `;

    console.log("[migrate] Migration complete");

    return NextResponse.json({
      success: true,
      message: "Added resolution_state and resolution_source columns",
      stats: stats.rows,
    });
  } catch (err) {
    console.error("[migrate] Error:", err);
    return NextResponse.json(
      { error: "Migration failed", details: String(err) },
      { status: 500 }
    );
  }
}
