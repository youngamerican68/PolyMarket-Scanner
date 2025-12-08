// app/api/suspicious/route.ts
// Real-time anomaly detection API - refactored to use lib/

import { NextRequest, NextResponse } from "next/server";
import { fetchTrades, fetchWalletProfiles } from "@/lib/polymarket";
import { rankAnomalousWallets, formatMoney, formatOdds } from "@/lib/scoring";

// Force dynamic rendering
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const minutesParam = searchParams.get("minutes");
    const lookbackMinutes = Number.isFinite(Number(minutesParam))
      ? Number(minutesParam)
      : 60;

    const to = new Date();
    const from = new Date(to.getTime() - lookbackMinutes * 60 * 1000);

    // Fetch recent longshot trades
    const trades = await fetchTrades({
      from,
      to,
      maxPrice: 0.25, // <25% odds
    });

    // Fetch wallet profiles for historical context
    const uniqueWallets = Array.from(new Set(trades.map((t) => t.wallet)));
    const walletProfiles = await fetchWalletProfiles(uniqueWallets);

    // Rank wallets - more lenient for shorter time windows
    const anomalousWallets = rankAnomalousWallets(
      trades,
      {
        minLongshots: 3, // more lenient for real-time
        maxPrice: 0.25,
      },
      walletProfiles
    ).slice(0, 50); // top 50

    // Recent trades for feed
    const recentTrades = trades
      .slice()
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 30)
      .map((t) => ({
        wallet: t.wallet,
        name: t.name,
        title: t.title,
        outcome: t.outcome,
        price: t.price,
        size: t.size,
        value: t.price * t.size,
        potential: t.size,
        timestamp: Math.floor(new Date(t.timestamp).getTime() / 1000),
        oddsFormatted: formatOdds(t.price),
        valueFormatted: formatMoney(t.price * t.size),
        potentialFormatted: formatMoney(t.size),
      }));

    // Summary stats
    const stats = {
      totalTrades: trades.length,
      longshotTrades: trades.length,
      uniqueWallets: new Set(trades.map((t) => t.wallet)).size,
    };

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      window: {
        from: from.toISOString(),
        to: to.toISOString(),
        minutes: lookbackMinutes,
      },
      stats,
      suspiciousTraders: anomalousWallets.map((w) => ({
        wallet: w.wallet,
        name: w.name,
        suspicionScore: w.anomalyScore,
        level: w.level,
        levelReason: w.levelReason,
        longshotWins: w.actualWins,
        longshotLosses: w.longshotCount - w.actualWins,
        totalProfit: w.historicalPnl ?? 0,
        winRate: w.longshotCount > 0 ? w.actualWins / w.longshotCount : 0,
        longshotCount: w.longshotCount,
        expectedWins: w.expectedWins,
        actualWins: w.actualWins,
        zScore: w.zScore,
        totalStake: w.totalStake,
        totalValue: w.totalValue,
        // Historical context
        historicalPnl: w.historicalPnl,
        historicalPnlFormatted: w.historicalPnl != null ? formatMoney(w.historicalPnl) : null,
        historicalLongshotWins: w.historicalLongshotWins,
        historicalLongshotLosses: w.historicalLongshotLosses,
        totalPositions: w.totalPositions,
        topWins: w.topTrades.map((t) => ({
          title: t.title,
          outcome: t.outcome,
          entryPrice: t.price,
          profit: t.size - t.price * t.size, // potential profit if wins
        })),
        recentTrades: w.topTrades.slice(0, 3).map((t) => ({
          title: t.title,
          outcome: t.outcome,
          price: t.price,
          size: t.size,
        })),
      })),
      recentLongshots: recentTrades,
    });
  } catch (err) {
    console.error("Error in /api/suspicious:", err);
    return NextResponse.json(
      { error: "Failed to fetch anomalous traders" },
      { status: 500 }
    );
  }
}
