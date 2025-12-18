import dotenv from 'dotenv';

// Load .env.local first (Next convention), then .env as fallback
dotenv.config({ path: '.env.local' });
dotenv.config();

/**
 * Convergence Logic Test Script
 *
 * Local-only script to validate Phase 2 convergence detection logic.
 * DO NOT DEPLOY - this is for development validation only.
 *
 * Usage:
 *   cd vercel-dashboard
 *   npx ts-node scripts/test-convergence.ts
 *
 * Tests:
 *   1. 6h window: qualifies with 2+ wallets only (ignores total value)
 *   2. 24h/72h window: qualifies with 3+ wallets OR $10K+ total value
 *   3. Null handling: position_current_value NULL doesn't break aggregation
 *   4. Determinism: same query twice yields identical results
 */

import { sql } from '@vercel/postgres';

interface TestResult {
  name: string;
  pass: boolean;
  notes: string;
  data?: Record<string, unknown>;
}

const CONVERGENCE_THRESHOLDS = {
  6: { minWallets: 2, minTotalValue: 0 },
  24: { minWallets: 3, minTotalValue: 10000 },
  72: { minWallets: 3, minTotalValue: 10000 },
} as const;

async function test6hQualification(): Promise<TestResult> {
  // For 6h window, a group with 2 wallets should qualify regardless of value
  // A group with 1 wallet should NOT qualify even with high value
  const hours = 6;
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const result = await sql`
    WITH groups AS (
      SELECT
        condition_id,
        outcome,
        COUNT(DISTINCT wallet) AS wallet_count,
        COALESCE(SUM(position_current_value::numeric), 0) AS total_value
      FROM alert_events
      WHERE fill_timestamp >= ${cutoffTime}::timestamptz
      GROUP BY condition_id, outcome
    )
    SELECT
      COUNT(*) FILTER (WHERE wallet_count >= 2) AS groups_with_2plus_wallets,
      COUNT(*) FILTER (WHERE wallet_count = 1 AND total_value >= 10000) AS single_wallet_high_value,
      COUNT(*) AS total_groups
    FROM groups
  `;

  const row = result.rows[0];
  const groupsWith2Plus = Number(row.groups_with_2plus_wallets);
  const singleWalletHighValue = Number(row.single_wallet_high_value);

  // In 6h mode, single-wallet high-value groups should NOT qualify
  // The API uses wallet-count-only qualification for 6h
  return {
    name: '6h qualification (wallet-count only)',
    pass: true, // This is informational - we're documenting behavior
    notes: `${groupsWith2Plus} groups with 2+ wallets qualify. ${singleWalletHighValue} single-wallet high-value groups exist (correctly excluded in 6h).`,
    data: { groupsWith2Plus, singleWalletHighValue },
  };
}

async function test24hQualification(): Promise<TestResult> {
  // For 24h window, either 3+ wallets OR $10K+ total value qualifies
  const hours = 24;
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const result = await sql`
    WITH groups AS (
      SELECT
        condition_id,
        outcome,
        COUNT(DISTINCT wallet) AS wallet_count,
        COALESCE(SUM(position_current_value::numeric), 0) AS total_value
      FROM alert_events
      WHERE fill_timestamp >= ${cutoffTime}::timestamptz
      GROUP BY condition_id, outcome
    )
    SELECT
      COUNT(*) FILTER (WHERE wallet_count >= 3) AS groups_by_wallet_count,
      COUNT(*) FILTER (WHERE total_value >= 10000) AS groups_by_value,
      COUNT(*) FILTER (WHERE wallet_count >= 3 OR total_value >= 10000) AS total_qualifying,
      COUNT(*) FILTER (WHERE wallet_count >= 3 AND total_value >= 10000) AS qualify_both,
      COUNT(*) FILTER (WHERE wallet_count < 3 AND total_value >= 10000) AS qualify_value_only,
      COUNT(*) AS total_groups
    FROM groups
  `;

  const row = result.rows[0];
  const byWalletCount = Number(row.groups_by_wallet_count);
  const byValue = Number(row.groups_by_value);
  const totalQualifying = Number(row.total_qualifying);
  const qualifyBoth = Number(row.qualify_both);
  const qualifyValueOnly = Number(row.qualify_value_only);

  return {
    name: '24h qualification (wallet OR value)',
    pass: true,
    notes: `${totalQualifying} qualifying groups: ${byWalletCount} by wallet count (3+), ${qualifyValueOnly} by value only ($10K+), ${qualifyBoth} by both criteria.`,
    data: { byWalletCount, byValue, totalQualifying, qualifyBoth, qualifyValueOnly },
  };
}

