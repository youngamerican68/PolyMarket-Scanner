import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const result = await sql`
    SELECT
      COUNT(*) FILTER (WHERE fill_price <= 0.10) as at_10pct,
      COUNT(*) FILTER (WHERE fill_price <= 0.15) as at_15pct,
      COUNT(*) FILTER (WHERE fill_price <= 0.25) as at_25pct,
      COUNT(*) as total
    FROM alert_events
    WHERE side = 'BUY'
      AND fill_timestamp >= NOW() - INTERVAL '1 day'
  `;

  // Also check with position value filter
  const withPosition = await sql`
    SELECT
      COUNT(*) FILTER (WHERE fill_price <= 0.10) as at_10pct,
      COUNT(*) FILTER (WHERE fill_price <= 0.15) as at_15pct,
      COUNT(*) FILTER (WHERE fill_price <= 0.25) as at_25pct,
      COUNT(*) as total
    FROM alert_events
    WHERE side = 'BUY'
      AND fill_timestamp >= NOW() - INTERVAL '1 day'
      AND position_current_value >= 500
  `;

  return NextResponse.json({
    all_trades: result.rows[0],
    with_500_min: withPosition.rows[0]
  });
}
