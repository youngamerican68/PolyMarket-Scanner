// app/api/check-resolutions/route.ts
// Cron job to check if historical longshot markets have resolved
// Runs every 30 minutes via Vercel cron

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CLOB_API = "https://clob.polymarket.com";

interface MarketData {
  condition_id: string;
  closed: boolean;
  tokens: {
    token_id: string;
    outcome: string;
    winner: boolean;
  }[];
}

async function fetchMarketResolution(conditionId: string): Promise<MarketData | null> {
  try {
    const res = await fetch(`${CLOB_API}/markets/${conditionId}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      console.log(`[check-resolutions] Market ${conditionId} not found: ${res.status}`);
      return null;
    }

    const data = await res.json();
    return data;
  } catch (err) {
    console.error(`[check-resolutions] Error fetching market ${conditionId}:`, err);
    return null;
  }
}

export async function GET() {
  const startTime = Date.now();

  try {
    // Get all unresolved trades from history
    const pendingResult = await sql`
      SELECT DISTINCT market_id, outcome
      FROM longshot_history
      WHERE resolved = false
    `;

    const pendingMarkets = pendingResult.rows;
    console.log(`[check-resolutions] Checking ${pendingMarkets.length} pending markets`);

    if (pendingMarkets.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No pending markets to check",
        checked: 0,
        resolved: 0,
        duration: Date.now() - startTime,
      });
    }

    let checkedCount = 0;
    let resolvedCount = 0;
    let wonCount = 0;

    // Check each market
    for (const pending of pendingMarkets) {
      const marketId = pending.market_id;
      const tradeOutcome = pending.outcome;

      const marketData = await fetchMarketResolution(marketId);
      checkedCount++;

      if (!marketData) {
        continue;
      }

      // Check if market is closed (resolved)
      if (!marketData.closed) {
        console.log(`[check-resolutions] Market ${marketId} still open`);
        continue;
      }

      // Find the winning outcome
      const winningToken = marketData.tokens.find(t => t.winner === true);

      if (!winningToken) {
        console.log(`[check-resolutions] Market ${marketId} closed but no winner found`);
        continue;
      }

      const winningOutcome = winningToken.outcome;
      const tradeWon = tradeOutcome.toLowerCase() === winningOutcome.toLowerCase();

      console.log(`[check-resolutions] Market ${marketId} resolved: winner="${winningOutcome}", trade="${tradeOutcome}", won=${tradeWon}`);

      // Update all trades for this market
      // PnL calculation: if won, pnl = size * (1 - price), else pnl = -value
      if (tradeWon) {
        await sql`
          UPDATE longshot_history
          SET resolved = true, won = true, pnl = size * (1 - price)
          WHERE market_id = ${marketId} AND outcome = ${tradeOutcome}
        `;
        wonCount++;
      } else {
        await sql`
          UPDATE longshot_history
          SET resolved = true, won = false, pnl = -(price * size)
          WHERE market_id = ${marketId} AND outcome = ${tradeOutcome}
        `;
      }

      resolvedCount++;

      // Rate limit: don't hammer the API
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const duration = Date.now() - startTime;
    console.log(`[check-resolutions] Complete: checked=${checkedCount}, resolved=${resolvedCount}, won=${wonCount}, duration=${duration}ms`);

    return NextResponse.json({
      success: true,
      checked: checkedCount,
      resolved: resolvedCount,
      won: wonCount,
      duration,
    });
  } catch (err) {
    console.error("[check-resolutions] Error:", err);
    return NextResponse.json(
      { error: "Failed to check resolutions", details: String(err) },
      { status: 500 }
    );
  }
}
