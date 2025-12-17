// /app/api/health/route.ts
// Lightweight health check endpoint with last successful ingestion marker

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const dynamic = 'force-dynamic';

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  database: {
    connected: boolean;
    error?: string;
  };
  ingestion: {
    lastAlertAt: string | null;
    lastAlertAgeMinutes: number | null;
    alertsLast24h: number;
    alertsLastHour: number;
    isStale: boolean;
  };
  checks: {
    dbConnection: boolean;
    recentIngestion: boolean;
  };
}

export async function GET() {
  const health: HealthStatus = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    database: {
      connected: false,
    },
    ingestion: {
      lastAlertAt: null,
      lastAlertAgeMinutes: null,
      alertsLast24h: 0,
      alertsLastHour: 0,
      isStale: true,
    },
    checks: {
      dbConnection: false,
      recentIngestion: false,
    },
  };

  try {
    // Check database connection and get ingestion stats
    const result = await sql`
      SELECT
        MAX(created_at) as last_alert_at,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') as alerts_24h,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 hour') as alerts_1h
      FROM alert_events
    `;

    health.database.connected = true;
    health.checks.dbConnection = true;

    const row = result.rows[0];
    const lastAlertAt = row.last_alert_at ? new Date(row.last_alert_at) : null;
    const now = new Date();

    health.ingestion.lastAlertAt = lastAlertAt?.toISOString() || null;
    health.ingestion.alertsLast24h = Number(row.alerts_24h);
    health.ingestion.alertsLastHour = Number(row.alerts_1h);

    if (lastAlertAt) {
      const ageMs = now.getTime() - lastAlertAt.getTime();
      health.ingestion.lastAlertAgeMinutes = Math.round(ageMs / 60000);

      // Consider "stale" if no new alerts in 30 minutes
      // (cron runs every 5 minutes, so 30 min gap is concerning)
      health.ingestion.isStale = ageMs > 30 * 60 * 1000;
      health.checks.recentIngestion = !health.ingestion.isStale;
    }

    // Determine overall status
    if (!health.checks.dbConnection) {
      health.status = 'unhealthy';
    } else if (health.ingestion.isStale) {
      health.status = 'degraded';
    } else {
      health.status = 'healthy';
    }
  } catch (err) {
    health.database.connected = false;
    health.database.error = err instanceof Error ? err.message : String(err);
    health.status = 'unhealthy';
  }

  const statusCode = health.status === 'unhealthy' ? 503 : 200;

  return NextResponse.json(health, {
    status: statusCode,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
