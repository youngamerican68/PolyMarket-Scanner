// lib/finalize-resolved-pnl.ts
// Phase 8: Finalize P&L when markets resolve
// Fetches current positions from Polymarket API and calculates final P&L

import { sql } from '@vercel/postgres';
import { fetchPositionsWithRetry, Position } from '@/lib/polymarket';

export interface FinalizeOptions {
  marketLimit?: number;        // Max markets to process per run
  walletConcurrency?: number;  // Parallel wallet fetches per market
}

export interface FinalizeResult {
  marketsConsidered: number;
  marketsFinalized: number;
  walletFetchFailures: number;
  upserts: number;
  errors: string[];
}

/**
 * Helper to safely convert various number-like values
 */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract standardized fields from a Position object
 * Includes defensive normalization for avgPrice units
 */
function pickPositionFields(p: Position) {
  const conditionId = p.conditionId;
  const outcome = p.outcome ?? null;
  const shares = num(p.size);
  let avgPrice = num(p.avgPrice);

  // Defensive normalization: Polymarket avgPrice should be 0-1
  // If we see values > 1, assume it's percentage (0-100) and convert
  if (avgPrice !== null && avgPrice > 1) {
    console.warn(`[finalize-pnl] avgPrice=${avgPrice} > 1, normalizing to ${avgPrice / 100}`);
    avgPrice = avgPrice / 100;
  }

  // Clamp to valid range [0, 1] as a safeguard
  if (avgPrice !== null) {
    avgPrice = Math.max(0, Math.min(1, avgPrice));
  }

  return { conditionId, outcome, shares, avgPrice };
}

/**
 * Simple concurrency-limited map function
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Main finalization function.
 * Finds resolved markets that haven't been finalized yet,
 * fetches current positions, calculates final P&L, and stores results.
 */
