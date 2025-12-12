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
    // CRITICAL: Negative PnL = NEVER allow HIGH (settlement window issue)
    if (historicalPnl < 0) {
      // Wallet is losing money overall - this is noise, not skill
      level = "watch";
      levelReason = `High settlement streak but ${formatMoney(historicalPnl)} overall loss`;
    } else if (historicalLongshotPnl < -500 && totalHistoricalLongshots > 10) {
      // Losing on longshots historically
      level = "watch";
      levelReason = `Recent streak, but ${historicalLongshotWins}/${totalHistoricalLongshots} lifetime longshot record`;
    } else if (historicalPnl > 1000 && historicalWinRate > 0.3) {
      // Actually profitable with good historical win rate - this is notable
      level = "high";
      levelReason = `Profitable (${formatMoney(historicalPnl)}) with ${(historicalWinRate * 100).toFixed(0)}% longshot win rate`;
    } else if (historicalPnl > 0 && historicalPnl <= 1000) {
      level = "medium";
      levelReason = `Modest profit (${formatMoney(historicalPnl)}) - monitoring`;
    } else {
      // No historical data available
      level = "watch";
      levelReason = `Recent settlement streak, limited historical data`;
    }
  } else if (anomalyScore >= 5) {
    if (historicalPnl > 500 && historicalWinRate > 0.25) {
      level = "medium";
      levelReason = `Moderate anomaly, profitable overall`;
    } else if (historicalPnl < 0) {
      level = "low";
      levelReason = `Moderate settlement score but ${formatMoney(historicalPnl)} overall loss`;
    } else {
      level = "low";
      levelReason = `Moderate score with marginal PnL`;
    }
  } else {
    level = "low";
    levelReason = anomalyScore > 0
      ? "Low settlement anomaly score"
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

/**
 * Sharp Convergence Detection
 *
 * Find markets where multiple "sharp" wallets (historical PnL > threshold)
 * are all buying the same longshot outcome.
 */
export type SharpConvergence = {
  marketId: string;
  eventSlug: string;
  title: string;
  outcome: string;
  avgPrice: number;
  totalValue: number;
  sharpCount: number;
  sharpWallets: Array<{
    wallet: string;
    name: string;
    historicalPnl: number;
    size: number;
    value: number;
    isHedged?: boolean;  // True if wallet has position on both sides
  }>;
};

export function detectSharpConvergence(
  trades: Trade[],
  walletProfiles: Map<string, WalletProfile>,
  opts?: {
    minBetValue?: number;      // Minimum bet size to be included (default $5K)
    minWalletCount?: number;   // Minimum wallets on same bet (default 3)
    maxPrice?: number;         // Max odds to consider (default 0.25)
    maxPositions?: number;     // Max positions to be considered (default 500) - filters out algos/market makers
  }
): SharpConvergence[] {
  const {
    minBetValue = 5000,        // $5K+ bet = high conviction
    minWalletCount = 3,        // 3+ wallets = convergence signal
    maxPrice = 0.25,
    maxPositions = 500,        // Only include selective traders, not algos with 10K+ positions
  } = opts ?? {};

  // Filter to longshot trades only, exclude already settled markets
  const longshots = trades.filter(t => t.price <= maxPrice && !t.settled);

  // Group by market + outcome
  const byMarketOutcome = new Map<string, Trade[]>();
  for (const t of longshots) {
    const key = `${t.marketId}:${t.outcome}`;
    const arr = byMarketOutcome.get(key) ?? [];
    arr.push(t);
    byMarketOutcome.set(key, arr);
  }

  const convergences: SharpConvergence[] = [];

  for (const [, marketTrades] of Array.from(byMarketOutcome.entries())) {
    // Get unique wallets and their profiles
    const walletTrades = new Map<string, Trade[]>();
    for (const t of marketTrades) {
      const arr = walletTrades.get(t.wallet) ?? [];
      arr.push(t);
      walletTrades.set(t.wallet, arr);
    }

    // Find qualifying wallets: high conviction bet + selective trader
    // No PnL requirement - bet size and selectivity are the signals
    const qualifyingWallets: SharpConvergence['sharpWallets'] = [];

    for (const [wallet, wTrades] of Array.from(walletTrades.entries())) {
      const profile = walletProfiles.get(wallet);
      const positions = profile?.totalPositions ?? 0;
      const pnl = profile?.totalPnl ?? 0;

      const totalSize = wTrades.reduce((sum, t) => sum + t.size, 0);
      const totalValue = wTrades.reduce((sum, t) => sum + t.price * t.size, 0);
      const name = wTrades[0]?.name || 'Anonymous';

      // Must have high conviction bet AND be selective (not an algo)
      // PnL is shown for context but NOT used as filter (unreliable)
      if (totalValue >= minBetValue && positions < maxPositions) {
        qualifyingWallets.push({
          wallet,
          name,
          historicalPnl: pnl,  // For display only, not filtering
          size: totalSize,
          value: totalValue,
        });
      }
    }

    // Only include if enough wallets converged on same bet
    if (qualifyingWallets.length >= minWalletCount) {
      const firstTrade = marketTrades[0];
      const totalValue = qualifyingWallets.reduce((sum, w) => sum + w.value, 0);
      const avgPrice = marketTrades.reduce((sum, t) => sum + t.price, 0) / marketTrades.length;

      // Skip if market appears settled (any trade marked settled, or all positions sold/closed)
      const anySettled = marketTrades.some(t => t.settled === true);
      const allSold = marketTrades.every(t => t.positionStatus === 'sold');
      if (anySettled || allSold) {
        continue; // Skip this convergence - market is over
      }

      // Sort by bet size descending (conviction signal)
      qualifyingWallets.sort((a, b) => b.value - a.value);

      convergences.push({
        marketId: firstTrade.marketId,
        eventSlug: firstTrade.eventSlug,
        title: firstTrade.title,
        outcome: firstTrade.outcome,
        avgPrice,
        totalValue,
        sharpCount: qualifyingWallets.length,
        sharpWallets: qualifyingWallets,
      });
    }
  }

  // Sort by number of sharps, then by total value
  convergences.sort((a, b) => {
    if (b.sharpCount !== a.sharpCount) return b.sharpCount - a.sharpCount;
    return b.totalValue - a.totalValue;
  });

  return convergences;
}

/**
 * Dormant Sharp Detection
 *
 * Identify wallets that:
 * 1. Have strong historical performance (high PnL, good longshot record)
 * 2. Haven't traded in 7+ days (dormant)
 * 3. Are now making longshot bets (reactivating)
 */
export type DormantSharp = {
  wallet: string;
  name: string;
  historicalPnl: number;
  longshotWinRate: number;
  longshotRecord: string;
  totalPositions: number;
  daysSinceLastTrade: number;
  currentTrades: Array<{
    title: string;
    outcome: string;
    price: number;
    size: number;
    value: number;
  }>;
  totalCurrentValue: number;
};

export function detectDormantSharps(
  trades: Trade[],
  walletProfiles: Map<string, WalletProfile>,
  walletLastActivity: Map<string, Date>,
  opts?: {
    minPnl?: number;           // Minimum historical PnL (default $5K)
    minWinRate?: number;       // Minimum longshot win rate (default 25%)
    minLongshotTrades?: number; // Minimum historical longshot trades (default 3)
    minDormantDays?: number;   // Minimum days since last trade (default 7)
    maxPrice?: number;         // Max odds to consider (default 0.25)
  }
): DormantSharp[] {
  const {
    minPnl = 5000,
    minWinRate = 0.25,
    minLongshotTrades = 3,
    minDormantDays = 7,
    maxPrice = 0.25,
  } = opts ?? {};

  const now = new Date();
  const longshots = trades.filter(t => t.price <= maxPrice);

  // Group by wallet
  const byWallet = new Map<string, Trade[]>();
  for (const t of longshots) {
    const arr = byWallet.get(t.wallet) ?? [];
    arr.push(t);
    byWallet.set(t.wallet, arr);
  }

  const dormantSharps: DormantSharp[] = [];

  for (const [wallet, walletTrades] of Array.from(byWallet.entries())) {
    const profile = walletProfiles.get(wallet);
    if (!profile) continue;

    const lastActivity = walletLastActivity.get(wallet);
    if (!lastActivity) continue;

    // Calculate days since last trade (before current window)
    const daysSinceLastTrade = Math.floor(
      (now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24)
    );

    // Must be dormant (7+ days inactive)
    if (daysSinceLastTrade < minDormantDays) continue;

    const totalLongshots = (profile.longshotWins ?? 0) + (profile.longshotLosses ?? 0);
    const winRate = totalLongshots > 0
      ? (profile.longshotWins ?? 0) / totalLongshots
      : 0;

    // Check if qualifies as a sharp
    const isProfitable = profile.totalPnl >= minPnl;
    const hasGoodWinRate = winRate >= minWinRate;
    const hasEnoughHistory = totalLongshots >= minLongshotTrades;

    if (isProfitable && hasGoodWinRate && hasEnoughHistory) {
      const currentTrades = walletTrades.map(t => ({
        title: t.title,
        outcome: t.outcome,
        price: t.price,
        size: t.size,
        value: t.price * t.size,
      }));

      const totalCurrentValue = currentTrades.reduce((sum, t) => sum + t.value, 0);
      const name = walletTrades[0]?.name || profile.name || 'Anonymous';

      const longshotRecord = (profile.longshotSoldEarly ?? 0) > 0
        ? `${profile.longshotWins}W/${profile.longshotLosses}L (${profile.longshotSoldEarly} sold)`
        : `${profile.longshotWins}W/${profile.longshotLosses}L`;

      dormantSharps.push({
        wallet,
        name,
        historicalPnl: profile.totalPnl,
        longshotWinRate: winRate,
        longshotRecord,
        totalPositions: profile.totalPositions,
        daysSinceLastTrade,
        currentTrades,
        totalCurrentValue,
      });
    }
  }

  // Sort by days dormant descending, then by PnL
  dormantSharps.sort((a, b) => {
    if (b.daysSinceLastTrade !== a.daysSinceLastTrade) {
      return b.daysSinceLastTrade - a.daysSinceLastTrade;
    }
    return b.historicalPnl - a.historicalPnl;
  });

  return dormantSharps;
}
