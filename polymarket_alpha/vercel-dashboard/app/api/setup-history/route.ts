// app/api/setup-history/route.ts
// One-time endpoint to create the longshot_history table
// Delete this file after running once

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    console.log('Creating longshot_history table...');

    await sql`
      CREATE TABLE IF NOT EXISTS longshot_history (
        id TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        name TEXT,
        market_id TEXT NOT NULL,
        event_slug TEXT,
        title TEXT,
        outcome TEXT,
        timestamp BIGINT NOT NULL,
        price DECIMAL(10, 6) NOT NULL,
        size DECIMAL(18, 2) NOT NULL,
        value DECIMAL(18, 2) NOT NULL,
        resolved BOOLEAN DEFAULT FALSE,
        won BOOLEAN,
        pnl DECIMAL(18, 2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    // Index for wallet lookups in history
    await sql`
      CREATE INDEX IF NOT EXISTS idx_longshot_history_wallet ON longshot_history(wallet)
    `;

    // Index for unresolved markets
    await sql`
      CREATE INDEX IF NOT EXISTS idx_longshot_history_resolved ON longshot_history(resolved, market_id)
    `;

    // Index for time-based queries
    await sql`
      CREATE INDEX IF NOT EXISTS idx_longshot_history_timestamp ON longshot_history(timestamp DESC)
    `;

    // Verify
    const result = await sql`SELECT COUNT(*) as count FROM longshot_history`;

    return NextResponse.json({
      success: true,
      message: "longshot_history table created",
      rowCount: result.rows[0].count,
    });
  } catch (err) {
    console.error("Error creating table:", err);
    return NextResponse.json(
      { error: "Failed to create table", details: String(err) },
      { status: 500 }
    );
  }
}