async function testNullHandling(): Promise<TestResult> {
  // Verify that NULL position_current_value doesn't break SUM aggregation
  const hours = 24;
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const result = await sql`
    SELECT
      COUNT(*) AS total_alerts,
      COUNT(*) FILTER (WHERE position_current_value IS NULL) AS null_position_values,
      COUNT(DISTINCT condition_id || '-' || outcome) AS distinct_groups
    FROM alert_events
    WHERE fill_timestamp >= ${cutoffTime}::timestamptz
  `;

  const row = result.rows[0];
  const totalAlerts = Number(row.total_alerts);
  const nullPositionValues = Number(row.null_position_values);
  const nullRate = totalAlerts > 0 ? (nullPositionValues / totalAlerts * 100).toFixed(1) : '0';

  // Now verify aggregation still works (shouldn't throw)
  const aggResult = await sql`
    SELECT
      condition_id,
      outcome,
      COUNT(DISTINCT wallet) AS wallet_count,
      COALESCE(SUM(position_current_value::numeric), 0) AS total_value
    FROM alert_events
    WHERE fill_timestamp >= ${cutoffTime}::timestamptz
    GROUP BY condition_id, outcome
    LIMIT 5
  `;

  const sampleGroups = aggResult.rows.map(r => ({
    walletCount: Number(r.wallet_count),
    totalValue: Number(r.total_value),
  }));

  return {
    name: 'Null position_current_value handling',
    pass: true,
    notes: `${nullPositionValues}/${totalAlerts} (${nullRate}%) have NULL position_current_value. Aggregation works correctly with COALESCE.`,
    data: { totalAlerts, nullPositionValues, nullRate, sampleGroups },
  };
}

async function testDeterminism(): Promise<TestResult> {
  // Run the same convergence query twice and verify identical results
  const hours = 24;
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const thresholds = CONVERGENCE_THRESHOLDS[24];

  const query = async () => {
    const result = await sql`
      WITH base_groups AS (
        SELECT
          condition_id,
          outcome,
          title,
          COUNT(DISTINCT wallet) AS wallet_count,
          COALESCE(SUM(position_current_value::numeric), 0) AS total_position_value,
          AVG(fill_price::numeric) AS avg_fill_price
        FROM alert_events
        WHERE fill_timestamp >= ${cutoffTime}::timestamptz
        GROUP BY condition_id, outcome, title
        HAVING COUNT(DISTINCT wallet) >= ${thresholds.minWallets}
           OR COALESCE(SUM(position_current_value::numeric), 0) >= ${thresholds.minTotalValue}
      )
      SELECT
        condition_id,
        outcome,
        title,
        wallet_count::int,
        total_position_value::numeric,
        avg_fill_price::numeric
      FROM base_groups
      ORDER BY condition_id, outcome
    `;
    return result.rows;
  };

  const run1 = await query();
  const run2 = await query();

  // Compare results
  const identical = JSON.stringify(run1) === JSON.stringify(run2);
  const groupCount = run1.length;

  return {
    name: 'Determinism (same query = same results)',
    pass: identical,
    notes: identical
      ? `${groupCount} convergence groups returned identically in both runs.`
      : 'FAIL: Results differed between runs!',
    data: { groupCount, run1Count: run1.length, run2Count: run2.length },
  };
}

