// app/api/daily-report/route.ts
// Thin wrapper around lib/ for daily report generation

import { NextRequest, NextResponse } from "next/server";
import { fetchTradesFromDB, enrichTradesWithSettlement, fetchWalletProfiles, fetchOpenPositions, fetchWalletsLastActivity, OpenPosition } from "@/lib/polymarket";
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
    const topAggregated = Array.from(aggregatedTrades.values())
      .sort((a, b) => a.avgPrice - b.avgPrice)
      .slice(0, 50);

    // Fetch open positions for wallets in topAggregated to check if still holding
    const walletsToCheck = Array.from(new Set(topAggregated.map((t) => t.wallet))).slice(0, 20);
    const openPositionsByWallet = new Map<string, OpenPosition[]>();

    for (const wallet of walletsToCheck) {
      const positions = await fetchOpenPositions(wallet);
      openPositionsByWallet.set(wallet, positions);
    }

    // Helper to check if a position is still open
    const getPositionStatus = (wallet: string, marketId: string, outcome: string): 'holding' | 'sold' | 'unknown' => {
      const openPositions = openPositionsByWallet.get(wallet);
      if (!openPositions) return 'unknown';

      // Check if there's an open position matching this market and outcome
      const isHolding = openPositions.some(
        (p) => p.conditionId === marketId && p.outcome === outcome && p.size > 0
      );

      return isHolding ? 'holding' : 'sold';
    };

    // Build topLongshots with position status
    const topLongshots = topAggregated.map((t) => {
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
        };
      });

    // Summary stats
    const summary = {
      totalTrades: trades.length,
      totalWallets: new Set(trades.map((t) => t.wallet)).size,
      totalVolume: trades.reduce((sum, t) => sum + t.price * t.size, 0),
      totalPotential: trades.reduce((sum, t) => sum + t.size, 0),
    };

    // Detect sharp convergence (3+ sharps on same longshot)
    const sharpConvergences = detectSharpConvergence(trades, walletProfiles, {
      minSharpPnl: 10000,
      minSharpCount: 3,
      maxPrice,
    });

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
