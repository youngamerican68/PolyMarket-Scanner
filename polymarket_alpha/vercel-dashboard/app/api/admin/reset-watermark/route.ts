// /app/api/admin/reset-watermark/route.ts
// One-time test endpoint to reset watermark for pagination testing
// DELETE THIS AFTER TESTING

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { isCronAuthed, cronUnauthorized } from '@/lib/cronAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isCronAuthed(request)) {
    return cronUnauthorized();
  }

  try {
    const body = await request.json().catch(() => ({}));
    const hoursBack = body.hoursBack ?? 6;

    // Get current watermark
    const before = await sql`
      SELECT last_timestamp, last_trade_dedupe_id, updated_at
      FROM trade_ingest_watermark
      WHERE id = 'default'
    `;

    // Calculate new timestamp (hoursBack hours ago)
    const newTimestamp = Math.floor(Date.now() / 1000) - (hoursBack * 60 * 60);

    // Update watermark
    await sql`
      UPDATE trade_ingest_watermark
      SET last_timestamp = ${newTimestamp},
          last_trade_dedupe_id = '',
          updated_at = NOW()
      WHERE id = 'default'
    `;

    // Get updated watermark
    const after = await sql`
      SELECT last_timestamp, last_trade_dedupe_id, updated_at
      FROM trade_ingest_watermark
      WHERE id = 'default'
    `;

    return NextResponse.json({
      success: true,
      hoursBack,
      before: before.rows[0],
      after: after.rows[0],
      message: `Watermark reset to ${hoursBack} hours ago. Run collect-trades to test pagination.`
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
