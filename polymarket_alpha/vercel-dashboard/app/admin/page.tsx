// /app/admin/page.tsx
// Phase 4: Admin dashboard for job monitoring (hardened)
// Server component - queries job_runs directly
// Includes freshness warnings and manual refresh trigger

import { sql } from '@vercel/postgres';
import Link from 'next/link';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Staleness threshold in minutes
const STALE_THRESHOLD_MINUTES = 30;

// Types for job_runs table
interface JobRun {
  id: string;
  job_name: string;
  status: 'running' | 'success' | 'error';
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  metrics: Record<string, number | string> | null;
  error: string | null;
}

interface LatestJobRun {
  job_name: string;
  status: 'running' | 'success' | 'error';
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  last_success_at: string | null;
  last_error_at: string | null;
  error: string | null;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatTimeAgo(timestamp: string | null): string {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  const days = Math.floor(diffHours / 24);
  return `${days}d ago`;
}

function formatTime(timestamp: string | null): string {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    running: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
    success: 'bg-green-500/20 text-green-400 border-green-500/50',
    error: 'bg-red-500/20 text-red-400 border-red-500/50',
  };
  const colorClass = colors[status] || 'bg-gray-500/20 text-gray-400 border-gray-500/50';

  return (
    <span className={`px-2 py-0.5 text-xs font-medium rounded border ${colorClass}`}>
      {status}
    </span>
  );
}

function MetricsDisplay({ metrics }: { metrics: Record<string, number | string> | null }) {
  if (!metrics || Object.keys(metrics).length === 0) {
    return <span className="text-poly-muted">-</span>;
  }

  const entries = Object.entries(metrics);
  const display = entries
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  return (
    <span className="text-xs text-poly-muted" title={JSON.stringify(metrics, null, 2)}>
      {display}
      {entries.length > 4 && ` +${entries.length - 4} more`}
    </span>
  );
}

// Freshness warning banner component
function FreshnessWarning({
  lastSuccessAt,
  neverRan
}: {
  lastSuccessAt: string | null;
  neverRan: boolean;
}) {
  if (neverRan) {
    return (
      <div className="bg-red-900/30 border border-red-500/50 rounded-lg p-4 flex items-center gap-3">
        <span className="text-2xl">⚠️</span>
        <div>
          <p className="font-medium text-red-400">No successful price refresh recorded</p>
          <p className="text-sm text-poly-muted">Price cache may be empty or stale. Run a manual refresh or check cron configuration.</p>
        </div>
      </div>
    );
  }

  if (!lastSuccessAt) return null;

  const lastSuccess = new Date(lastSuccessAt);
  const now = new Date();
  const ageMinutes = Math.floor((now.getTime() - lastSuccess.getTime()) / (1000 * 60));

  if (ageMinutes > STALE_THRESHOLD_MINUTES) {
    return (
      <div className="bg-yellow-900/30 border border-yellow-500/50 rounded-lg p-4 flex items-center gap-3">
        <span className="text-2xl">⚠️</span>
        <div>
          <p className="font-medium text-yellow-400">Price data is stale</p>
          <p className="text-sm text-poly-muted">
            Last successful refresh was {formatTimeAgo(lastSuccessAt)} ({ageMinutes} minutes ago).
            Threshold is {STALE_THRESHOLD_MINUTES} minutes.
          </p>
        </div>
      </div>
    );
  }

  return null;
}

// Manual refresh form (uses form POST which works with Basic Auth)
function RefreshButton() {
  return (
    <form action="/api/jobs/refresh-prices" method="POST" className="inline">
      <button
        type="submit"
        className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white font-medium rounded transition-colors"
      >
        Run Refresh Now
      </button>
    </form>
  );
}

