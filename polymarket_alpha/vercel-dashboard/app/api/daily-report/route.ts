// app/api/daily-report/route.ts
// Thin wrapper around lib/ for daily report generation

import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { fetchTradesFromDB, enrichTradesWithSettlement, fetchWalletProfiles, fetchOpenPositions, fetchWalletsLastActivity, detectHedgedPositions, checkMarketResolution, OpenPosition } from "@/lib/polymarket";
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
      latestTimestamp: string; // Most recent trade timestamp
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
        // Track most recent trade
        if (t.timestamp > existing.latestTimestamp) {
          existing.latestTimestamp = t.timestamp;
        }
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
          latestTimestamp: t.timestamp,
        });
      }
    }

    // Get all aggregated positions with $5K+ bet size, sorted by lowest odds
    const MIN_BET_VALUE = 5000;
    const topAggregated = Array.from(aggregatedTrades.values())
      .filter((t) => t.totalValue >= MIN_BET_VALUE)
      .sort((a, b) => a.avgPrice - b.avgPrice);

    // Fetch open positions for all wallets in topAggregated to check if still holding
    const walletsToCheck = Array.from(new Set(topAggregated.map((t) => t.wallet)));
    const openPositionsByWallet = new Map<string, OpenPosition[]>();

    // Fetch in parallel for speed (max ~50 wallets)
    await Promise.all(
      walletsToCheck.map(async (wallet) => {
        const positions = await fetchOpenPositions(wallet);
        openPositionsByWallet.set(wallet, positions);
      })
    );

    // Helper to check if a position is still open and not settled
    const getPositionData = (wallet: string, marketId: string, outcome: string): { status: 'holding' | 'sold' | 'unknown', totalPosition: number, curPrice: number } => {
      const openPositions = openPositionsByWallet.get(wallet);
      if (!openPositions) return { status: 'unknown', totalPosition: 0, curPrice: 0 };

      // Find the matching position that's not settled (curPrice between 0 and 1 exclusive)
      const position = openPositions.find(
        (p) => p.conditionId === marketId && p.outcome === outcome && p.size > 0 && p.curPrice > 0 && p.curPrice < 1
      );

      if (position) {
        return { status: 'holding', totalPosition: position.size, curPrice: position.curPrice };
      }
      return { status: 'sold', totalPosition: 0, curPrice: 0 };
    };

    // Build topLongshots with position status, filter out sold/settled positions
    const topLongshotsRaw = topAggregated
      .map((t) => {
        const profile = walletProfiles.get(t.wallet);
        const positionData = getPositionData(t.wallet, t.marketId, t.outcome);

        // Calculate inferred status based on position value change
        // Only mark won/lost at extreme value changes (98%+)
        const curPrice = positionData.curPrice;
        const entryPrice = t.avgPrice;
        let inferredStatus: 'pending' | 'likely_lost' | 'likely_won' = 'pending';

        if (curPrice >= 0.98) {
          // Price at 98%+ = market effectively settled to YES
          inferredStatus = 'likely_won';
        } else if (entryPrice > 0 && curPrice / entryPrice <= 0.01) {
          // Position value dropped 99%+ from entry = effectively lost
          inferredStatus = 'likely_lost';
        }

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
          // Most recent trade timestamp
          latestTimestamp: t.latestTimestamp,
          // Total position VALUE from Polymarket (size * curPrice)
          totalPosition: positionData.totalPosition * positionData.curPrice,
          totalPositionFormatted: formatMoney(positionData.totalPosition * positionData.curPrice),
          // Total potential payout if they win (full share count = payout at $1 each)
          totalPotential: positionData.totalPosition,
          totalPotentialFormatted: formatMoney(positionData.totalPosition),
          // Current market odds
          currentOdds: positionData.curPrice,
          currentOddsFormatted: formatOdds(positionData.curPrice),
          oddsFormatted: formatOdds(t.avgPrice),
          valueFormatted: formatMoney(t.totalValue),
          potentialFormatted: formatMoney(t.totalSize),
          tradeCount: t.tradeCount,
          positionStatus: positionData.status,
          // Inferred resolution status based on price (pending, likely_lost, likely_won)
          inferredStatus,
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

    // Detect hedged positions for top longshots
    const hedgeCheckMap = new Map<string, boolean>();
    for (const t of topLongshotsRaw) {
      const key = `${t.wallet}:${t.marketId}`;
      if (!hedgeCheckMap.has(key)) {
        const hedgeInfo = await detectHedgedPositions(t.wallet, [t.marketId]);
        const info = hedgeInfo.get(t.marketId);
        hedgeCheckMap.set(key, info?.hasHedge ?? false);
      }
    }

    // Add isHedged flag to topLongshots
    const topLongshots = topLongshotsRaw.map((t) => ({
      ...t,
      isHedged: hedgeCheckMap.get(`${t.wallet}:${t.marketId}`) ?? false,
    }));

    // Debug: count how many $5K+ trades exist and their statuses
    const allWithStatus = topAggregated.map((t) => {
      const posData = getPositionData(t.wallet, t.marketId, t.outcome);
      return {
        title: t.title.slice(0, 40),
        status: posData.status,
        value: t.totalValue,
        curPrice: posData.curPrice,
        avgPrice: t.avgPrice,
      };
    });
    const soldTrades = allWithStatus.filter(t => t.status === 'sold');
    const won = soldTrades.filter(t => t.curPrice === 1 || t.curPrice >= 0.99).length;
    const lost = soldTrades.filter(t => t.curPrice === 0 || t.curPrice <= 0.01).length;
    console.log('$5K+ trade status breakdown:', {
      total5kPlus: topAggregated.length,
      holding: allWithStatus.filter(t => t.status === 'holding').length,
      sold: soldTrades.length,
      soldWon: won,
      soldLost: lost,
    });
    // Log all $5K+ trades sorted by odds to verify nothing under 18% is missed
    console.log('All $5K+ trades by odds:', allWithStatus.sort((a, b) => a.avgPrice - b.avgPrice).map(t => ({
      odds: `${(t.avgPrice * 100).toFixed(1)}%`,
      status: t.status,
      value: `$${(t.value/1000).toFixed(1)}K`,
      title: t.title,
    })));

    // Log trades under 10% odds regardless of size
    const under10Trades = Array.from(aggregatedTrades.values())
      .filter((t) => t.avgPrice < 0.10)
      .sort((a, b) => a.avgPrice - b.avgPrice)
      .slice(0, 20);
    console.log('Trades under 10% odds (any size, top 20):', under10Trades.map(t => ({
      odds: `${(t.avgPrice * 100).toFixed(1)}%`,
      value: `$${t.totalValue.toFixed(0)}`,
      title: t.title.slice(0, 35),
      wallet: t.name || t.wallet.slice(0, 10),
    })));

    // Get data coverage: time span from earliest to latest trade
    // trades.timestamp is ISO string, need to parse it
    const timestamps = trades
      .map(t => new Date(t.timestamp).getTime())
      .filter(ts => !isNaN(ts) && ts > 0);

    const earliestMs = timestamps.length > 0 ? Math.min(...timestamps) : null;
    const latestMs = timestamps.length > 0 ? Math.max(...timestamps) : null;

    const dataStartTime = earliestMs ? new Date(earliestMs) : null;
    const dataEndTime = latestMs ? new Date(latestMs) : null;

    // Calculate hours from earliest to latest trade
    const hoursOfData = (earliestMs && latestMs)
      ? Math.round((latestMs - earliestMs) / (1000 * 60 * 60) * 10) / 10
      : 0;

    console.log('[daily-report] Data coverage:', {
      tradesCount: trades.length,
      timestampsCount: timestamps.length,
      earliestMs,
      latestMs,
      dataStartTime: dataStartTime?.toISOString(),
      dataEndTime: dataEndTime?.toISOString(),
      hoursOfData
    });

    // Summary stats
    const summary = {
      totalTrades: trades.length,
      totalWallets: new Set(trades.map((t) => t.wallet)).size,
      totalVolume: trades.reduce((sum, t) => sum + t.price * t.size, 0),
      totalPotential: trades.reduce((sum, t) => sum + t.size, 0),
      dataStartTime: dataStartTime?.toISOString() || null,
      hoursOfData,
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
    // For each convergence, check if market has resolved via CLOB API
    const sharpConvergencesWithStatus = await Promise.all(
      sharpConvergencesRaw.map(async (convergence) => {
        // First check if market is resolved via CLOB API (most reliable)
        const resolution = await checkMarketResolution(convergence.marketId);

        if (resolution.resolved) {
          return {
            ...convergence,
            isSettled: true,
            winner: resolution.winner,
            sharpWallets: convergence.sharpWallets,
          };
        }

        // If not resolved, check hedges
        const walletsToCheck = convergence.sharpWallets.slice(0, 10); // Limit API calls
        const hedgeResults = new Map<string, boolean>();

        for (const sw of walletsToCheck) {
          const hedgeInfo = await detectHedgedPositions(sw.wallet, [convergence.marketId]);
          const info = hedgeInfo.get(convergence.marketId);
          hedgeResults.set(sw.wallet, info?.positionFound && info?.hasHedge ? true : false);
        }

        return {
          ...convergence,
          isSettled: false,
          winner: null,
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

    // Query repeat winners from longshot_history (traders with 2+ wins)
    const repeatWinnersResult = await sql`
      SELECT
        wallet,
        MAX(name) as name,
        COUNT(*) FILTER (WHERE won = true) as wins,
        COUNT(*) FILTER (WHERE resolved = true) as resolved_bets,
        COUNT(*) as total_bets,
        SUM(CASE WHEN won = true THEN value ELSE 0 END) as total_won_value,
        SUM(CASE WHEN won = true THEN (size - value) ELSE 0 END) as total_profit
      FROM longshot_history
      GROUP BY wallet
      HAVING COUNT(*) FILTER (WHERE won = true) >= 2
      ORDER BY COUNT(*) FILTER (WHERE won = true) DESC, SUM(CASE WHEN won = true THEN (size - value) ELSE 0 END) DESC
      LIMIT 20
    `;

    // Get recent wins for each repeat winner
    const repeatWinners = await Promise.all(
      repeatWinnersResult.rows.map(async (row) => {
        const recentWinsResult = await sql`
          SELECT title, outcome, price, size, value, timestamp
          FROM longshot_history
          WHERE wallet = ${row.wallet} AND won = true
          ORDER BY timestamp DESC
          LIMIT 5
        `;

        return {
          wallet: row.wallet,
          name: row.name || "Anonymous",
          wins: Number(row.wins),
          resolvedBets: Number(row.resolved_bets),
          totalBets: Number(row.total_bets),
          winRate: row.resolved_bets > 0 ? (Number(row.wins) / Number(row.resolved_bets) * 100).toFixed(1) : null,
          totalWonValue: Number(row.total_won_value || 0),
          totalWonValueFormatted: formatMoney(Number(row.total_won_value || 0)),
          totalProfit: Number(row.total_profit || 0),
          totalProfitFormatted: formatMoney(Number(row.total_profit || 0)),
          recentWins: recentWinsResult.rows.map((w) => ({
            title: w.title,
            outcome: w.outcome,
            odds: (Number(w.price) * 100).toFixed(1) + '%',
            bet: formatMoney(Number(w.value)),
            payout: formatMoney(Number(w.size)),
            profit: formatMoney(Number(w.size) - Number(w.value)),
          })),
        };
      })
    );

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
      // Repeat winners alert (traders with 2+ longshot wins)
      repeatWinners,
    });
  } catch (err) {
    console.error("Error in /api/daily-report:", err);
    return NextResponse.json(
      { error: "Failed to generate daily report" },
      { status: 500 }
    );
  }
}
