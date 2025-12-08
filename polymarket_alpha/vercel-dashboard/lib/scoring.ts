// lib/scoring.ts
// Statistical analysis: z-scores and anomaly detection

import type { Trade, WalletProfile } from "./polymarket";

export type WalletStats = {
  wallet: string;
  name: string;
  trades: Trade[];
  longshotCount: number;
  expectedWins: number;    // sum(p_i)
  actualWins: number;
  variance: number;        // sum(p_i * (1 - p_i))
  zScore: number | null;   // (actual - expected) / sqrt(variance)
  totalStake: number;
  totalValue: number;      // total $ spent (price * size)
};

export type AnomalousWallet = WalletStats & {
  anomalyScore: number;
  level: "low" | "medium" | "high" | "watch";
  levelReason: string;
  topTrades: Trade[];
  // Historical context from wallet profile
  historicalPnl?: number;
  historicalLongshotWins?: number;
  historicalLongshotLosses?: number;
  historicalLongshotPnl?: number;
  totalPositions?: number;
};

/**
 * Group trades by wallet address.
 */
function groupTradesByWallet(trades: Trade[]): Map<string, Trade[]> {
  const map = new Map<string, Trade[]>();
  for (const t of trades) {
    const arr = map.get(t.wallet) ?? [];
    arr.push(t);
    map.set(t.wallet, arr);
  }
  return map;
}

/**
 * Compute per-wallet statistics for longshot trades.
 *
 * For accurate z-scores, trades need `settled` and `won` fields.
 * If not available, we use closed-positions data or estimate from price movement.
 */
export function computeWalletStats(
  trades: Trade[],
  opts?: { minPrice?: number; maxPrice?: number }
): WalletStats[] {
  const { minPrice = 0, maxPrice = 0.25 } = opts ?? {};

  const filtered = trades.filter(
    (t) => t.price >= minPrice && t.price <= maxPrice
  );

  const byWallet = groupTradesByWallet(filtered);

  const stats: WalletStats[] = [];

  for (const [wallet, walletTrades] of Array.from(byWallet.entries())) {
    let expectedWins = 0;
    let actualWins = 0;
    let variance = 0;
    let totalStake = 0;
    let totalValue = 0;
    let name = "Anonymous";

    for (const t of walletTrades) {
      const p = t.price;
      expectedWins += p;
      variance += p * (1 - p);
      totalStake += t.size;
      totalValue += t.price * t.size;

      if (t.name && t.name !== "Anonymous") {
        name = t.name;
      }

      // Count actual wins if settlement data available
      if (t.settled && t.won === true) {
        actualWins += 1;
      }
    }

    // Calculate z-score
    let zScore: number | null = null;
    if (variance > 0) {
      zScore = (actualWins - expectedWins) / Math.sqrt(variance);
    }

    stats.push({
      wallet,
      name,
      trades: walletTrades,
      longshotCount: walletTrades.length,
      expectedWins,
      actualWins,
      variance,
      zScore,
      totalStake,
      totalValue,
    });
  }

  return stats;
}

/**
 * Calculate anomaly score from wallet stats with historical context.
 *
 * Formula: anomalyScore = max(0, z) * log(1 + longshotCount) * log(1 + totalValue)
 *
 * Level assignment considers:
 * - Statistical overperformance (z-score)
 * - Historical profitability (must be profitable for HIGH)
 * - Overall longshot win rate across history
 */
