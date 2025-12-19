// /app/api/ops/health/heartbeat/route.ts
// Heartbeat monitoring endpoint for job health checks
// Protected by OPS_SECRET (Production-only)
// Returns stale status for all monitored jobs

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import {
  verifyOpsSecret,
  MONITORED_JOBS,
  buildJobHealthCheck,
  buildHeartbeatResponse,
  JobHealthCheck,
} from '@/lib/heartbeat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Response headers to prevent caching
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

export async function GET(request: Request) {
  // Auth check using constant-time comparison
  const authHeader = request.headers.get('authorization');
  if (!verifyOpsSecret(authHeader)) {
    // Do not log the actual token to prevent secret leakage
    console.warn('[heartbeat] Unauthorized request');
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: NO_CACHE_HEADERS }
    );
  }

  try {
    const now = new Date();
    const checks: JobHealthCheck[] = [];

    // 48-hour window for checking recent errors
    const errorWindowCutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    for (const config of MONITORED_JOBS) {
      // Get most recent success
      const successResult = await sql<{ finished_at: string }>`
        SELECT finished_at::text
        FROM job_runs
        WHERE job_name = ${config.jobName}
          AND status = 'success'
        ORDER BY finished_at DESC
        LIMIT 1
      `;

      // Get most recent error within 48h window
      const errorResult = await sql<{ finished_at: string }>`
        SELECT finished_at::text
        FROM job_runs
        WHERE job_name = ${config.jobName}
          AND status = 'error'
          AND finished_at >= ${errorWindowCutoff}::timestamptz
        ORDER BY finished_at DESC
        LIMIT 1
      `;

      const lastSuccessAt = successResult.rows[0]?.finished_at
        ? new Date(successResult.rows[0].finished_at)
        : null;

      const lastErrorAt = errorResult.rows[0]?.finished_at
        ? new Date(errorResult.rows[0].finished_at)
        : null;

      checks.push(buildJobHealthCheck(config, lastSuccessAt, lastErrorAt, now));
    }

    const response = buildHeartbeatResponse(checks);

    // Log summary (no secrets)
    console.log(`[heartbeat] ok=${response.ok}, jobs=${checks.length}, stale=${checks.filter(c => c.stale).map(c => c.jobName).join(',') || 'none'}`);

    return NextResponse.json(response, { headers: NO_CACHE_HEADERS });

  } catch (err) {
    console.error('[heartbeat] Error:', err);
    return NextResponse.json(
      { error: 'Internal server error', details: String(err).slice(0, 200) },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}
