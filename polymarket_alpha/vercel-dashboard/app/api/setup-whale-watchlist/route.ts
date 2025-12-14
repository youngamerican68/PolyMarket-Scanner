// app/api/setup-whale-watchlist/route.ts
// One-time setup to create whale watchlist tables

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Create whale_watchlist table
    await sql`
      CREATE TABLE IF NOT EXISTS whale_watchlist (
        id SERIAL PRIMARY KEY,
        wallet TEXT,
        name TEXT NOT NULL,
        tier TEXT,
        category TEXT,
        profit TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(name)
      )
    `;

    // Create indexes
    await sql`
      CREATE INDEX IF NOT EXISTS idx_whale_wallet ON whale_watchlist(wallet)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_whale_name ON whale_watchlist(name)
    `;

    // Create whale_trades table
    await sql`
      CREATE TABLE IF NOT EXISTS whale_trades (
        id TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        name TEXT,
        whale_tier TEXT,
        whale_category TEXT,
        market_id TEXT,
        event_slug TEXT,
        title TEXT,
        outcome TEXT,
        timestamp BIGINT,
        price NUMERIC,
        size NUMERIC,
        value NUMERIC,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Create index on whale_trades
    await sql`
      CREATE INDEX IF NOT EXISTS idx_whale_trades_wallet ON whale_trades(wallet)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_whale_trades_created ON whale_trades(created_at DESC)
    `;

    // Get table info
    const watchlistCount = await sql`SELECT COUNT(*) as count FROM whale_watchlist`;
    const tradesCount = await sql`SELECT COUNT(*) as count FROM whale_trades`;

    return NextResponse.json({
      success: true,
      message: "Whale watchlist tables created successfully",
      watchlistCount: Number(watchlistCount.rows[0].count),
      tradesCount: Number(tradesCount.rows[0].count),
    });
  } catch (err) {
    console.error("Error setting up whale tables:", err);
    return NextResponse.json(
      { error: "Failed to setup tables", details: String(err) },
      { status: 500 }
    );
  }
}
