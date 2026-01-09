// /lib/heartbeat.ts
// Heartbeat monitoring logic for job health checks
// Provides deterministic stale detection for scheduled jobs

import { constantTimeCompare } from './anomaly-config';

// =========================================================================
// Job Configuration
// =========================================================================

export interface JobConfig {
  jobName: string;
  scheduleMinutes: number;
}

// Jobs to monitor - add new jobs here as they're implemented
// Only include jobs that exist in the codebase
// Note: Heartbeat is informational only - it never gates job execution
// Stale threshold = 2 * scheduleMinutes
export const MONITORED_JOBS: JobConfig[] = [
  { jobName: 'collect-trades', scheduleMinutes: 5 },       // every 5 min (stale after 10 min)
  { jobName: 'refresh-prices', scheduleMinutes: 10 },      // every 10 min (stale after 20 min)
  { jobName: 'sync-positions', scheduleMinutes: 15 },      // every 15 min (stale after 30 min)
  { jobName: 'scan-positions', scheduleMinutes: 30 },      // every 30 min (stale after 60 min)
  { jobName: 'refresh-baselines', scheduleMinutes: 1440 }, // daily (stale after 48h)
];

// =========================================================================
// Health Check Types
// =========================================================================

export interface JobHealthCheck {
  jobName: string;
  scheduleMinutes: number;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  stale: boolean;
  message: string;
}

export interface HeartbeatResponse {
  ok: boolean;
  generatedAt: string;
  checks: JobHealthCheck[];
}

// =========================================================================
// Auth
// =========================================================================

/**
 * Verify OPS_SECRET from Authorization header
 * Uses constant-time comparison to prevent timing attacks
 * Returns true if valid, false if invalid or missing
 */
export function verifyOpsSecret(authHeader: string | null): boolean {
  const opsSecret = process.env.OPS_SECRET;

  // If OPS_SECRET is not configured, deny access
  if (!opsSecret) {
    console.warn('[heartbeat] OPS_SECRET not configured - denying access');
    return false;
  }

  // Check for Bearer token
  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice(7);
  return constantTimeCompare(token, opsSecret);
}

// =========================================================================
// Stale Detection Logic
// =========================================================================

/**
 * Determine if a job is stale based on its last success time
 * A job is stale if:
 * - lastSuccessAt is null (never succeeded), OR
 * - lastSuccessAt is older than 2 * scheduleMinutes
 */
export function isJobStale(
  lastSuccessAt: Date | null,
  scheduleMinutes: number,
  now: Date = new Date()
): boolean {
  if (!lastSuccessAt) {
    return true;
  }

  const staleThresholdMs = scheduleMinutes * 2 * 60 * 1000;
  const timeSinceSuccess = now.getTime() - lastSuccessAt.getTime();

  return timeSinceSuccess > staleThresholdMs;
}

/**
 * Generate a human-readable message for a job's health status
 */
export function generateHealthMessage(
  lastSuccessAt: Date | null,
  stale: boolean,
  scheduleMinutes: number,
  now: Date = new Date()
): string {
  if (!lastSuccessAt) {
    return 'STALE: no successful run recorded';
  }

  const timeSinceSuccess = now.getTime() - lastSuccessAt.getTime();
  const hoursAgo = Math.round(timeSinceSuccess / (60 * 60 * 1000));
  const minutesAgo = Math.round(timeSinceSuccess / (60 * 1000));

  let timeStr: string;
  if (hoursAgo >= 1) {
    timeStr = `${hoursAgo}h ago`;
  } else {
    timeStr = `${minutesAgo}m ago`;
  }

  if (stale) {
    const expectedHours = Math.round(scheduleMinutes * 2 / 60);
    return `STALE: last success ${timeStr} (expected within ${expectedHours}h)`;
  }

  return `OK: last success ${timeStr}`;
}

/**
 * Build a JobHealthCheck from raw data
 */
export function buildJobHealthCheck(
  config: JobConfig,
  lastSuccessAt: Date | null,
  lastErrorAt: Date | null,
  now: Date = new Date()
): JobHealthCheck {
  const stale = isJobStale(lastSuccessAt, config.scheduleMinutes, now);
  const message = generateHealthMessage(lastSuccessAt, stale, config.scheduleMinutes, now);

  return {
    jobName: config.jobName,
    scheduleMinutes: config.scheduleMinutes,
    lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
    lastErrorAt: lastErrorAt?.toISOString() ?? null,
    stale,
    message,
  };
}

/**
 * Build the full heartbeat response from an array of job checks
 */
export function buildHeartbeatResponse(checks: JobHealthCheck[]): HeartbeatResponse {
  const ok = checks.every(check => !check.stale);

  return {
    ok,
    generatedAt: new Date().toISOString(),
    checks,
  };
}
