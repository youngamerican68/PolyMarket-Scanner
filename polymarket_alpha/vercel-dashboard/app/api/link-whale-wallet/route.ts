// app/api/link-whale-wallet/route.ts
// Manually link a wallet address to a username in the watchlist

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, wallet } = body;

    if (!name || !wallet) {
      return NextResponse.json(
        { error: "Both 'name' and 'wallet' are required" },
        { status: 400 }
      );
    }

    // Validate wallet format
    if (!wallet.match(/^0x[a-fA-F0-9]{40}$/)) {
      return NextResponse.json(
        { error: "Invalid wallet address format" },
        { status: 400 }
      );
    }

    // Update the watchlist entry
    const result = await sql`
      UPDATE whale_watchlist
      SET wallet = ${wallet.toLowerCase()}
      WHERE LOWER(name) = ${name.toLowerCase()}
      RETURNING name, wallet, tier, category
    `;

    if (result.rowCount === 0) {
      return NextResponse.json(
        { error: `No watchlist entry found for name: ${name}` },
        { status: 404 }
      );
    }

    // Get updated stats
    const statsResult = await sql`
      SELECT
        COUNT(*) as total,
        COUNT(wallet) as with_wallet,
        COUNT(*) - COUNT(wallet) as pending_wallet
      FROM whale_watchlist
    `;

    return NextResponse.json({
      success: true,
      updated: result.rows[0],
      stats: statsResult.rows[0],
    });
  } catch (err) {
    console.error("Error linking wallet:", err);
    return NextResponse.json(
      { error: "Failed to link wallet", details: String(err) },
      { status: 500 }
    );
  }
}

// Delete a watchlist entry by name
export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const { name } = body;

    if (!name) {
      return NextResponse.json(
        { error: "'name' is required" },
        { status: 400 }
      );
    }

    const result = await sql`
      DELETE FROM whale_watchlist
      WHERE name = ${name}
      RETURNING name, wallet
    `;

    if (result.rowCount === 0) {
      return NextResponse.json(
        { error: `No entry found for name: ${name}` },
        { status: 404 }
      );
    }

    // Get updated stats
    const statsResult = await sql`
      SELECT
        COUNT(*) as total,
        COUNT(wallet) as with_wallet,
        COUNT(*) - COUNT(wallet) as pending_wallet
      FROM whale_watchlist
    `;

    return NextResponse.json({
      success: true,
      deleted: result.rows[0],
      stats: statsResult.rows[0],
    });
  } catch (err) {
    console.error("Error deleting entry:", err);
    return NextResponse.json(
      { error: "Failed to delete entry", details: String(err) },
      { status: 500 }
    );
  }
}

// Batch update multiple wallets
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { wallets } = body; // Array of { name, wallet }

    if (!Array.isArray(wallets) || wallets.length === 0) {
      return NextResponse.json(
        { error: "Provide 'wallets' array of { name, wallet } objects" },
        { status: 400 }
      );
    }

    let updated = 0;
    const results: { name: string; wallet: string; status: string }[] = [];

    for (const entry of wallets) {
      const { name, wallet } = entry;
      if (!name || !wallet) continue;

      try {
        const result = await sql`
          UPDATE whale_watchlist
          SET wallet = ${wallet.toLowerCase()}
          WHERE LOWER(name) = ${name.toLowerCase()} AND wallet IS NULL
          RETURNING name
        `;

        if (result.rowCount && result.rowCount > 0) {
          updated++;
          results.push({ name, wallet, status: "linked" });
        } else {
          results.push({ name, wallet, status: "not found or already linked" });
        }
      } catch (err) {
        results.push({ name, wallet, status: `error: ${String(err)}` });
      }
    }

    // Get updated stats
    const statsResult = await sql`
      SELECT
        COUNT(*) as total,
        COUNT(wallet) as with_wallet,
        COUNT(*) - COUNT(wallet) as pending_wallet
      FROM whale_watchlist
    `;

    return NextResponse.json({
      success: true,
      processed: wallets.length,
      updated,
      results,
      stats: statsResult.rows[0],
    });
  } catch (err) {
    console.error("Error batch linking wallets:", err);
    return NextResponse.json(
      { error: "Failed to batch link wallets", details: String(err) },
      { status: 500 }
    );
  }
}
