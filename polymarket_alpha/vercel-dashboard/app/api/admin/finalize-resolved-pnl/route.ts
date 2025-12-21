// /app/api/admin/finalize-resolved-pnl/route.ts
// Phase 8: Manual endpoint to finalize P&L for resolved markets
// POST-only, protected by middleware Basic Auth
// Useful for backfill and debugging

import { NextResponse } from 'next/server';
import { finalizeResolvedPnL } from '@/lib/finalize-resolved-pnl';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120; // Allow up to 2 minutes for backfill

// Response headers to prevent caching
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

export async function POST(request: Request) {
  // Auth is handled by middleware (Basic Auth for /api/admin/*)
  const startTime = Date.now();

  try {
    // Parse optional parameters from request body
    let marketLimit = 25;
    let walletConcurrency = 4;

    try {
      const body = await request.json();
      if (body.marketLimit && typeof body.marketLimit === 'number') {
        marketLimit = Math.min(100, Math.max(1, body.marketLimit));
      }
      if (body.walletConcurrency && typeof body.walletConcurrency === 'number') {
        walletConcurrency = Math.min(10, Math.max(1, body.walletConcurrency));
      }
    } catch {
      // No body or invalid JSON, use defaults
    }

    console.log(`[finalize-resolved-pnl] Starting with marketLimit=${marketLimit}, walletConcurrency=${walletConcurrency}`);

    const result = await finalizeResolvedPnL({
      marketLimit,
      walletConcurrency,
    });

    const durationMs = Date.now() - startTime;

    return NextResponse.json({
      success: true,
      ...result,
      durationMs,
      timestamp: new Date().toISOString(),
    }, { headers: NO_CACHE_HEADERS });

  } catch (err) {
    console.error('[finalize-resolved-pnl] Error:', err);
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}

// Only allow POST
export async function GET() {
  return NextResponse.json(
    { error: 'Method not allowed. Use POST.' },
    { status: 405, headers: NO_CACHE_HEADERS }
  );
}
