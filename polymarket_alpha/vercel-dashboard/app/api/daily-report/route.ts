// app/api/daily-report/route.ts
// Thin wrapper around lib/ for daily report generation

import { NextRequest, NextResponse } from "next/server";
import { fetchTrades, enrichTradesWithSettlement, fetchWalletProfiles } from "@/lib/polymarket";
import { rankAnomalousWallets, formatMoney, formatOdds } from "@/lib/scoring";

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

    // Default: last 24 hours
    const to = toParam ?? new Date();
    const from = fromParam ?? new Date(to.getTime() - 24 * 60 * 60 * 1000);

    // Fetch longshot trades
    const rawTrades = await fetchTrades({
      from,
      to,
      maxPrice: 0.25, // <25% odds = longshots
    });

    // Enrich with settlement data for z-score calculation
    const trades = await enrichTradesWithSettlement(rawTrades);

    // Fetch wallet profiles for historical context
    const uniqueWallets = Array.from(new Set(trades.map((t) => t.wallet)));
    const walletProfiles = await fetchWalletProfiles(uniqueWallets);

    // Rank wallets by anomaly score with historical context
    const anomalousWallets = rankAnomalousWallets(
      trades,
      {
        minLongshots: 5,
        maxPrice: 0.25,
      },
      walletProfiles
    );

    // Top individual trades by value
    const topLongshots = trades
      .slice()
      .sort((a, b) => a.price - b.price) // lowest odds first
      .slice(0, 50)
      .map((t) => ({
        ...t,
        value: t.price * t.size,
        potential: t.size,
        oddsFormatted: formatOdds(t.price),
        valueFormatted: formatMoney(t.price * t.size),
        potentialFormatted: formatMoney(t.size),
      }));

    // Summary stats
    const summary = {
      totalTrades: trades.length,
      totalWallets: new Set(trades.map((t) => t.wallet)).size,
      totalVolume: trades.reduce((sum, t) => sum + t.price * t.size, 0),
      totalPotential: trades.reduce((sum, t) => sum + t.size, 0),
    };

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
    });
  } catch (err) {
    console.error("Error in /api/daily-report:", err);
    return NextResponse.json(
      { error: "Failed to generate daily report" },
      { status: 500 }
    );
  }
}