function scoreWallet(
  stat: WalletStats,
  profile?: WalletProfile
): AnomalousWallet {
  const { zScore, longshotCount, totalValue, trades } = stat;

  // Only positive z-scores indicate overperformance
  const positiveZ = zScore != null && zScore > 0 ? zScore : 0;

  // Log factors to dampen extreme values
  const countFactor = Math.log(1 + longshotCount);
  const valueFactor = Math.log(1 + Math.max(totalValue, 1));

  const anomalyScore = positiveZ * countFactor * valueFactor;

  // Get top trades by value
  const topTrades = trades
    .slice()
    .sort((a, b) => b.price * b.size - a.price * a.size)
    .slice(0, 5);

  // Determine alert level with PnL context
  let level: "low" | "medium" | "high" | "watch" = "low";
  let levelReason = "";

  const historicalPnl = profile?.totalPnl ?? 0;
  const historicalLongshotPnl = profile?.longshotPnl ?? 0;
  const historicalLongshotWins = profile?.longshotWins ?? 0;
  const historicalLongshotLosses = profile?.longshotLosses ?? 0;
  const totalHistoricalLongshots = historicalLongshotWins + historicalLongshotLosses;

  // Calculate historical longshot win rate
  const historicalWinRate = totalHistoricalLongshots > 0
    ? historicalLongshotWins / totalHistoricalLongshots
    : 0;

  if (anomalyScore >= 10) {
    // High z-score in short window - but check historical context
    if (historicalPnl < -1000) {
      // Strongly negative overall PnL - this is noise, not skill
      level = "watch";
      levelReason = `High recent win streak but ${formatMoney(historicalPnl)} overall loss`;
    } else if (historicalLongshotPnl < -500 && totalHistoricalLongshots > 10) {
      // Losing on longshots historically
      level = "watch";
      levelReason = `Recent streak, but ${historicalLongshotWins}/${totalHistoricalLongshots} lifetime longshot record`;
    } else if (historicalPnl > 1000 && historicalWinRate > 0.3) {
      // Actually profitable with good historical win rate - this is notable
      level = "high";
      levelReason = `Profitable (${formatMoney(historicalPnl)}) with ${(historicalWinRate * 100).toFixed(0)}% longshot win rate`;
    } else if (historicalPnl > 0) {
      level = "medium";
      levelReason = `Positive PnL (${formatMoney(historicalPnl)}) - monitoring`;
    } else {
      level = "watch";
      levelReason = `Recent win streak, limited historical data`;
    }
  } else if (anomalyScore >= 5) {
    if (historicalPnl > 500 && historicalWinRate > 0.25) {
      level = "medium";
      levelReason = `Moderate anomaly, profitable overall`;
    } else {
      level = "low";
      levelReason = `Moderate score but ${historicalPnl > 0 ? "marginal" : "negative"} PnL`;
    }
  } else {
    level = "low";
    levelReason = anomalyScore > 0
      ? "Low anomaly score"
      : "No statistical anomaly detected";
  }

  return {
    ...stat,
    anomalyScore,
    level,
    levelReason,
    topTrades,
    historicalPnl: profile?.totalPnl,
    historicalLongshotWins: profile?.longshotWins,
    historicalLongshotLosses: profile?.longshotLosses,
    historicalLongshotPnl: profile?.longshotPnl,
    totalPositions: profile?.totalPositions,
  };
}

/**
 * Main ranking function: from trades -> sorted anomalous wallets.
 *
 * @param trades - Array of trades to analyze
 * @param opts - Filtering options
 * @param walletProfiles - Optional map of wallet -> profile for historical context
 * @returns Sorted array of anomalous wallets (highest score first)
 */
export function rankAnomalousWallets(
  trades: Trade[],
  opts?: {
    minLongshots?: number;
    minAnomalyScore?: number;
    minPrice?: number;
    maxPrice?: number;
  },
  walletProfiles?: Map<string, WalletProfile>
): AnomalousWallet[] {
  const {
    minLongshots = 5,
    minAnomalyScore = 0,
    minPrice = 0,
    maxPrice = 0.25,
  } = opts ?? {};

  const stats = computeWalletStats(trades, { minPrice, maxPrice });

  const scored = stats
    .filter((s) => s.longshotCount >= minLongshots)
    .map((s) => scoreWallet(s, walletProfiles?.get(s.wallet)))
    .filter((s) => s.anomalyScore >= minAnomalyScore);

  // Sort by anomaly score descending
  scored.sort((a, b) => b.anomalyScore - a.anomalyScore);

  return scored;
}

/**
 * Legacy function name for backwards compatibility.
 * @deprecated Use rankAnomalousWallets instead
 */
export const rankSuspiciousWallets = rankAnomalousWallets;

/**
 * Format a number as currency.
 */
export function formatMoney(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `$${(value / 1_000).toFixed(1)}K`;
  }
  return `$${value.toFixed(0)}`;
}

/**
 * Format odds as percentage.
 */
export function formatOdds(price: number): string {
  return `${(price * 100).toFixed(1)}%`;
}
