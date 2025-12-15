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
    price?: number; // Current token price (0-1)
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
    let confirmedCount = 0;
    let inferredCount = 0;
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

      // Find the winning outcome - either explicitly marked or inferred from price
      let winningOutcome: string | null = null;
      let resolutionState: 'confirmed' | 'inferred' = 'inferred';
      let resolutionSource: 'official_api' | 'price_inference' = 'price_inference';

      // Method 1: Check if market is officially closed with a winner (CONFIRMED)
      if (marketData.closed) {
        const winningToken = marketData.tokens.find(t => t.winner === true);
        if (winningToken) {
          winningOutcome = winningToken.outcome;
          resolutionState = 'confirmed';
          resolutionSource = 'official_api';
          console.log(`[check-resolutions] Market ${marketId} CONFIRMED closed, winner="${winningOutcome}"`);
        }
      }

      // Method 2: Infer from token prices (if price is near 0 or 1, market effectively resolved)
      // Only use this if we don't have an official resolution
      if (!winningOutcome && marketData.tokens) {
        for (const token of marketData.tokens) {
          const price = token.price ?? 0;
          if (price >= 0.98) {
            // This outcome won (price near $1)
            winningOutcome = token.outcome;
            resolutionState = 'inferred';
            resolutionSource = 'price_inference';
            console.log(`[check-resolutions] Market ${marketId} INFERRED from price: "${token.outcome}" at ${(price * 100).toFixed(1)}%`);
            break;
          }
        }
      }

      if (!winningOutcome) {
        console.log(`[check-resolutions] Market ${marketId} still open (no winner found)`);
        continue;
      }

      const tradeWon = tradeOutcome.toLowerCase() === winningOutcome.toLowerCase();
      console.log(`[check-resolutions] Market ${marketId} ${resolutionState}: winner="${winningOutcome}", trade="${tradeOutcome}", won=${tradeWon}`);

      // Update all trades for this market with resolution state
      // PnL calculation: if won, pnl = size * (1 - price), else pnl = -value
      // IMPORTANT: Never downgrade 'confirmed' to 'inferred'
      if (tradeWon) {
        await sql`
          UPDATE longshot_history
          SET
            resolved = true,
            won = true,
            pnl = size * (1 - price),
            resolution_state = CASE
              WHEN resolution_state = 'confirmed' THEN 'confirmed'
              ELSE ${resolutionState}
            END,
            resolution_source = CASE
              WHEN resolution_state = 'confirmed' THEN resolution_source
              ELSE ${resolutionSource}
            END
          WHERE market_id = ${marketId} AND outcome = ${tradeOutcome}
        `;
        wonCount++;
      } else {
        await sql`
          UPDATE longshot_history
          SET
            resolved = true,
            won = false,
            pnl = -(price * size),
            resolution_state = CASE
              WHEN resolution_state = 'confirmed' THEN 'confirmed'
              ELSE ${resolutionState}
            END,
            resolution_source = CASE
              WHEN resolution_state = 'confirmed' THEN resolution_source
              ELSE ${resolutionSource}
            END
          WHERE market_id = ${marketId} AND outcome = ${tradeOutcome}
        `;
      }

      if (resolutionState === 'confirmed') {
        confirmedCount++;
      } else {
        inferredCount++;
      }

      // Rate limit: don't hammer the API
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const duration = Date.now() - startTime;
    const totalResolved = confirmedCount + inferredCount;
    console.log(`[check-resolutions] Complete: checked=${checkedCount}, confirmed=${confirmedCount}, inferred=${inferredCount}, won=${wonCount}, duration=${duration}ms`);

    return NextResponse.json({
      success: true,
      checked: checkedCount,
      resolved: totalResolved,
      confirmed: confirmedCount,
      inferred: inferredCount,
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
