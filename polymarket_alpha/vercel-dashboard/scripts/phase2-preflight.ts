import dotenv from 'dotenv';

// Load .env.local first (Next convention), then .env as fallback
dotenv.config({ path: '.env.local' });
dotenv.config();

/**
 * Phase 2 Pre-flight Validation Script
 *
 * Local-only script to validate database state before implementing Phase 2.
 * DO NOT DEPLOY - this is for development validation only.
 *
 * Usage:
 *   cd vercel-dashboard
 *   npx ts-node scripts/phase2-preflight.ts
 *
 * Requires POSTGRES_URL environment variable (same as app uses).
 * Loads from .env.local automatically.
 */

import { sql } from '@vercel/postgres';

interface QueryResult {
  name: string;
  pass: boolean;
  data: Record<string, unknown>;
  notes?: string;
}

async function runQuery<T extends Record<string, unknown>>(
  name: string,
  query: string,
  validator?: (rows: T[]) => { pass: boolean; notes?: string }
): Promise<QueryResult> {
  try {
    const result = await sql.query(query);
    const rows = result.rows as T[];

    let pass = true;
    let notes: string | undefined;

    if (validator) {
      const validation = validator(rows);
      pass = validation.pass;
      notes = validation.notes;
    }

    return {
      name,
      pass,
      data: rows.length === 1 ? rows[0] : { rows, count: rows.length },
      notes,
    };
  } catch (err) {
    return {
      name,
      pass: false,
      data: { error: err instanceof Error ? err.message : String(err) },
      notes: 'Query failed',
    };
  }
}

