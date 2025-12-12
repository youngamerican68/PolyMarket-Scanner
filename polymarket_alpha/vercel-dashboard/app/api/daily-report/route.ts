// app/api/daily-report/route.ts
// Thin wrapper around lib/ for daily report generation

import { NextRequest, NextResponse } from "next/server";
import { fetchTradesFromDB, enrichTradesWithSettlement, fetchWalletProfiles, fetchOpenPositions, fetchWalletsLastActivity, detectHedgedPositions, OpenPosition } from "@/lib/polymarket";
import { rankAnomalousWallets, formatMoney, formatOdds, detectSharpConvergence, detectDormantSharps } from "@/lib/scoring";

// Force dynamic rendering
export const dynamic = "force-dynamic";

function parseDateParam(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const fromParam = parseDateParam(searchParams.get("from"));
    const toParam = parseDateParam(searchParams.get("to"));
    const minOddsParam = searchParams.get("minOdds");
    const maxOddsParam = searchParams.get("maxOdds");

    // Default: last 24 hours
    const to = toParam ?? new Date();
    const from = fromParam ?? new Date(to.getTime() - 24 * 60 * 60 * 1000);

    // Odds range filter (default 0-25%)
    const minPrice = minOddsParam ? parseFloat(minOddsParam) : 0;
    const maxPrice = maxOddsParam ? parseFloat(maxOddsParam) : 0.25;

    // Fetch longshot trades from database (populated by collector)
    const rawTrades = await fetchTradesFromDB({
      from,
      to,
      minPrice,
      maxPrice,
    });

    // Enrich with settlement data for z-score calculation
    const trades = await enrichTradesWithSettlement(rawTrades);

    // Fetch wallet profiles for historical context
    const uniqueWallets = Array.from(new Set(trades.map((t) => t.wallet)));
    const walletProfiles = await fetchWalletProfiles(uniqueWallets);

    // Rank wallets by anomaly score with historical context
    // Only include wallets with anomalyScore > 0 (actual statistical anomalies)
    const anomalousWallets = rankAnomalousWallets(
      trades,
      {
        minLongshots: 5,
        maxPrice,
        minAnomalyScore: 0.01, // Filter out wallets with no anomaly
      },
      walletProfiles
    );

    // Aggregate trades by wallet + market + outcome to avoid duplicates
    const aggregatedTrades = new Map<string, {
      wallet: string;
      name: string;
      marketId: string;
      eventSlug: string;
      title: string;
      outcome: string;
      totalSize: number;
      totalValue: number;
      avgPrice: number;
      tradeCount: number;
    }>();

    for (const t of trades) {
      const key = `${t.wallet}:${t.marketId}:${t.outcome}`;
      const existing = aggregatedTrades.get(key);
      const value = t.price * t.size;

      if (existing) {
        existing.totalSize += t.size;
        existing.totalValue += value;
        existing.tradeCount += 1;
        // Weighted average price
        existing.avgPrice = existing.totalValue / existing.totalSize;
      } else {
        aggregatedTrades.set(key, {
          wallet: t.wallet,
          name: t.name,
          marketId: t.marketId,
          eventSlug: t.eventSlug,
          title: t.title,
          outcome: t.outcome,
          totalSize: t.size,
          totalValue: value,
          avgPrice: t.price,
          tradeCount: 1,
        });
      }
    }

    // Get top 50 aggregated positions by lowest odds first
    // Filter to minimum $5K bet size to focus on high-conviction bets
    const MIN_BET_VALUE = 5000;
    const topAggregated = Array.from(aggregatedTrades.values())
      .filter((t) => t.totalValue >= MIN_BET_VALUE)
      .sort((a, b) => a.avgPrice - b.avgPrice)
      .slice(0, 50);

    // Fetch open positions for wallets in topAggregated to check if still holding
    const walletsToCheck = Array.from(new Set(topAggregated.map((t) => t.wallet))).slice(0, 20);
    const openPositionsByWallet = new Map<string, OpenPosition[]>();

    for (const wallet of walletsToCheck) {
      const positions = await fetchOpenPositions(wallet);
      openPositionsByWallet.set(wallet, positions);
    }

    // Helper to check if a position is still open and has value
    const getPositionStatus = (wallet: string, marketId: string, outcome: string): 'holding' | 'sold' | 'unknown' => {
      const openPositions = openPositionsByWallet.get(wallet);
      if (!openPositions) return 'unknown';

      // Find the matching position with value > 0
      const position = openPositions.find(
        (p) => p.conditionId === marketId && p.outcome === outcome && p.size > 0 && p.curPrice > 0
      );

      return position ? 'holding' : 'sold';
    };

    // Build topLongshots with position status, filter out sold/settled positions
    const topLongshots = topAggregated
      .map((t) => {
        const profile = walletProfiles.get(t.wallet);
        const positionStatus = getPositionStatus(t.wallet, t.marketId, t.outcome);

        return {
          id: `${t.wallet}:${t.marketId}:${t.outcome}`,
          wallet: t.wallet,
          name: t.name,
          marketId: t.marketId,
          eventSlug: t.eventSlug,
          title: t.title,
          outcome: t.outcome,
          price: t.avgPrice,
          size: t.totalSize,
          value: t.totalValue,
          potential: t.totalSize,
          oddsFormatted: formatOdds(t.avgPrice),
          valueFormatted: formatMoney(t.totalValue),
          potentialFormatted: formatMoney(t.totalSize),
          tradeCount: t.tradeCount,
          positionStatus,
          // Trader's historical longshot record (held to settlement only)
          longshotWins: profile?.longshotWins ?? null,
          longshotLosses: profile?.longshotLosses ?? null,
          longshotSoldEarly: profile?.longshotSoldEarly ?? null,
          // Format: "5W/3L (2 sold)" or "5W/3L" if no sold early
          longshotRecord: profile
            ? profile.longshotSoldEarly > 0
              ? `${profile.longshotWins}W/${profile.longshotLosses}L (${profile.longshotSoldEarly} sold)`
              : `${profile.longshotWins}W/${profile.longshotLosses}L`
            : null,
          // Flag new wallets (5 or fewer historical positions)
          totalPositions: profile?.totalPositions ?? 0,
          isNewWallet: (profile?.totalPositions ?? 0) <= 5,
        };
      })
      // Only show positions that are still being held (not sold or settled)
      .filter((t) => t.positionStatus === 'holding');

    // Summary stats
    const summary = {
      totalTrades: trades.length,
      totalWallets: new Set(trades.map((t) => t.wallet)).size,
      totalVolume: trades.reduce((sum, t) => sum + t.price * t.size, 0),
      totalPotential: trades.reduce((sum, t) => sum + t.size, 0),
    };

    // Detect convergence: 2+ selective wallets betting $5K+ on same longshot
    // No PnL filter - bet size + selectivity are the signals
    const sharpConvergencesRaw = detectSharpConvergence(trades, walletProfiles, {
      minBetValue: 5000,      // $5K+ bet = high conviction
      minWalletCount: 2,      // 2+ wallets = convergence
      maxPrice,
      maxPositions: 500,      // <500 positions = selective trader
    });

    // Detect hedged positions and filter out settled markets
    // For each convergence, check if sharps still have open positions
    const sharpConvergencesWithStatus = await Promise.all(
      sharpConvergencesRaw.map(async (convergence) => {
        const walletsToCheck = convergence.sharpWallets.slice(0, 10); // Limit API calls
        const hedgeResults = new Map<string, boolean>();
        const positionFoundResults = new Map<string, boolean>();

        for (const sw of walletsToCheck) {
          const hedgeInfo = await detectHedgedPositions(sw.wallet, [convergence.marketId]);
          const info = hedgeInfo.get(convergence.marketId);
          positionFoundResults.set(sw.wallet, info?.positionFound ?? false);
          hedgeResults.set(sw.wallet, info?.positionFound && info?.hasHedge ? true : false);
        }

        // Check if any wallet still has an open position (market not settled)
        const anyPositionOpen = Array.from(positionFoundResults.values()).some(found => found);

        return {
          ...convergence,
          isSettled: !anyPositionOpen, // If no positions found, market is settled
          sharpWallets: convergence.sharpWallets.map((sw) => ({
            ...sw,
            isHedged: hedgeResults.get(sw.wallet) ?? false,
          })),
        };
      })
    );

    // Filter out settled markets - only show actionable alerts
    const sharpConvergences = sharpConvergencesWithStatus.filter(c => !c.isSettled);

    // Fetch last activity for wallets that have profiles (potential dormant sharps)
    const potentialDormantWallets = Array.from(walletProfiles.entries())
      .filter(([, profile]) => profile.totalPnl >= 5000)
      .map(([wallet]) => wallet)
      .slice(0, 20);

    const walletLastActivity = await fetchWalletsLastActivity(potentialDormantWallets, from);

    // Detect dormant sharps (7+ days inactive, now trading)
    const dormantSharps = detectDormantSharps(trades, walletProfiles, walletLastActivity, {
      minPnl: 5000,
      minWinRate: 0.25,
      minLongshotTrades: 3,
      minDormantDays: 7,
      maxPrice,
    });

    return NextResponse.json({
      window: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
      summary: {
        ...summary,
        totalVolumeFormatted: formatMoney(summary.totalVolume),
        totalPotentialFormatted: formatMoney(summary.totalPotential),
      },
      anomalousWallets: anomalousWallets.map((w) => ({
        wallet: w.wallet,
        name: w.name,
        anomalyScore: w.anomalyScore,
        level: w.level,
        levelReason: w.levelReason,
        longshotCount: w.longshotCount,
        expectedWins: w.expectedWins,
        actualWins: w.actualWins,
        zScore: w.zScore,
        totalStake: w.totalStake,
        totalValue: w.totalValue,
        totalValueFormatted: formatMoney(w.totalValue),
        totalStakeFormatted: formatMoney(w.totalStake),
        // Historical context
        historicalPnl: w.historicalPnl,
        historicalPnlFormatted: w.historicalPnl != null ? formatMoney(w.historicalPnl) : null,
        historicalLongshotWins: w.historicalLongshotWins,
        historicalLongshotLosses: w.historicalLongshotLosses,
        historicalLongshotPnl: w.historicalLongshotPnl,
        historicalLongshotPnlFormatted: w.historicalLongshotPnl != null ? formatMoney(w.historicalLongshotPnl) : null,
        totalPositions: w.totalPositions,
        topTrades: w.topTrades.map((t) => ({
          title: t.title,
          outcome: t.outcome,
          price: t.price,
          oddsFormatted: formatOdds(t.price),
          size: t.size,
          value: t.price * t.size,
          valueFormatted: formatMoney(t.price * t.size),
        })),
      })),
      topLongshots,
      // Sharp convergence alerts (3+ sharp wallets on same longshot)
      sharpConvergences: sharpConvergences.map((c) => ({
        marketId: c.marketId,
        eventSlug: c.eventSlug,
        title: c.title,
        outcome: c.outcome,
        avgPrice: c.avgPrice,
        oddsFormatted: formatOdds(c.avgPrice),
        totalValue: c.totalValue,
        totalValueFormatted: formatMoney(c.totalValue),
        sharpCount: c.sharpCount,
        sharpWallets: c.sharpWallets.map((w) => ({
          wallet: w.wallet,
          name: w.name,
          historicalPnl: w.historicalPnl,
          historicalPnlFormatted: formatMoney(w.historicalPnl),
          size: w.size,
          value: w.value,
          valueFormatted: formatMoney(w.value),
          potential: w.size, // If bet wins, payout = size (shares)
          potentialFormatted: formatMoney(w.size),
          isHedged: w.isHedged ?? false,
        })),
      })),
      // Dormant sharp alerts (7+ days inactive, now trading)
      dormantSharps: dormantSharps.map((d) => ({
        wallet: d.wallet,
        name: d.name,
        historicalPnl: d.historicalPnl,
        historicalPnlFormatted: formatMoney(d.historicalPnl),
        longshotWinRate: d.longshotWinRate,
        winRateFormatted: `${(d.longshotWinRate * 100).toFixed(0)}%`,
        longshotRecord: d.longshotRecord,
        totalPositions: d.totalPositions,
        daysSinceLastTrade: d.daysSinceLastTrade,
        currentTrades: d.currentTrades.slice(0, 3).map((t) => ({
          title: t.title,
          outcome: t.outcome,
          price: t.price,
          oddsFormatted: formatOdds(t.price),
          size: t.size,
          value: t.value,
          valueFormatted: formatMoney(t.value),
        })),
        totalCurrentValue: d.totalCurrentValue,
        totalCurrentValueFormatted: formatMoney(d.totalCurrentValue),
      })),
    });
  } catch (err) {
    console.error("Error in /api/daily-report:", err);
    return NextResponse.json(
      { error: "Failed to generate daily report" },
      { status: 500 }
    );
  }
}