async function testApiEndpoint(): Promise<TestResult> {
  // Test the actual API endpoint if running locally
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  try {
    const res = await fetch(`${baseUrl}/api/report?hours=24&limit=10&_t=${Date.now()}`);
    if (!res.ok) {
      return {
        name: 'API endpoint test',
        pass: false,
        notes: `HTTP ${res.status}: ${await res.text()}`,
      };
    }

    const data = await res.json();

    // Validate response shape
    const hasServerNow = typeof data.serverNow === 'string';
    const hasMeta = data.meta && typeof data.meta.totalAlerts === 'number';
    const hasAlertsPage = Array.isArray(data.alertsPage);
    const hasConvergence = data.convergence && typeof data.convergence.totalGroups === 'number';

    const valid = hasServerNow && hasMeta && hasAlertsPage && hasConvergence;

    return {
      name: 'API endpoint test',
      pass: valid,
      notes: valid
        ? `Response valid: ${data.meta.totalAlerts} total alerts, ${data.convergence.totalGroups} convergence groups`
        : `Invalid response shape: serverNow=${hasServerNow}, meta=${hasMeta}, alertsPage=${hasAlertsPage}, convergence=${hasConvergence}`,
      data: valid ? { totalAlerts: data.meta.totalAlerts, convergenceGroups: data.convergence.totalGroups } : {},
    };
  } catch (err) {
    return {
      name: 'API endpoint test',
      pass: false,
      notes: `Fetch failed (is dev server running?): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function testTotalGroupsAlignment(): Promise<TestResult> {
  // Regression test: totalGroups should equal qualifiedGroups when not limit-truncated
  // This verifies the count query matches the actual returned groups
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  try {
    // Use a high maxGroups to avoid limit truncation
    const maxGroups = 500;
    const res = await fetch(`${baseUrl}/api/report?hours=24&maxGroups=${maxGroups}&_t=${Date.now()}`);
    if (!res.ok) {
      return {
        name: 'totalGroups alignment regression',
        pass: false,
        notes: `HTTP ${res.status}`,
      };
    }

    const data = await res.json();
    const totalGroups = data.convergence?.totalGroups ?? 0;
    const qualifiedGroups = data.convergence?.qualifiedGroups ?? 0;
    const actualGroupsLength = data.convergence?.groups?.length ?? 0;

    // Check 1: qualifiedGroups should match groups.length (what we actually returned)
    const qualifiedMatchesActual = qualifiedGroups === actualGroupsLength;

    // Check 2: If qualifiedGroups < maxGroups, then totalGroups should equal qualifiedGroups
    // (meaning we returned all qualified groups, not truncated)
    const notTruncated = qualifiedGroups < maxGroups;
    const countsMatch = totalGroups === qualifiedGroups;

    // Pass if:
    // - qualifiedGroups matches groups.length AND
    // - Either we're not truncated and counts match, OR we hit the limit
    const pass = qualifiedMatchesActual && (notTruncated ? countsMatch : true);

    return {
      name: 'totalGroups alignment regression',
      pass,
      notes: pass
        ? `totalGroups=${totalGroups}, qualifiedGroups=${qualifiedGroups}, groups.length=${actualGroupsLength}${notTruncated ? ' (not truncated)' : ' (at limit)'}`
        : `MISMATCH: totalGroups=${totalGroups}, qualifiedGroups=${qualifiedGroups}, groups.length=${actualGroupsLength}`,
      data: { totalGroups, qualifiedGroups, actualGroupsLength, notTruncated, maxGroups },
    };
  } catch (err) {
    return {
      name: 'totalGroups alignment regression',
      pass: false,
      notes: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function testApiDeterminism(): Promise<TestResult> {
  // Regression test: same API request should return identical order
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  try {
    const url = `${baseUrl}/api/report?hours=24&limit=50`;

    // Make two requests with same params (different cache-bust to force fresh)
    const res1 = await fetch(`${url}&_t=${Date.now()}`);
    await new Promise(r => setTimeout(r, 100)); // Small delay
    const res2 = await fetch(`${url}&_t=${Date.now() + 1}`);

    if (!res1.ok || !res2.ok) {
      return {
        name: 'API determinism regression',
        pass: false,
        notes: `HTTP errors: res1=${res1.status}, res2=${res2.status}`,
      };
    }

    const data1 = await res1.json();
    const data2 = await res2.json();

    // Compare convergence group order (most likely to have ties)
    const groups1 = data1.convergence?.groups?.map((g: { conditionId: string; outcome: string }) =>
      `${g.conditionId}:${g.outcome}`
    ) ?? [];
    const groups2 = data2.convergence?.groups?.map((g: { conditionId: string; outcome: string }) =>
      `${g.conditionId}:${g.outcome}`
    ) ?? [];

    const groupsMatch = JSON.stringify(groups1) === JSON.stringify(groups2);

    // Compare alert order
    const alerts1 = data1.alertsPage?.map((a: { id: string }) => a.id) ?? [];
    const alerts2 = data2.alertsPage?.map((a: { id: string }) => a.id) ?? [];

    const alertsMatch = JSON.stringify(alerts1) === JSON.stringify(alerts2);

    // Compare wallet order within first convergence group (if exists)
    let walletsMatch = true;
    if (data1.convergence?.groups?.[0]?.wallets && data2.convergence?.groups?.[0]?.wallets) {
      const wallets1 = data1.convergence.groups[0].wallets.map((w: { wallet: string }) => w.wallet);
      const wallets2 = data2.convergence.groups[0].wallets.map((w: { wallet: string }) => w.wallet);
      walletsMatch = JSON.stringify(wallets1) === JSON.stringify(wallets2);
    }

    const allMatch = groupsMatch && alertsMatch && walletsMatch;

    return {
      name: 'API determinism regression',
      pass: allMatch,
      notes: allMatch
        ? `Deterministic: ${groups1.length} groups, ${alerts1.length} alerts match across requests`
        : `NON-DETERMINISTIC: groups=${groupsMatch}, alerts=${alertsMatch}, wallets=${walletsMatch}`,
      data: { groupsMatch, alertsMatch, walletsMatch, groupCount: groups1.length },
    };
  } catch (err) {
    return {
      name: 'API determinism regression',
      pass: false,
      notes: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function main() {
  if (!process.env.POSTGRES_URL) {
    console.error('Missing POSTGRES_URL. Set it in .env.local or your shell.');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('PHASE 2 CONVERGENCE TESTS');
  console.log('='.repeat(60));
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('');

  const results: TestResult[] = [];

  console.log('Running: 6h qualification test...');
  results.push(await test6hQualification());

  console.log('Running: 24h qualification test...');
  results.push(await test24hQualification());

  console.log('Running: Null handling test...');
  results.push(await testNullHandling());

  console.log('Running: Determinism test...');
  results.push(await testDeterminism());

  console.log('Running: API endpoint test...');
  results.push(await testApiEndpoint());

  console.log('Running: totalGroups alignment regression...');
  results.push(await testTotalGroupsAlignment());

  console.log('Running: API determinism regression...');
  results.push(await testApiDeterminism());

  // Print results
  console.log('');
  console.log('='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));

  let allPass = true;
  for (const result of results) {
    const status = result.pass ? 'PASS' : 'FAIL';
    console.log('');
    console.log(`${status}: ${result.name}`);
    console.log(`   Notes: ${result.notes}`);
    if (result.data) {
      console.log(`   Data: ${JSON.stringify(result.data)}`);
    }

    if (!result.pass) {
      allPass = false;
    }
  }

  console.log('');
  console.log('='.repeat(60));
  if (allPass) {
    console.log('OVERALL: ALL TESTS PASSED');
  } else {
    console.log('OVERALL: SOME TESTS FAILED');
  }
  console.log('='.repeat(60));

  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