async function main() {
  // Early fail if POSTGRES_URL isn't set
  if (!process.env.POSTGRES_URL) {
    console.error('Missing POSTGRES_URL. Set it in .env.local or your shell.');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('PHASE 2 PRE-FLIGHT VALIDATION');
  console.log('='.repeat(60));
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('');

  const results: QueryResult[] = [];

  // Q1: Required field coverage (last 30d)
  console.log('Running Q1: Required field coverage...');
  results.push(await runQuery(
    'Q1: Required field coverage (last 30d)',
    `SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE fill_timestamp IS NULL) AS missing_fill_timestamp,
      COUNT(*) FILTER (WHERE wallet IS NULL) AS missing_wallet,
      COUNT(*) FILTER (WHERE fill_price IS NULL) AS missing_fill_price,
      COUNT(*) FILTER (WHERE position_current_value IS NULL) AS missing_position_current_value,
      COUNT(*) FILTER (WHERE condition_id IS NULL) AS missing_condition_id,
      COUNT(*) FILTER (WHERE outcome IS NULL) AS missing_outcome
    FROM alert_events
    WHERE fill_timestamp >= NOW() - INTERVAL '30 days'`,
    (rows) => {
      if (rows.length === 0) return { pass: false, notes: 'No data returned' };
      const r = rows[0] as Record<string, string | number>;
      const total = Number(r.total);

      // No alerts = cannot validate Phase 2 readiness
      if (total === 0) {
        return { pass: false, notes: 'No alerts in last 30 days; cannot validate Phase 2 readiness.' };
      }

      const critical = ['missing_fill_timestamp', 'missing_wallet', 'missing_fill_price', 'missing_condition_id', 'missing_outcome'];
      const failures = critical.filter(f => Number(r[f]) > 0);
      if (failures.length > 0) {
        return { pass: false, notes: `Required fields missing: ${failures.join(', ')}` };
      }

      // position_current_value can be null but must check rate isn't too high
      const missingPosValue = Number(r.missing_position_current_value);
      const nullRateNum = missingPosValue / total;

      // Fail if NULL rate > 5% (would make Phase 2 convergence misleading)
      if (nullRateNum > 0.05) {
        return { pass: false, notes: `position_current_value null rate too high: ${(nullRateNum * 100).toFixed(1)}% (${missingPosValue}/${total})` };
      }

      return {
        pass: true,
        notes: `position_current_value null rate: ${(nullRateNum * 100).toFixed(1)}% (${missingPosValue}/${total})`
      };
    }
  ));

  // Q2: fill_price unit check (should be 0-1; count any >1 or <0)
  console.log('Running Q2: fill_price unit check...');
  results.push(await runQuery(
    'Q2: fill_price unit check (0-1 range)',
    `SELECT
      MIN(fill_price) AS min_fill_price,
      MAX(fill_price) AS max_fill_price,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY fill_price) AS median_fill_price,
      COUNT(*) FILTER (WHERE fill_price > 1) AS prices_above_1,
      COUNT(*) FILTER (WHERE fill_price < 0) AS prices_below_0,
      COUNT(*) FILTER (WHERE fill_price <= 0.25) AS longshot_prices
    FROM alert_events
    WHERE fill_timestamp >= NOW() - INTERVAL '30 days'`,
    (rows) => {
      if (rows.length === 0) return { pass: false, notes: 'No data returned' };
      const r = rows[0] as Record<string, string | number | null>;
      const pricesAbove1 = Number(r.prices_above_1 ?? 0);
      const pricesBelow0 = Number(r.prices_below_0 ?? 0);
      if (pricesAbove1 > 0) {
        return { pass: false, notes: `${pricesAbove1} prices > 1 (may be percent units)` };
      }
      if (pricesBelow0 > 0) {
        return { pass: false, notes: `${pricesBelow0} prices < 0 (invalid data)` };
      }
      return {
        pass: true,
        notes: `Range: ${r.min_fill_price} - ${r.max_fill_price}, Median: ${r.median_fill_price}`
      };
    }
  ));

  // Q3: Display field coverage
  console.log('Running Q3: Display field coverage...');
  results.push(await runQuery(
    'Q3: Display field coverage',
    `SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE title IS NULL) AS missing_title,
      COUNT(*) FILTER (WHERE slug IS NULL) AS missing_slug,
      COUNT(*) FILTER (WHERE event_slug IS NULL) AS missing_event_slug
    FROM alert_events
    WHERE fill_timestamp >= NOW() - INTERVAL '30 days'`,
    (rows) => {
      if (rows.length === 0) return { pass: false, notes: 'No data returned' };
      const r = rows[0] as Record<string, string | number>;
      const total = Number(r.total);
      const missingTitle = Number(r.missing_title);
      const nullRate = total > 0 ? (missingTitle / total * 100).toFixed(1) : '0';
      return {
        pass: true, // Display fields are optional
        notes: `title null rate: ${nullRate}%, slug: ${r.missing_slug}, event_slug: ${r.missing_event_slug}`
      };
    }
  ));

  // Q4: Whale labeling sanity check
  console.log('Running Q4: Whale labeling sanity check...');
  results.push(await runQuery(
    'Q4: Whale labeling sanity check',
    `SELECT
      COUNT(*) AS total_alerts,
      COUNT(*) FILTER (WHERE is_whale = TRUE) AS whale_alerts,
      COUNT(*) FILTER (WHERE is_whale = TRUE AND whale_category IS NOT NULL) AS whale_with_category,
      COUNT(*) FILTER (WHERE is_whale = TRUE AND whale_tier IS NOT NULL) AS whale_with_tier,
      COUNT(*) FILTER (WHERE is_whale = FALSE AND whale_category IS NOT NULL) AS non_whale_with_category
    FROM alert_events
    WHERE fill_timestamp >= NOW() - INTERVAL '30 days'`,
    (rows) => {
      if (rows.length === 0) return { pass: false, notes: 'No data returned' };
      const r = rows[0] as Record<string, string | number>;
      const nonWhaleWithCategory = Number(r.non_whale_with_category);
      if (nonWhaleWithCategory > 0) {
        return { pass: false, notes: `${nonWhaleWithCategory} non-whales have whale_category set` };
      }
      return {
        pass: true,
        notes: `${r.whale_alerts} whale alerts, ${r.whale_with_category} with category, ${r.whale_with_tier} with tier`
      };
    }
  ));

  // Q5: Whale join verification (alerts vs watchlist overlap)
  console.log('Running Q5: Whale join verification...');
  results.push(await runQuery(
    'Q5: Whale join verification',
    `SELECT
      (SELECT COUNT(DISTINCT wallet) FROM alert_events WHERE is_whale = TRUE) AS distinct_whale_wallets_in_alerts,
      (SELECT COUNT(*) FROM whale_watchlist WHERE wallet IS NOT NULL) AS watchlist_wallets_with_address,
      (SELECT COUNT(*) FROM whale_watchlist
         WHERE wallet IS NOT NULL
           AND LOWER(wallet) IN (SELECT DISTINCT wallet FROM alert_events WHERE is_whale = TRUE)
      ) AS watchlist_matched_to_alerts`,
    (rows) => {
      if (rows.length === 0) return { pass: false, notes: 'No data returned' };
      const r = rows[0] as Record<string, string | number>;
      const whaleWallets = Number(r.distinct_whale_wallets_in_alerts);
      const watchlistWithAddr = Number(r.watchlist_wallets_with_address);
      const matched = Number(r.watchlist_matched_to_alerts);
      return {
        pass: true,
        notes: `${whaleWallets} whale wallets in alerts, ${watchlistWithAddr} watchlist entries with address, ${matched} matched`
      };
    }
  ));

  // Q6: Position value threshold check (verify gating assumptions)
  console.log('Running Q6: Position value threshold check...');
  results.push(await runQuery(
    'Q6: Position value threshold check',
    `SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE position_current_value >= 2500) AS above_threshold,
      COUNT(*) FILTER (WHERE position_current_value < 2500) AS below_threshold,
      COUNT(*) FILTER (WHERE position_current_value IS NULL) AS null_position_value,
      MIN(position_current_value) AS min_position_value,
      MAX(position_current_value) AS max_position_value
    FROM alert_events
    WHERE fill_timestamp >= NOW() - INTERVAL '30 days'`,
    (rows) => {
      if (rows.length === 0) return { pass: false, notes: 'No data returned' };
      const r = rows[0] as Record<string, string | number | null>;
      const below = Number(r.below_threshold ?? 0);
      const nullVal = Number(r.null_position_value ?? 0);
      // Note: below_threshold should ideally be 0 since ingestion gates at $2500
      // But null values are allowed and will be excluded from convergence
      return {
        pass: true,
        notes: `Above $2500: ${r.above_threshold}, Below: ${below}, Null: ${nullVal}, Range: $${r.min_position_value} - $${r.max_position_value}`
      };
    }
  ));

  // Q7: Repeated alerts per wallet/market/outcome in last 6h (dedupe pressure)
  console.log('Running Q7: Dedupe pressure check (6h)...');
  results.push(await runQuery(
    'Q7: Repeated alerts per wallet/market/outcome (6h)',
    `WITH recent AS (
      SELECT *
      FROM alert_events
      WHERE fill_timestamp >= NOW() - INTERVAL '6 hours'
    )
    SELECT
      condition_id,
      outcome,
      wallet,
      COUNT(*) AS alerts_in_6h
    FROM recent
    GROUP BY 1,2,3
    HAVING COUNT(*) > 1
    ORDER BY alerts_in_6h DESC
    LIMIT 20`,
    (rows) => {
      const count = rows.length;
      if (count === 0) {
        return { pass: true, notes: 'No duplicate wallet/market/outcome combinations in last 6h' };
      }
      const maxDupes = rows.length > 0 ? Number((rows[0] as Record<string, unknown>).alerts_in_6h) : 0;
      return {
        pass: true, // This is informational
        notes: `${count} wallet/market/outcome combos with >1 alert in 6h (max: ${maxDupes} alerts)`
      };
    }
  ));

  // Q8: Timestamp sanity (clock/window)
  console.log('Running Q8: Timestamp sanity check...');
  results.push(await runQuery(
    'Q8: Timestamp sanity check',
    `SELECT
      MAX(fill_timestamp) AS newest,
      MIN(fill_timestamp) AS oldest_last_30d,
      COUNT(*) AS total_last_30d,
      NOW() AS server_now
    FROM alert_events
    WHERE fill_timestamp >= NOW() - INTERVAL '30 days'`,
    (rows) => {
      if (rows.length === 0) return { pass: false, notes: 'No data returned' };
      const r = rows[0] as Record<string, string | number | null>;
      const newest = r.newest ? new Date(r.newest as string) : null;
      const serverNow = r.server_now ? new Date(r.server_now as string) : new Date();

      if (!newest) {
        return { pass: true, notes: 'No alerts in last 30 days' };
      }

      const ageMinutes = (serverNow.getTime() - newest.getTime()) / (1000 * 60);
      // Cron runs every 5 minutes, so anything under 15 min is fine
      // Warn if over 30 min but don't fail (could be low activity period)
      const warning = ageMinutes > 30;

      return {
        pass: true, // Don't hard-fail on staleness, just warn
        notes: `Newest: ${newest.toISOString()}, Age: ${ageMinutes.toFixed(0)} min, Total: ${r.total_last_30d}${warning ? ' (WARNING: data may be stale)' : ''}`
      };
    }
  ));

  // Q9: Check wallet normalization in watchlist
  console.log('Running Q9: Wallet normalization check...');
  results.push(await runQuery(
    'Q9: Wallet normalization in whale_watchlist',
    `SELECT
      COUNT(*) AS total_watchlist,
      COUNT(*) FILTER (WHERE wallet IS NOT NULL) AS with_wallet,
      COUNT(*) FILTER (WHERE wallet IS NOT NULL AND wallet != LOWER(wallet)) AS uppercase_wallets
    FROM whale_watchlist`,
    (rows) => {
      if (rows.length === 0) return { pass: false, notes: 'No data returned' };
      const r = rows[0] as Record<string, string | number>;
      const uppercase = Number(r.uppercase_wallets);
      return {
        pass: true, // The ingestion code uses LOWER() when querying, so this is informational
        notes: `${r.with_wallet} wallets in watchlist, ${uppercase} stored with uppercase (handled via LOWER() in queries)`
      };
    }
  ));

  // Print results
  console.log('');
  console.log('='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));

  let allPass = true;
  for (const result of results) {
    const status = result.pass ? '✅ PASS' : '❌ FAIL';
    console.log('');
    console.log(`${status}: ${result.name}`);
    if (result.notes) {
      console.log(`   Notes: ${result.notes}`);
    }
    console.log(`   Data: ${JSON.stringify(result.data, null, 2).split('\n').map((l, i) => i === 0 ? l : '         ' + l).join('\n')}`);

    if (!result.pass) {
      allPass = false;
    }
  }

  console.log('');
  console.log('='.repeat(60));
  if (allPass) {
    console.log('OVERALL: ✅ PRE-FLIGHT PASS');
    console.log('All validation checks passed. Proceed to Part B.');
  } else {
    console.log('OVERALL: ❌ PRE-FLIGHT FAIL');
    console.log('Some validation checks failed. Fix issues before proceeding to Part B.');
  }
  console.log('='.repeat(60));

  // Exit with appropriate code
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
