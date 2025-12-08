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
    // Only include wallets with anomalyScore > 0 (actual statistical anomalies)
    const anomalousWallets = rankAnomalousWallets(
      trades,
      {
        minLongshots: 5,
        maxPrice: 0.25,
        minAnomalyScore: 0.01, // Filter out wallets with no anomaly
      },
      walletProfiles
    );

    // Aggregate trades by wallet + market + outcome to avoid duplicates
    const aggregatedTrades = new Map<string, {
      wallet: string;
      name: string;
      marketId: string;
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
          title: t.title,
          outcome: t.outcome,
          totalSize: t.size,
          totalValue: value,
          avgPrice: t.price,
          tradeCount: 1,
        });
      }
    }

    // Top aggregated positions by lowest odds, include trader profile
    const topLongshots = Array.from(aggregatedTrades.values())
      .sort((a, b) => a.avgPrice - b.avgPrice) // lowest odds first
      .slice(0, 50)
      .map((t) => {
        const profile = walletProfiles.get(t.wallet);
        return {
          id: `${t.wallet}:${t.marketId}:${t.outcome}`,
          wallet: t.wallet,
          name: t.name,
          marketId: t.marketId,
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
          // Trader's historical longshot record
          longshotWins: profile?.longshotWins ?? null,
          longshotLosses: profile?.longshotLosses ?? null,
          longshotRecord: profile
            ? `${profile.longshotWins}W/${profile.longshotLosses}L`
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
