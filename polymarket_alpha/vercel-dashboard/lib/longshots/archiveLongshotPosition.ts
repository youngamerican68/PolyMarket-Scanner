// lib/longshots/archiveLongshotPosition.ts
// Phase 7: Best-effort archival of longshot position snapshots
// NEVER throws - errors are logged and swallowed
// Stores raw snapshots only; all metrics computed at query time

import { sql } from '@vercel/postgres';
import { createHash } from 'crypto';

/**
 * Raw snapshot data for archiving a longshot position
 */
export interface LongshotSnapshot {
  wallet: string;
  conditionId: string;
  outcome: string;
  fillPrice: number;
  posAvgEntry: number | null;
  positionValueUsd: number;
  potentialWinUsd: number | null;
  observedAt: Date;
  source?: string;
}

/**
 * Generate deterministic dedupe key using normalized values
 * Uses fixed decimal formatting to prevent 0.2 vs 0.200000 creating different keys
 */
function generateDedupeKey(snapshot: LongshotSnapshot): string {
  // Normalize for hash only - original values are stored as-is
  const data = [
    snapshot.wallet.toLowerCase(),
    snapshot.conditionId,
    snapshot.outcome,
    snapshot.fillPrice.toFixed(6),
    snapshot.positionValueUsd.toFixed(2),
    snapshot.observedAt.toISOString(),
  ].join('|');

  return createHash('sha256').update(data).digest('hex').slice(0, 32);
}

export interface ArchiveResult {
  success: boolean;
  dedupeKey?: string;
  error?: string;
}

/**
 * Archive a single longshot position snapshot (best-effort, never throws)
 * Inserts into trade_history_longshot_positions with deduplication
 */
export async function archiveLongshotPositionSnapshot(
  snapshot: LongshotSnapshot
): Promise<ArchiveResult> {
  try {
    const dedupeKey = generateDedupeKey(snapshot);
    const source = snapshot.source || 'large_single_bet';

    await sql`
      INSERT INTO trade_history_longshot_positions (
        dedupe_key, wallet, condition_id, outcome,
        fill_price, pos_avg_entry, position_value_usd, potential_win_usd,
        observed_at, source
      ) VALUES (
        ${dedupeKey},
        ${snapshot.wallet},
        ${snapshot.conditionId},
        ${snapshot.outcome},
        ${snapshot.fillPrice},
        ${snapshot.posAvgEntry},
        ${snapshot.positionValueUsd},
        ${snapshot.potentialWinUsd},
        ${snapshot.observedAt.toISOString()},
        ${source}
      )
      ON CONFLICT (dedupe_key) DO NOTHING
    `;

    return { success: true, dedupeKey };
  } catch (err) {
    // Log but NEVER throw - this is best-effort archival
    console.warn('[longshot-archive] Failed to archive position:', String(err).slice(0, 200));
    return { success: false, error: String(err).slice(0, 200) };
  }
}

export interface BatchArchiveResult {
  archived: number;
  skipped: number;
  errors: number;
}

/**
 * Batch archive multiple positions (best-effort, never throws)
 * Returns counts of archived, skipped (duplicates), and failed rows
 */
export async function archiveLongshotPositionsBatch(
  snapshots: LongshotSnapshot[]
): Promise<BatchArchiveResult> {
  const results: BatchArchiveResult = { archived: 0, skipped: 0, errors: 0 };

  for (const snapshot of snapshots) {
    try {
      const result = await archiveLongshotPositionSnapshot(snapshot);
      if (result.success) {
        results.archived++;
      } else if (result.error?.includes('duplicate') || result.error?.includes('unique')) {
        results.skipped++;
      } else {
        results.errors++;
      }
    } catch {
      // Should never happen since archiveLongshotPositionSnapshot catches internally
      results.errors++;
    }
  }

  return results;
}
