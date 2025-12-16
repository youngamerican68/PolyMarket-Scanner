// app/api/backfill-whale-wallets/route.ts
// One-time backfill to look up wallet addresses for unlinked whales

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const GAMMA_API = "https://gamma-api.polymarket.com";

// Look up a user's wallet address by username via Polymarket's Gamma API
async function lookupWalletByUsername(username: string): Promise<string | null> {
  try {
    // Try the leaderboard/profile search endpoint
    const searchRes = await fetch(
      `${GAMMA_API}/users?username=${encodeURIComponent(username)}`,
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      }
    );

    if (searchRes.ok) {
      const data = await searchRes.json();
      // Response could be array or single object
      if (Array.isArray(data) && data.length > 0) {
        const user = data.find(
          (u: { username?: string }) => u.username?.toLowerCase() === username.toLowerCase()
        );
        if (user?.proxyWallet || user?.address || user?.wallet) {
          return user.proxyWallet || user.address || user.wallet;
        }
      } else if (data?.proxyWallet || data?.address || data?.wallet) {
        return data.proxyWallet || data.address || data.wallet;
      }
    }

    // Try alternate endpoint - direct username lookup
    const directRes = await fetch(
      `${GAMMA_API}/profiles/${encodeURIComponent(username)}`,
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      }
    );

    if (directRes.ok) {
      const data = await directRes.json();
      if (data?.proxyWallet || data?.address || data?.wallet) {
        return data.proxyWallet || data.address || data.wallet;
      }
    }

    return null;
  } catch (err) {
    console.error(`Error looking up wallet for ${username}:`, err);
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get("limit")) || 20, 50);
  const dryRun = searchParams.get("dry") === "true";

  try {
    // Get unlinked whales, prioritized by tier
    const unlinkedResult = await sql`
      SELECT name, tier, category, profit
      FROM whale_watchlist
      WHERE wallet IS NULL
      ORDER BY
        CASE tier
          WHEN 'whale' THEN 1
          WHEN 'shark' THEN 2
          WHEN 'dolphin' THEN 3
          ELSE 4
        END,
        created_at ASC
      LIMIT ${limit}
    `;

    const unlinked = unlinkedResult.rows;
    console.log(`[backfill] Found ${unlinked.length} unlinked whales to process`);

    const results: {
      name: string;
      tier: string;
      wallet: string | null;
      status: string;
    }[] = [];

    let linked = 0;
    let notFound = 0;

    for (const entry of unlinked) {
      const wallet = await lookupWalletByUsername(entry.name);

      if (wallet) {
        if (!dryRun) {
          await sql`
            UPDATE whale_watchlist
            SET wallet = ${wallet}
            WHERE name = ${entry.name} AND wallet IS NULL
          `;
        }
        linked++;
        results.push({
          name: entry.name,
          tier: entry.tier,
          wallet,
          status: dryRun ? "found (dry run)" : "linked",
        });
        console.log(`[backfill] Linked ${entry.name} -> ${wallet}`);
      } else {
        notFound++;
        results.push({
          name: entry.name,
          tier: entry.tier,
          wallet: null,
          status: "not found",
        });
        console.log(`[backfill] Not found: ${entry.name}`);
      }

      // Small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Get updated stats
    const statsResult = await sql`
      SELECT
        COUNT(*) as total,
        COUNT(wallet) as with_wallet,
        COUNT(*) - COUNT(wallet) as pending_wallet
      FROM whale_watchlist
    `;
    const stats = statsResult.rows[0];

    return NextResponse.json({
      success: true,
      processed: unlinked.length,
      linked,
      notFound,
      dryRun,
      results,
      stats: {
        total: Number(stats.total),
        withWallet: Number(stats.with_wallet),
        pendingWallet: Number(stats.pending_wallet),
      },
    });
  } catch (err) {
    console.error("Error in backfill:", err);
    return NextResponse.json(
      { error: "Failed to backfill wallets", details: String(err) },
      { status: 500 }
    );
  }
}
