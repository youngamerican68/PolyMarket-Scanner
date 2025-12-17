// app/api/suspicious/route.ts
// DEPRECATED in Phase 1: This endpoint is being replaced by alert_events-based queries
// Kept for backwards compatibility but returns empty results

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // Return deprecation notice with empty results
  return NextResponse.json({
    deprecated: true,
    message: 'This endpoint is deprecated in Phase 1. Use /api/daily-report instead.',
    timestamp: new Date().toISOString(),
    window: {
      from: new Date().toISOString(),
      to: new Date().toISOString(),
      minutes: 60,
    },
    stats: {
      totalTrades: 0,
      longshotTrades: 0,
      uniqueWallets: 0,
    },
    suspiciousTraders: [],
    recentLongshots: [],
  });
}