export default async function AdminPage() {
  // Query latest run per job
  const latestRunsResult = await sql<LatestJobRun>`
    WITH latest AS (
      SELECT DISTINCT ON (job_name)
        job_name, status, started_at, finished_at, duration_ms, error
      FROM job_runs
      ORDER BY job_name, started_at DESC
    ),
    last_success AS (
      SELECT DISTINCT ON (job_name)
        job_name, started_at as last_success_at
      FROM job_runs
      WHERE status = 'success'
      ORDER BY job_name, started_at DESC
    ),
    last_error AS (
      SELECT DISTINCT ON (job_name)
        job_name, started_at as last_error_at
      FROM job_runs
      WHERE status = 'error'
      ORDER BY job_name, started_at DESC
    )
    SELECT
      l.job_name,
      l.status,
      l.started_at,
      l.finished_at,
      l.duration_ms,
      ls.last_success_at,
      le.last_error_at,
      l.error
    FROM latest l
    LEFT JOIN last_success ls ON l.job_name = ls.job_name
    LEFT JOIN last_error le ON l.job_name = le.job_name
    ORDER BY l.started_at DESC
  `;

  // Query recent runs (limit 100)
  const recentRunsResult = await sql<JobRun>`
    SELECT id, job_name, status, started_at, finished_at, duration_ms, metrics, error
    FROM job_runs
    ORDER BY started_at DESC
    LIMIT 100
  `;

  // Query price cache stats
  const priceCacheStats = await sql`
    SELECT
      COUNT(*) as total_cached,
      COUNT(*) FILTER (WHERE fetched_at >= NOW() - INTERVAL '30 minutes') as fresh_count,
      COUNT(*) FILTER (WHERE fetched_at < NOW() - INTERVAL '30 minutes') as stale_count,
      MIN(fetched_at) as oldest_fetch,
      MAX(fetched_at) as newest_fetch
    FROM outcome_price_cache
  `;

  // Query last successful refresh-prices run specifically
  const lastRefreshSuccess = await sql<{ finished_at: string }>`
    SELECT finished_at
    FROM job_runs
    WHERE job_name = 'refresh-prices'
      AND status = 'success'
    ORDER BY finished_at DESC
    LIMIT 1
  `;

  // Cache coverage: % of active outcomes (72h) with cached prices
  const cacheCoverage = await sql<{
    active_outcomes: number;
    cached_outcomes: number;
    missing_outcomes: number;
    coverage_pct: number;
  }>`
    WITH active AS (
      SELECT DISTINCT condition_id, outcome
      FROM alert_events
      WHERE fill_timestamp >= NOW() - INTERVAL '72 hours'
    )
    SELECT
      COUNT(*)::int as active_outcomes,
      COUNT(opc.condition_id)::int as cached_outcomes,
      (COUNT(*) - COUNT(opc.condition_id))::int as missing_outcomes,
      CASE WHEN COUNT(*) > 0
        THEN ROUND(100.0 * COUNT(opc.condition_id) / COUNT(*), 1)
        ELSE 0
      END as coverage_pct
    FROM active a
    LEFT JOIN outcome_price_cache opc
      ON a.condition_id = opc.condition_id AND a.outcome = opc.outcome
  `;

  const latestRuns = latestRunsResult.rows;
  const recentRuns = recentRunsResult.rows;
  const cacheStats = priceCacheStats.rows[0] || {
    total_cached: 0,
    fresh_count: 0,
    stale_count: 0,
    oldest_fetch: null,
    newest_fetch: null,
  };
  const coverage = cacheCoverage.rows[0] || {
    active_outcomes: 0,
    cached_outcomes: 0,
    missing_outcomes: 0,
    coverage_pct: 0,
  };

  // Determine freshness status
  const lastSuccessfulRefresh = lastRefreshSuccess.rows[0]?.finished_at || null;
  const neverRanSuccessfully = lastRefreshSuccess.rows.length === 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold">Admin Dashboard</h1>
          <p className="text-poly-muted text-sm">Job monitoring and system health</p>
        </div>
        <div className="flex items-center gap-3">
          <RefreshButton />
          <Link
            href="/report"
            className="px-4 py-2 bg-poly-card border border-poly-border text-white font-medium rounded hover:bg-poly-border transition-colors"
          >
            Report
          </Link>
          <Link
            href="/"
            className="px-4 py-2 bg-poly-card border border-poly-border text-white font-medium rounded hover:bg-poly-border transition-colors"
          >
            Home
          </Link>
        </div>
      </header>

      {/* Data Freshness Warning Banner */}
      <FreshnessWarning
        lastSuccessAt={lastSuccessfulRefresh}
        neverRan={neverRanSuccessfully}
      />

      {/* Price Cache Stats */}
      <section className="space-y-4">
        <h2 className="text-lg font-bold flex items-center">
          <span className="w-2.5 h-2.5 bg-cyan-500 rounded-full mr-2"></span>
          Price Cache
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
            <p className="text-poly-muted text-sm">Total Cached</p>
            <p className="text-2xl font-bold">{Number(cacheStats.total_cached).toLocaleString()}</p>
          </div>
          <div className="bg-poly-card rounded-lg p-4 border border-poly-border border-green-500/30">
            <p className="text-poly-muted text-sm">Fresh (&le;30min)</p>
            <p className="text-2xl font-bold text-green-400">{Number(cacheStats.fresh_count).toLocaleString()}</p>
          </div>
          <div className="bg-poly-card rounded-lg p-4 border border-poly-border border-yellow-500/30">
            <p className="text-poly-muted text-sm">Stale (&gt;30min)</p>
            <p className="text-2xl font-bold text-yellow-400">{Number(cacheStats.stale_count).toLocaleString()}</p>
          </div>
          <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
            <p className="text-poly-muted text-sm">Oldest Fetch</p>
            <p className="text-sm font-medium">{formatTimeAgo(cacheStats.oldest_fetch)}</p>
          </div>
          <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
            <p className="text-poly-muted text-sm">Newest Fetch</p>
            <p className="text-sm font-medium">{formatTimeAgo(cacheStats.newest_fetch)}</p>
          </div>
        </div>

        {/* Cache Coverage Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
            <p className="text-poly-muted text-sm">Active Outcomes (72h)</p>
            <p className="text-2xl font-bold">{Number(coverage.active_outcomes).toLocaleString()}</p>
          </div>
          <div className={`bg-poly-card rounded-lg p-4 border ${Number(coverage.coverage_pct) >= 95 ? 'border-green-500/30' : Number(coverage.coverage_pct) >= 80 ? 'border-yellow-500/30' : 'border-red-500/30'}`}>
            <p className="text-poly-muted text-sm">Cache Coverage</p>
            <p className={`text-2xl font-bold ${Number(coverage.coverage_pct) >= 95 ? 'text-green-400' : Number(coverage.coverage_pct) >= 80 ? 'text-yellow-400' : 'text-red-400'}`}>
              {Number(coverage.coverage_pct).toFixed(1)}%
            </p>
          </div>
          <div className="bg-poly-card rounded-lg p-4 border border-poly-border border-green-500/30">
            <p className="text-poly-muted text-sm">Cached</p>
            <p className="text-2xl font-bold text-green-400">{Number(coverage.cached_outcomes).toLocaleString()}</p>
          </div>
          <div className={`bg-poly-card rounded-lg p-4 border border-poly-border ${Number(coverage.missing_outcomes) > 0 ? 'border-orange-500/30' : 'border-poly-border'}`}>
            <p className="text-poly-muted text-sm">Missing Prices</p>
            <p className={`text-2xl font-bold ${Number(coverage.missing_outcomes) > 0 ? 'text-orange-400' : 'text-poly-muted'}`}>
              {Number(coverage.missing_outcomes).toLocaleString()}
            </p>
          </div>
        </div>
      </section>

      {/* Job Status Summary */}
      <section className="space-y-4">
        <h2 className="text-lg font-bold flex items-center">
          <span className="w-2.5 h-2.5 bg-purple-500 rounded-full mr-2"></span>
          Job Status
        </h2>
        {latestRuns.length === 0 ? (
          <div className="bg-poly-card rounded-lg p-6 border border-poly-border text-center text-poly-muted">
            No job runs recorded yet. Jobs will appear here after the first cron execution.
          </div>
        ) : (
          <div className="bg-poly-card rounded-lg border border-poly-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-poly-border">
                <tr>
                  <th className="text-left p-3 text-poly-muted font-medium">Job</th>
                  <th className="text-center p-3 text-poly-muted font-medium">Status</th>
                  <th className="text-right p-3 text-poly-muted font-medium">Last Run</th>
                  <th className="text-right p-3 text-poly-muted font-medium">Duration</th>
                  <th className="text-right p-3 text-poly-muted font-medium">Last Success</th>
                  <th className="text-right p-3 text-poly-muted font-medium">Last Error</th>
                </tr>
              </thead>
              <tbody>
                {latestRuns.map((job) => (
                  <tr key={job.job_name} className="border-t border-poly-border hover:bg-poly-border/30">
                    <td className="p-3 font-medium">{job.job_name}</td>
                    <td className="p-3 text-center">
                      <StatusBadge status={job.status} />
                    </td>
                    <td className="p-3 text-right text-poly-muted">{formatTimeAgo(job.started_at)}</td>
                    <td className="p-3 text-right">{formatDuration(job.duration_ms)}</td>
                    <td className="p-3 text-right text-green-400">{formatTimeAgo(job.last_success_at)}</td>
                    <td className="p-3 text-right text-red-400">{formatTimeAgo(job.last_error_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Error display for failed jobs */}
        {latestRuns.some(j => j.status === 'error' && j.error) && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-red-400">Recent Errors</h3>
            {latestRuns
              .filter(j => j.status === 'error' && j.error)
              .map((job) => (
                <div key={job.job_name} className="bg-red-900/20 border border-red-500/30 rounded-lg p-3">
                  <div className="flex justify-between items-start mb-1">
                    <span className="font-medium">{job.job_name}</span>
                    <span className="text-xs text-poly-muted">{formatTimeAgo(job.started_at)}</span>
                  </div>
                  <p className="text-sm text-red-300 font-mono break-all">{job.error}</p>
                </div>
              ))}
          </div>
        )}
      </section>

      {/* Recent Runs Table */}
      <section className="space-y-4">
        <h2 className="text-lg font-bold flex items-center">
          <span className="w-2.5 h-2.5 bg-blue-500 rounded-full mr-2"></span>
          Recent Runs
          <span className="text-sm font-normal text-poly-muted ml-2">({recentRuns.length})</span>
        </h2>
        {recentRuns.length === 0 ? (
          <div className="bg-poly-card rounded-lg p-6 border border-poly-border text-center text-poly-muted">
            No job runs recorded yet.
          </div>
        ) : (
          <div className="bg-poly-card rounded-lg border border-poly-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-poly-border">
                  <tr>
                    <th className="text-left p-3 text-poly-muted font-medium">Job</th>
                    <th className="text-center p-3 text-poly-muted font-medium">Status</th>
                    <th className="text-left p-3 text-poly-muted font-medium">Started</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Duration</th>
                    <th className="text-left p-3 text-poly-muted font-medium">Metrics</th>
                    <th className="text-left p-3 text-poly-muted font-medium">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRuns.map((run) => (
                    <tr key={run.id} className="border-t border-poly-border hover:bg-poly-border/30">
                      <td className="p-3 font-medium">{run.job_name}</td>
                      <td className="p-3 text-center">
                        <StatusBadge status={run.status} />
                      </td>
                      <td className="p-3 text-poly-muted text-xs">{formatTime(run.started_at)}</td>
                      <td className="p-3 text-right">{formatDuration(run.duration_ms)}</td>
                      <td className="p-3">
                        <MetricsDisplay metrics={run.metrics} />
                      </td>
                      <td className="p-3 max-w-xs truncate">
                        {run.error ? (
                          <span className="text-red-400 text-xs" title={run.error}>
                            {run.error.slice(0, 50)}
                            {run.error.length > 50 && '...'}
                          </span>
                        ) : (
                          <span className="text-poly-muted">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Footer */}
      <footer className="text-center text-poly-muted text-sm py-4 border-t border-poly-border">
        <p>Admin dashboard • Protected by Basic Auth</p>
        <p className="mt-1 text-xs">
          Refresh the page to update • Jobs run every 10 minutes via Vercel Cron
        </p>
      </footer>
    </div>
  );
}
