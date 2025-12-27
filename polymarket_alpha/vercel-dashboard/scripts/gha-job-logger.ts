// scripts/gha-job-logger.ts
// GitHub Actions job run logging for Neon Postgres
//
// Usage:
//   POSTGRES_URL=... npx tsx scripts/gha-job-logger.ts sanity-check
//   POSTGRES_URL=... npx tsx scripts/gha-job-logger.ts start <job_name> [metrics_json]
//   POSTGRES_URL=... npx tsx scripts/gha-job-logger.ts finish <job_run_id> success [metrics_json]
//   POSTGRES_URL=... npx tsx scripts/gha-job-logger.ts finish <job_run_id> error [error_message] [metrics_json]
//
// Environment:
//   POSTGRES_URL - Neon connection string (must include sslmode=require)
//
// IMPORTANT: Never prints secrets to stdout/stderr

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

function getPostgresUrl(): string {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    console.error('ERROR: POSTGRES_URL environment variable is not set');
    process.exit(1);
  }
  return url;
}

function sanitizeUrl(url: string): { host: string; database: string } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.host, // includes port if present
      database: parsed.pathname.replace('/', '') || '(default)',
    };
  } catch {
    return { host: '(parse error)', database: '(parse error)' };
  }
}

async function createClient(): Promise<Client> {
  const connectionString = getPostgresUrl();

  // Prefer verified TLS if possible. If it fails in your runner for cert reasons,
  // switch to rejectUnauthorized:false (less secure).
  const client = new Client({
    connectionString,
    ssl: true,
  });

  try {
    await client.connect();
    return client;
  } catch {
    // Fallback for environments that can't validate cert chain
    const fallback = new Client({
      connectionString,
      ssl: { rejectUnauthorized: false },
    });
    await fallback.connect();
    return fallback;
  }
}

function generateId(): string {
  return randomUUID();
}

function parseJsonObject(input?: string, onErrorMessage = 'ERROR: Invalid JSON'): Record<string, unknown> {
  if (!input) return {};
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    console.error(onErrorMessage);
    process.exit(1);
  } catch {
    console.error(onErrorMessage);
    process.exit(1);
  }
}

function coerceMetrics(val: unknown): Record<string, unknown> {
  if (!val) return {};
  if (typeof val === 'object') return val as Record<string, unknown>;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      return {};
    }
  }
  return {};
}

async function sanityCheck(): Promise<void> {
  console.log('=== DB Connectivity Sanity Check ===');

  const { host, database } = sanitizeUrl(getPostgresUrl());
  console.log(`Host: ${host}`);
  console.log(`Database: ${database}`);

  const client = await createClient();
  try {
    await client.query('SELECT 1 AS ok');

    const tableCheck = await client.query(
      `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'job_runs'
      ) AS exists
      `
    );

    if (!tableCheck.rows?.[0]?.exists) {
      console.error('Table job_runs: NOT FOUND');
      process.exit(1);
    }

    console.log('Table job_runs: EXISTS');
    console.log('=== Sanity Check PASSED ===');
  } finally {
    await client.end();
  }
}

async function startJob(jobName: string, metricsJson?: string): Promise<void> {
  if (!jobName) {
    console.error('ERROR: job_name is required');
    process.exit(1);
  }

  const client = await createClient();
  const id = generateId();

  const metrics = parseJsonObject(metricsJson, 'ERROR: Invalid metrics JSON');

  const ghaContext: Record<string, unknown> = {
    git_sha: process.env.GITHUB_SHA?.slice(0, 8),
    workflow_run_id: process.env.GITHUB_RUN_ID,
    run_number: process.env.GITHUB_RUN_NUMBER,
    workflow: process.env.GITHUB_WORKFLOW,
    actor: process.env.GITHUB_ACTOR,
  };

  // Remove undefined values
  Object.keys(ghaContext).forEach((k) => ghaContext[k] === undefined && delete ghaContext[k]);

  const finalMetrics = { ...metrics, source: 'github-actions', gha: ghaContext };

  try {
    await client.query(
      `
      INSERT INTO public.job_runs (id, job_name, status, started_at, metrics)
      VALUES ($1, $2, 'running', NOW(), $3::jsonb)
      `,
      [id, jobName, JSON.stringify(finalMetrics)]
    );

    // Output ONLY the job run ID for shell capture
    console.log(id);
  } finally {
    await client.end();
  }
}

async function finishJob(
  jobRunId: string,
  status: 'success' | 'error',
  arg3?: string,
  arg4?: string
): Promise<void> {
  if (!jobRunId) {
    console.error('ERROR: job_run_id is required');
    process.exit(1);
  }
  if (status !== 'success' && status !== 'error') {
    console.error('ERROR: status must be "success" or "error"');
    process.exit(1);
  }

  const client = await createClient();

  let errorMessage: string | null = null;
  let metricsJson: string | undefined;

  if (status === 'error') {
    errorMessage = arg3 || 'Unknown error';
    metricsJson = arg4;
  } else {
    metricsJson = arg3;
  }

  let additionalMetrics: Record<string, unknown> = {};
  if (metricsJson) {
    try {
      additionalMetrics = JSON.parse(metricsJson);
    } catch {
      // Don't fail finish on metrics parsing; it's observability, not the job itself.
      additionalMetrics = { metrics_parse_error: true };
    }
  }

  try {
    const existing = await client.query(
      'SELECT metrics, started_at FROM public.job_runs WHERE id = $1',
      [jobRunId]
    );

    if (existing.rowCount === 0) {
      console.error(`ERROR: job_run_id ${jobRunId} not found`);
      process.exit(1);
    }

    const startedAt = new Date(existing.rows[0].started_at);
    const durationMs = Date.now() - startedAt.getTime();

    const existingMetrics = coerceMetrics(existing.rows[0].metrics);
    const finalMetrics = { ...existingMetrics, ...additionalMetrics, durationMs };

    const truncatedError = errorMessage ? errorMessage.slice(0, 2000) : null;

    const updated = await client.query(
      `
      UPDATE public.job_runs
      SET status = $1,
          finished_at = NOW(),
          duration_ms = $2,
          metrics = $3::jsonb,
          error = $4
      WHERE id = $5
      RETURNING id
      `,
      [status, durationMs, JSON.stringify(finalMetrics), truncatedError, jobRunId]
    );

    if (updated.rowCount !== 1) {
      console.error(`ERROR: Failed to update job_run_id ${jobRunId}`);
      process.exit(1);
    }

    console.log(`Job ${jobRunId} finished with status: ${status}`);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'sanity-check':
      await sanityCheck();
      break;
    case 'start':
      await startJob(args[0], args[1]);
      break;
    case 'finish':
      await finishJob(args[0], args[1] as 'success' | 'error', args[2], args[3]);
      break;
    default:
      console.error('Usage:');
      console.error('  npx tsx scripts/gha-job-logger.ts sanity-check');
      console.error('  npx tsx scripts/gha-job-logger.ts start <job_name> [metrics_json]');
      console.error('  npx tsx scripts/gha-job-logger.ts finish <job_run_id> success [metrics_json]');
      console.error('  npx tsx scripts/gha-job-logger.ts finish <job_run_id> error [error_message] [metrics_json]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('ERROR:', err?.message || String(err));
  process.exit(1);
});
