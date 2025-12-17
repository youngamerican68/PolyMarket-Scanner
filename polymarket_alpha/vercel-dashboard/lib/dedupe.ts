// /lib/dedupe.ts
// Trade dedupe ID generation for Phase 1

import { roundPrice, roundSize } from './decimal';
import { normalizeTimestamp } from './schemas';

/**
 * Generate deterministic dedupe ID for a trade.
 *
 * Format with transactionHash:
 *   ${transactionHash}_${asset}_${side}_${timestampSeconds}_${priceRounded}_${sizeRounded}
 *
 * Format without transactionHash (fallback):
 *   noTx_${wallet}_${asset}_${side}_${timestampSeconds}_${priceRounded}_${sizeRounded}
 */
export function generateTradeDedupeId(params: {
  transactionHash: string | null | undefined;
  wallet: string;
  asset: string;
  side: 'BUY' | 'SELL';
  timestamp: number;
  price: number;
  size: number;
}): string {
  const { transactionHash, wallet, asset, side, timestamp, price, size } = params;

  const timestampSeconds = normalizeTimestamp(timestamp);
  const priceRounded = roundPrice(price);
  const sizeRounded = roundSize(size);

  if (transactionHash && transactionHash.trim() !== '') {
    return `${transactionHash}_${asset}_${side}_${timestampSeconds}_${priceRounded}_${sizeRounded}`;
  }

  return `noTx_${wallet.toLowerCase()}_${asset}_${side}_${timestampSeconds}_${priceRounded}_${sizeRounded}`;
}