export async function finalizeResolvedPnL(opts: FinalizeOptions = {}): Promise<FinalizeResult> {
  const marketLimit = opts.marketLimit ?? 25;
  const walletConcurrency = opts.walletConcurrency ?? 4;

  const result: FinalizeResult = {
    marketsConsidered: 0,
    marketsFinalized: 0,
    walletFetchFailures: 0,
    upserts: 0,
    errors: [],
  };

  // Find resolved markets with a known winner that we haven't finalized yet
  const { rows: markets } = await sql<{
    condition_id: string;
    winning_outcome: string;
  }>`
    SELECT condition_id, winning_outcome
    FROM market_status
    WHERE market_resolved = TRUE
      AND winning_outcome IS NOT NULL
      AND TRIM(winning_outcome) != ''
      AND finalized_at IS NULL
    ORDER BY condition_id
    LIMIT ${marketLimit}
  `;

  result.marketsConsidered = markets.length;

  if (markets.length === 0) {
    console.log('[finalize-pnl] No unfinalized resolved markets found');
    return result;
  }

  console.log(`[finalize-pnl] Processing ${markets.length} resolved markets...`);

  for (const m of markets) {
    const conditionId = m.condition_id;
    const winningOutcome = m.winning_outcome;

    try {
      // Get all wallet+outcome pairs we care about for this market
      const { rows: pairs } = await sql<{ wallet: string; outcome: string }>`
        SELECT DISTINCT wallet, outcome
        FROM alert_events
        WHERE condition_id = ${conditionId}
          AND wallet IS NOT NULL
          AND outcome IS NOT NULL
      `;

      if (pairs.length === 0) {
        // No alerts for this market, mark as finalized anyway
        await sql`
          UPDATE market_status
          SET finalized_at = NOW()
          WHERE condition_id = ${conditionId}
        `;
        result.marketsFinalized++;
        continue;
      }

      // Get distinct wallets to fetch
      const wallets = Array.from(new Set(pairs.map(p => p.wallet)));

      // Fetch positions per wallet (with concurrency limit)
      const walletResults = await mapWithConcurrency(
        wallets,
        walletConcurrency,
        async (wallet) => {
          try {
            const { positions } = await fetchPositionsWithRetry(wallet);
            return { wallet, ok: true as const, positions };
          } catch (e) {
            return { wallet, ok: false as const, error: String(e), positions: [] as Position[] };
          }
        }
      );

      const failedWallets = walletResults.filter(r => !r.ok);
      result.walletFetchFailures += failedWallets.length;

      // If any wallet fetch failed, skip this market (will retry next run)
      if (failedWallets.length > 0) {
        console.warn(`[finalize-pnl] ${failedWallets.length} wallet fetches failed for ${conditionId}, skipping`);
        for (const fw of failedWallets.slice(0, 3)) {
          if (!fw.ok) {
            result.errors.push(`Wallet ${fw.wallet}: ${fw.error.slice(0, 50)}`);
          }
        }
        continue;
      }

      // Build lookup: (wallet, outcome) -> position for THIS condition
      const posByWalletOutcome = new Map<string, { shares: number; avgPrice: number }>();

      for (const wr of walletResults) {
        if (!wr.ok) continue;

        for (const pos of wr.positions) {
          const { conditionId: cid, outcome, shares, avgPrice } = pickPositionFields(pos);
          if (!cid || cid !== conditionId) continue;
          if (!outcome) continue;
          if (shares === null || avgPrice === null) continue;

          posByWalletOutcome.set(`${wr.wallet}::${outcome}`, {
            shares,
            avgPrice,
          });
        }
      }

      // Upsert final P&L for every (wallet, outcome) pair
      for (const { wallet, outcome } of pairs) {
        const key = `${wallet}::${outcome}`;
        const p = posByWalletOutcome.get(key);

        if (!p) {
          // No position found in API (likely redeemed after resolution)
          // Try to get estimate from snapshot or alert data

          // First, try position snapshot
          const snapshotResult = await sql<{
            shares: number;
            avg_price: number;
            updated_at: string;
          }>`
            SELECT shares, avg_price, updated_at
            FROM wallet_position_snapshot
            WHERE wallet = ${wallet}
              AND condition_id = ${conditionId}
              AND outcome = ${outcome}
          `;

          if (snapshotResult.rows.length > 0) {
            // Use snapshot for estimated P&L
            const snap = snapshotResult.rows[0];
            const shares = snap.shares;
            const avgPrice = snap.avg_price;
            const costBasis = shares * avgPrice;
            const potentialWin = shares * (1 - avgPrice);
            const estimatedPnl = outcome === winningOutcome ? potentialWin : -costBasis;

            await sql`
              INSERT INTO market_final_pnl
                (condition_id, wallet, outcome, position_found, shares, avg_price, potential_win, cost_basis, final_pnl, winning_outcome, is_estimated, estimate_source, estimate_as_of)
              VALUES
                (${conditionId}, ${wallet}, ${outcome}, FALSE, ${shares}, ${avgPrice}, ${potentialWin}, ${costBasis}, ${estimatedPnl}, ${winningOutcome}, TRUE, 'position_snapshot', ${snap.updated_at}::timestamptz)
              ON CONFLICT (condition_id, wallet, outcome)
              DO UPDATE SET
                position_found = EXCLUDED.position_found,
                shares = EXCLUDED.shares,
                avg_price = EXCLUDED.avg_price,
                potential_win = EXCLUDED.potential_win,
                cost_basis = EXCLUDED.cost_basis,
                final_pnl = EXCLUDED.final_pnl,
                winning_outcome = EXCLUDED.winning_outcome,
                is_estimated = EXCLUDED.is_estimated,
                estimate_source = EXCLUDED.estimate_source,
                estimate_as_of = EXCLUDED.estimate_as_of,
                finalized_at = NOW()
            `;
            result.upserts++;
            continue;
          }

          // Fallback: try alert_events snapshot
          const alertResult = await sql<{
            position_size: string | null;
            position_avg_price: string | null;
            fill_timestamp: string;
          }>`
            SELECT position_size, position_avg_price, fill_timestamp
            FROM alert_events
            WHERE wallet = ${wallet}
              AND condition_id = ${conditionId}
              AND outcome = ${outcome}
              AND position_size IS NOT NULL
              AND position_avg_price IS NOT NULL
            ORDER BY fill_timestamp DESC
            LIMIT 1
          `;

          if (alertResult.rows.length > 0) {
            const alert = alertResult.rows[0];
            const shares = parseFloat(alert.position_size || '0');
            let avgPrice = parseFloat(alert.position_avg_price || '0');

            // Normalize avgPrice (alert data stores as 0-1 typically)
            if (avgPrice > 1) avgPrice = avgPrice / 100;
            avgPrice = Math.max(0, Math.min(1, avgPrice));

            if (shares > 0 && avgPrice > 0) {
              const costBasis = shares * avgPrice;
              const potentialWin = shares * (1 - avgPrice);
              const estimatedPnl = outcome === winningOutcome ? potentialWin : -costBasis;

              await sql`
                INSERT INTO market_final_pnl
                  (condition_id, wallet, outcome, position_found, shares, avg_price, potential_win, cost_basis, final_pnl, winning_outcome, is_estimated, estimate_source, estimate_as_of)
                VALUES
                  (${conditionId}, ${wallet}, ${outcome}, FALSE, ${shares}, ${avgPrice}, ${potentialWin}, ${costBasis}, ${estimatedPnl}, ${winningOutcome}, TRUE, 'alert_snapshot', ${alert.fill_timestamp}::timestamptz)
                ON CONFLICT (condition_id, wallet, outcome)
                DO UPDATE SET
                  position_found = EXCLUDED.position_found,
                  shares = EXCLUDED.shares,
                  avg_price = EXCLUDED.avg_price,
                  potential_win = EXCLUDED.potential_win,
                  cost_basis = EXCLUDED.cost_basis,
                  final_pnl = EXCLUDED.final_pnl,
                  winning_outcome = EXCLUDED.winning_outcome,
                  is_estimated = EXCLUDED.is_estimated,
                  estimate_source = EXCLUDED.estimate_source,
                  estimate_as_of = EXCLUDED.estimate_as_of,
                  finalized_at = NOW()
              `;
              result.upserts++;
              continue;
            }
          }

          // No snapshot available - store NULL with position_found = false
          await sql`
            INSERT INTO market_final_pnl
              (condition_id, wallet, outcome, position_found, final_pnl, winning_outcome, is_estimated)
            VALUES
              (${conditionId}, ${wallet}, ${outcome}, FALSE, NULL, ${winningOutcome}, FALSE)
            ON CONFLICT (condition_id, wallet, outcome)
            DO UPDATE SET
              position_found = EXCLUDED.position_found,
              final_pnl = EXCLUDED.final_pnl,
              winning_outcome = EXCLUDED.winning_outcome,
              is_estimated = EXCLUDED.is_estimated,
              estimate_source = NULL,
              estimate_as_of = NULL,
              finalized_at = NOW()
          `;
          result.upserts++;
          continue;
        }

        const shares = p.shares;
        const avgPrice = p.avgPrice;

        // P&L Calculation Notes:
        // - shares: number of outcome tokens held
        // - avgPrice: average cost per share (0-1 range, e.g., 0.25 = 25¢)
        // - costBasis: total amount paid = shares × avgPrice
        // - potentialWin: profit if position wins = shares × (1 - avgPrice)
        //   This is PROFIT, not total payout. Total payout would be shares × 1.
        // - If won: finalPnl = +potentialWin (positive profit)
        // - If lost: finalPnl = -costBasis (negative, lost their investment)
        const costBasis = shares * avgPrice;
        const potentialWin = shares * (1 - avgPrice);
        const finalPnl = outcome === winningOutcome ? potentialWin : -costBasis;

        await sql`
          INSERT INTO market_final_pnl
            (condition_id, wallet, outcome, position_found, shares, avg_price, potential_win, cost_basis, final_pnl, winning_outcome, is_estimated)
          VALUES
            (${conditionId}, ${wallet}, ${outcome}, TRUE, ${shares}, ${avgPrice}, ${potentialWin}, ${costBasis}, ${finalPnl}, ${winningOutcome}, FALSE)
          ON CONFLICT (condition_id, wallet, outcome)
          DO UPDATE SET
            position_found = EXCLUDED.position_found,
            shares = EXCLUDED.shares,
            avg_price = EXCLUDED.avg_price,
            potential_win = EXCLUDED.potential_win,
            cost_basis = EXCLUDED.cost_basis,
            final_pnl = EXCLUDED.final_pnl,
            winning_outcome = EXCLUDED.winning_outcome,
            is_estimated = EXCLUDED.is_estimated,
            estimate_source = NULL,
            estimate_as_of = NULL,
            finalized_at = NOW()
        `;
        result.upserts++;
      }

      // Mark market as finalized
      await sql`
        UPDATE market_status
        SET finalized_at = NOW()
        WHERE condition_id = ${conditionId}
      `;
      result.marketsFinalized++;

      console.log(`[finalize-pnl] Finalized ${conditionId}: ${pairs.length} wallet/outcome pairs`);

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Market ${conditionId}: ${errMsg.slice(0, 100)}`);
      console.error(`[finalize-pnl] Error processing ${conditionId}:`, errMsg);
    }
  }

  console.log(`[finalize-pnl] Complete: ${result.marketsFinalized}/${result.marketsConsidered} markets finalized, ${result.upserts} upserts`);
  return result;
}
