// lib/scoring.ts
// DEPRECATED in Phase 1: Z-score logic deferred to Phase 2
// This file contains stub exports for backwards compatibility

// Format helpers are still used by other modules
export function formatMoney(value: number): string {
  if (Math.abs(value) >= 1000000) return `$${(value / 1000000).toFixed(2)}M`;
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

export function formatOdds(price: number): string {
  return `${(price * 100).toFixed(1)}%`;
}

// Stub types for backwards compatibility
export interface WalletStats {
  wallet: string;
  name: string;
  trades: unknown[];
  longshotCount: number;
  expectedWins: number;
  actualWins: number;
  variance: number;
  zScore: number | null;
  totalStake: number;
  totalValue: number;
}

export interface AnomalousWallet extends WalletStats {
  anomalyScore: number;
  level: 'low' | 'medium' | 'high' | 'watch';
  levelReason: string;
  topTrades: Array<{
    title: string;
    outcome: string;
    price: number;
    size: number;
    value: number;
  }>;
  historicalPnl?: number;
  historicalLongshotWins?: number;
  historicalLongshotLosses?: number;
  historicalLongshotPnl?: number;
  totalPositions?: number;
}

// Stub function - returns empty array in Phase 1
export function rankAnomalousWallets(
  _trades: unknown[],
  _options: {
    minLongshots?: number;
    maxPrice?: number;
    minAnomalyScore?: number;
  },
  _walletProfiles?: unknown
): AnomalousWallet[] {
  console.warn('[scoring] rankAnomalousWallets is deprecated in Phase 1');
  return [];
}

// Stub function - returns empty array in Phase 1
export function detectSharpConvergence(_trades: unknown[]): unknown[] {
  console.warn('[scoring] detectSharpConvergence is deprecated in Phase 1');
  return [];
}

// Stub function - returns empty array in Phase 1
export function detectDormantSharps(_trades: unknown[], _walletProfiles?: unknown): unknown[] {
  console.warn('[scoring] detectDormantSharps is deprecated in Phase 1');
  return [];
}
