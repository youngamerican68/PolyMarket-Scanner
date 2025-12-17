// /lib/polymarket.ts
// Phase 1: Typed fetchers for Polymarket Data API
// Uses Zod for validation, retry/backoff for reliability
// NO Gamma or CLOB API calls — dashboards read from alert_events only

import { z } from 'zod';
import pLimit from 'p-limit';
import {
  Trade,
  Position,
  TradeSchema,
  PositionSchema,
  PositionsResponseSchema,
} from './schemas';

const DATA_API = 'https://data-api.polymarket.com';

// Concurrency limit for position fetches
const positionLimit = pLimit(5);

/**
 * Generic fetch with retry and exponential backoff.
 * Retries on 429 (rate limit) and 5xx errors.
 */
export async function fetchWithRetry<T>(
  url: string,
  schema: z.ZodSchema<T>,
  maxRetries: number = 3
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
      });

      if (res.status === 429 || res.status >= 500) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.warn(`[fetchWithRetry] ${url} returned ${res.status}, waiting ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      return schema.parse(data);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`[fetchWithRetry] Error on ${url}, retrying in ${delay}ms:`, lastError.message);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError ?? new Error('Fetch failed after retries');
}

/**
 * Fetch raw trades from Data API without Zod array parsing.
 * Validates each trade individually with safeParse to skip invalid items.
 */
export async function fetchRawTrades(params: {
  minValue?: number;
  limit?: number;
  offset?: number;
}): Promise<{ trades: Trade[]; skipped: number; errors: string[] }> {
  const { minValue = 100, limit = 500, offset = 0 } = params;

  const url = `${DATA_API}/trades?limit=${limit}&offset=${offset}&filterType=CASH&filterAmount=${minValue}&takerOnly=true`;

  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const rawData = await res.json();

  if (!Array.isArray(rawData)) {
    throw new Error('Expected array from trades API');
  }

  const trades: Trade[] = [];
  const errors: string[] = [];
  let skipped = 0;

  for (const item of rawData) {
    const result = TradeSchema.safeParse(item);
    if (result.success) {
      trades.push(result.data);
    } else {
      skipped++;
      const errorMsg = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
      errors.push(`Trade parse failed: ${errorMsg}`);
      if (errors.length <= 5) {
        console.warn('[fetchRawTrades] Skipping invalid trade:', errorMsg);
      }
    }
  }

  return { trades, skipped, errors };
}

/**
 * Fetch trades with retry and pagination.
 * Returns validated Trade[] with per-item Zod validation.
 */
export async function fetchTradesWithRetry(params: {
  minValue?: number;
  maxPages?: number;
  pageSize?: number;
}): Promise<{
  trades: Trade[];
  totalFetched: number;
  skippedValidation: number;
}> {
  const { minValue = 100, maxPages = 10, pageSize = 500 } = params;

  const allTrades: Trade[] = [];
  let totalSkipped = 0;
  let offset = 0;

  for (let page = 0; page < maxPages; page++) {
    try {
      const { trades, skipped } = await fetchRawTrades({
        minValue,
        limit: pageSize,
        offset,
      });

      allTrades.push(...trades);
      totalSkipped += skipped;

      // Stop if we got fewer than requested (end of data)
      if (trades.length + skipped < pageSize) {
        break;
      }

      offset += pageSize;
    } catch (err) {
      console.error(`[fetchTradesWithRetry] Page ${page} failed:`, err);
      break;
    }
  }

  return {
    trades: allTrades,
    totalFetched: allTrades.length + totalSkipped,
    skippedValidation: totalSkipped,
  };
}

/**
 * Fetch positions for a wallet with retry.
 * Uses Zod array validation.
 */
export async function fetchPositionsWithRetry(
  wallet: string,
  limitCount: number = 100
): Promise<{ positions: Position[]; atLimit: boolean }> {
  const url = `${DATA_API}/positions?user=${wallet}&limit=${limitCount}`;

  const positions = await fetchWithRetry(url, PositionsResponseSchema);

  // Warn if we hit the limit (potential truncation)
  const atLimit = positions.length === limitCount;
  if (atLimit) {
    console.warn(`[fetchPositionsWithRetry] Wallet ${wallet} returned ${limitCount} positions (at limit, may be truncated)`);
  }

  return { positions, atLimit };
}

/**
 * Fetch positions for multiple wallets with concurrency control.
 * Uses p-limit to avoid overwhelming the API.
 */
export async function fetchPositionsForWallets(
  wallets: string[],
  limitCount: number = 100
): Promise<{
  positionsByWallet: Map<string, Position[]>;
  atLimitWallets: string[];
}> {
  const positionsByWallet = new Map<string, Position[]>();
  const atLimitWallets: string[] = [];

  await Promise.all(
    wallets.map((wallet) =>
      positionLimit(async () => {
        try {
          const { positions, atLimit } = await fetchPositionsWithRetry(wallet, limitCount);
          positionsByWallet.set(wallet.toLowerCase(), positions);
          if (atLimit) {
            atLimitWallets.push(wallet);
          }
        } catch (err) {
          console.error(`[fetchPositionsForWallets] Failed to fetch positions for ${wallet}:`, err);
          positionsByWallet.set(wallet.toLowerCase(), []);
        }
      })
    )
  );

  return { positionsByWallet, atLimitWallets };
}

/**
 * Match a trade to a position from the same wallet.
 * Returns null if no matching position found (trade should be skipped).
 */
export function matchTradeToPosition(trade: Trade, positions: Position[]): Position | null {
  const walletLower = trade.proxyWallet.toLowerCase();

  // Filter positions by wallet and asset
  const candidates = positions.filter(
    (p) => p.proxyWallet.toLowerCase() === walletLower && p.asset === trade.asset
  );

  if (candidates.length === 0) {
    return null;
  }

  // Filter by conditionId
  const conditionMatches = candidates.filter((p) => p.conditionId === trade.conditionId);
  if (conditionMatches.length === 0) {
    console.warn('[matchTradeToPosition] conditionId mismatch', {
      tradeConditionId: trade.conditionId,
      candidateConditionIds: candidates.map((c) => c.conditionId),
    });
    return null;
  }

  // Find exact match by outcomeIndex (or accept null/undefined outcomeIndex)
  const exact = conditionMatches.find((p) => {
    return p.outcomeIndex === null || p.outcomeIndex === undefined || p.outcomeIndex === trade.outcomeIndex;
  });

  if (!exact) {
    console.warn('[matchTradeToPosition] outcomeIndex mismatch', {
      tradeOutcomeIndex: trade.outcomeIndex,
      candidateOutcomeIndexes: conditionMatches.map((c) => c.outcomeIndex),
    });
    return null;
  }

  return exact;
}

// Re-export types for convenience
export type { Trade, Position } from './schemas';
