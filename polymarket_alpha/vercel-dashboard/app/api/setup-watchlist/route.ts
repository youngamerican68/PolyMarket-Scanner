// One-time setup for watchlist table
import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS radar_watchlist (
        id SERIAL PRIMARY KEY,
        wallet TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        title TEXT,
        fill_price NUMERIC,
        position_cost NUMERIC,
        potential_payout NUMERIC,
        insider_score INTEGER,
        notes TEXT,
        saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        resolution_outcome TEXT,
        UNIQUE (wallet, condition_id, outcome)
      )
    `;

    await sql`CREATE INDEX IF NOT EXISTS idx_radar_watchlist_saved_at ON radar_watchlist (saved_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_radar_watchlist_condition ON radar_watchlist (condition_id)`;

    return NextResponse.json({ success: true, message: 'Watchlist table created' });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
