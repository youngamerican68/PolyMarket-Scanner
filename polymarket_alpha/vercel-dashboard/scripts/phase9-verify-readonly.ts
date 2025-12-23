#!/usr/bin/env node
/**
 * Phase 9 Read-Only Verification Script
 *
 * Confirms Phase 9 deployment health without any writes or admin actions.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 npm run verify:phase9
 *   DATABASE_URL=... npm run verify:phase9
 */

import 'dotenv/config';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const DATABASE_URL = process.env.DATABASE_URL;
const REPORT_PATH = process.env.REPORT_PATH || '/api/report';
const REPORT_QUERY = process.env.REPORT_QUERY ?? '?limit=50';

// ─────────────────────────────────────────────────────────────────────────────
// Logging utilities
// ─────────────────────────────────────────────────────────────────────────────

const PASS = '\x1b[32m[PASS]\x1b[0m';
const WARN = '\x1b[33m[WARN]\x1b[0m';
const FAIL = '\x1b[31m[FAIL]\x1b[0m';
const INFO = '\x1b[36m[INFO]\x1b[0m';

function log(prefix: string, msg: string) {
  console.log(`${prefix} ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Checks
// ─────────────────────────────────────────────────────────────────────────────

interface CheckResult {
  passed: boolean;
  warnings: string[];
}

async function checkReportEndpoint(): Promise<CheckResult> {
  const url = `${BASE_URL}${REPORT_PATH}${REPORT_QUERY}`;
  log(INFO, `GET ${url}`);

  const warnings: string[] = [];

  try {
    const res = await fetch(url);

    if (res.status !== 200) {
      log(FAIL, `Report endpoint returned ${res.status}`);
      return { passed: false, warnings };
    }

    log(PASS, `Report endpoint returned 200 OK`);

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      log(FAIL, 'Failed to parse JSON response');
      return { passed: false, warnings };
    }

    // Handle both { rows: [...] } and [...] shapes
    let rows: unknown[] = [];
    if (Array.isArray(data)) {
      rows = data;
    } else if (data && typeof data === 'object' && 'rows' in data && Array.isArray((data as Record<string, unknown>).rows)) {
      rows = (data as Record<string, unknown>).rows as unknown[];
    } else if (data && typeof data === 'object') {
      // Try to find any array property that might contain the data
      for (const key of Object.keys(data as Record<string, unknown>)) {
        const val = (data as Record<string, unknown>)[key];
        if (Array.isArray(val) && val.length > 0) {
          rows = val;
          break;
        }
      }
    }

    log(INFO, `Response contains ${rows.length} row(s)`);

    if (rows.length === 0) {
      log(WARN, 'No rows returned; cannot validate Phase 9 fields in data');
      warnings.push('Empty dataset - Phase 9 fields cannot be validated in response data');
      return { passed: true, warnings };
    }

    // Check for Phase 9 fields in any row
    const phase9Fields = ['finalPnlIsEstimated', 'finalPnlEstimateSource', 'finalPnlEstimateAsOf'];
    const sampleRow = rows[0] as Record<string, unknown>;

    const foundFields: string[] = [];
    const missingFields: string[] = [];

    for (const field of phase9Fields) {
      if (field in sampleRow) {
        foundFields.push(field);
      } else {
        missingFields.push(field);
      }
    }

    if (foundFields.length === phase9Fields.length) {
      log(PASS, `All Phase 9 fields present: ${foundFields.join(', ')}`);
    } else if (foundFields.length > 0) {
      log(WARN, `Partial Phase 9 fields: found [${foundFields.join(', ')}], missing [${missingFields.join(', ')}]`);
      warnings.push(`Missing fields: ${missingFields.join(', ')}`);
    } else {
      log(FAIL, `No Phase 9 fields found in response. Expected: ${phase9Fields.join(', ')}`);
      return { passed: false, warnings };
    }

    // Summary of estimated vs exact P&L
    let estimatedCount = 0;
    let exactCount = 0;
    let nullCount = 0;

    for (const row of rows) {
      const r = row as Record<string, unknown>;
      if (r.finalPnl === null || r.finalPnl === undefined) {
        nullCount++;
      } else if (r.finalPnlIsEstimated === true) {
        estimatedCount++;
      } else {
        exactCount++;
      }
    }

    log(INFO, `P&L breakdown: ${exactCount} exact, ${estimatedCount} estimated, ${nullCount} pending/null`);

    return { passed: true, warnings };
  } catch (err) {
    log(FAIL, `Failed to fetch report: ${err instanceof Error ? err.message : String(err)}`);
    return { passed: false, warnings };
  }
}

async function checkAdminEndpointProtection(): Promise<CheckResult> {
  const url = `${BASE_URL}/api/admin/migrate`;
  log(INFO, `GET ${url} (expecting 401/403/404)`);

  const warnings: string[] = [];

  try {
    const res = await fetch(url, { method: 'GET' });

    if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 405) {
      log(PASS, `Admin endpoint properly protected (${res.status})`);
      return { passed: true, warnings };
    }

    if (res.status === 200) {
      log(FAIL, 'SECURITY WARNING: Admin endpoint returned 200 without auth!');
      warnings.push('Admin endpoint may be exposed - returned 200 without credentials');
      return { passed: false, warnings };
    }

    log(WARN, `Admin endpoint returned unexpected status: ${res.status}`);
    warnings.push(`Unexpected admin endpoint status: ${res.status}`);
    return { passed: true, warnings };
  } catch (err) {
    // Network errors are acceptable (endpoint might not exist)
    log(WARN, `Could not reach admin endpoint: ${err instanceof Error ? err.message : String(err)}`);
    warnings.push('Admin endpoint unreachable');
    return { passed: true, warnings };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Database Checks (optional, only if DATABASE_URL provided)
// ─────────────────────────────────────────────────────────────────────────────

async function checkDatabase(): Promise<CheckResult> {
  if (!DATABASE_URL) {
    log(INFO, 'DATABASE_URL not set, skipping DB checks');
    return { passed: true, warnings: [] };
  }

  log(INFO, 'Running database schema checks...');
  const warnings: string[] = [];

  // Dynamic import pg only if needed
  let Client: typeof import('pg').Client;
  try {
    const pg = await import('pg');
    Client = pg.Client;
  } catch {
    log(WARN, 'pg module not available, skipping DB checks');
    warnings.push('pg module not installed - DB checks skipped');
    return { passed: true, warnings };
  }

  const client = new Client({ connectionString: DATABASE_URL });

  try {
    await client.connect();
    log(PASS, 'Connected to database');

    // Check wallet_position_snapshot table exists
    const snapshotTableCheck = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'wallet_position_snapshot'
      ) as exists
    `);

    if (!snapshotTableCheck.rows[0].exists) {
      log(FAIL, 'Table wallet_position_snapshot does NOT exist');
      await client.end();
      return { passed: false, warnings };
    }
    log(PASS, 'Table wallet_position_snapshot exists');

    // Check market_final_pnl columns
    const requiredColumns = ['is_estimated', 'estimate_source', 'estimate_as_of'];
    const columnCheck = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'market_final_pnl'
        AND column_name = ANY($1)
    `, [requiredColumns]);

    const foundColumns = columnCheck.rows.map(r => r.column_name);
    const missingColumns = requiredColumns.filter(c => !foundColumns.includes(c));

    if (missingColumns.length > 0) {
      log(FAIL, `Missing columns on market_final_pnl: ${missingColumns.join(', ')}`);
      await client.end();
      return { passed: false, warnings };
    }
    log(PASS, `All Phase 9 columns exist on market_final_pnl: ${requiredColumns.join(', ')}`);

    // Count rows in wallet_position_snapshot
    const snapshotCount = await client.query(`
      SELECT COUNT(*)::int as total FROM wallet_position_snapshot
    `);
    const snapshotTotal = snapshotCount.rows[0].total;

    // Count recent snapshots (last 24h)
    let recentSnapshots = 0;
    try {
      const recentCheck = await client.query(`
        SELECT COUNT(*)::int as recent
        FROM wallet_position_snapshot
        WHERE updated_at > NOW() - INTERVAL '24 hours'
      `);
      recentSnapshots = recentCheck.rows[0].recent;
    } catch {
      log(WARN, 'Could not check recent snapshots (updated_at column may differ)');
      warnings.push('Recent snapshot check failed');
    }

    log(INFO, `wallet_position_snapshot: ${snapshotTotal} total, ${recentSnapshots} in last 24h`);

    if (snapshotTotal === 0) {
      log(WARN, 'No snapshots yet - cron may not have run or no tracked wallets');
      warnings.push('wallet_position_snapshot is empty');
    }

    // Count rows in market_final_pnl
    const finalPnlCount = await client.query(`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE is_estimated = true)::int as estimated
      FROM market_final_pnl
    `);
    const { total, estimated } = finalPnlCount.rows[0];

    log(INFO, `market_final_pnl: ${total} total, ${estimated} estimated`);

    if (total === 0) {
      log(WARN, 'No finalized P&L rows yet - no resolved markets or finalization not run');
      warnings.push('market_final_pnl is empty');
    }

    await client.end();
    log(PASS, 'Database checks complete');

    return { passed: true, warnings };
  } catch (err) {
    log(FAIL, `Database error: ${err instanceof Error ? err.message : String(err)}`);
    try {
      await client.end();
    } catch { /* ignore */ }
    return { passed: false, warnings };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Phase 9 Read-Only Verification');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  BASE_URL: ${BASE_URL}`);
  console.log(`  DATABASE: ${DATABASE_URL ? '(configured)' : '(not set)'}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  const allWarnings: string[] = [];
  let allPassed = true;

  // HTTP checks
  console.log('── HTTP Checks ─────────────────────────────────────────────────');
  const reportResult = await checkReportEndpoint();
  allPassed = allPassed && reportResult.passed;
  allWarnings.push(...reportResult.warnings);
  console.log('');

  const adminResult = await checkAdminEndpointProtection();
  allPassed = allPassed && adminResult.passed;
  allWarnings.push(...adminResult.warnings);
  console.log('');

  // DB checks
  if (DATABASE_URL) {
    console.log('── Database Checks ─────────────────────────────────────────────');
    const dbResult = await checkDatabase();
    allPassed = allPassed && dbResult.passed;
    allWarnings.push(...dbResult.warnings);
    console.log('');
  }

  // Summary
  console.log('═══════════════════════════════════════════════════════════════');
  if (allPassed && allWarnings.length === 0) {
    console.log(`  ${PASS} All checks passed`);
  } else if (allPassed) {
    console.log(`  ${WARN} Passed with ${allWarnings.length} warning(s):`);
    for (const w of allWarnings) {
      console.log(`       - ${w}`);
    }
  } else {
    console.log(`  ${FAIL} Some checks failed`);
    if (allWarnings.length > 0) {
      console.log(`  Warnings:`);
      for (const w of allWarnings) {
        console.log(`       - ${w}`);
      }
    }
  }
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
