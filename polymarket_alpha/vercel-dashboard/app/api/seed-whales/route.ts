// app/api/seed-whales/route.ts
// Populate whale_watchlist from ScanWhale data

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface WhaleEntry {
  name: string;
  wallet: string | null;
  tier: string;
  category: string;
  profit: string;
}

// Parse ScanWhale data format
// Each entry is ~11 lines:
// 0: Initials (2 chars like "BE")
// 1: Username or wallet address
// 2: Category (SPORTS, CRYPTO, etc)
// 3: Emoji (🐋, 🦈, 🐬)
// 4: Tier (WHALE, SHARK, DOLPHIN)
// 5: Code (SNP, ACC, VHT, SAF)
// 6: Profit (+$667K)
// 7: Volume ($1.2M)
// 8: Win rate (100%)
// 9: Indicator (MED)
// 10: Number (02)
function parseScanWhaleData(rawText: string): WhaleEntry[] {
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const entries: WhaleEntry[] = [];

  let i = 0;
  while (i < lines.length) {
    // Look for a line that's 2 characters (initials) or "profile" suffix
    const line = lines[i];

    // Skip if this looks like a header or navigation
    if (line.includes('profile') && i + 1 < lines.length) {
      // The name is before "profile", extract it
      const namePart = line.replace(' profile', '').trim();
      i++;
      // Continue to find category
    }

    // Check if this is initials (2 chars uppercase or number+letter)
    const isInitials = line.length <= 3 && /^[A-Z0-9.-]+$/i.test(line);

    if (isInitials && i + 6 < lines.length) {
      const nameOrWallet = lines[i + 1];
      const category = lines[i + 2];
      // Skip emoji at i+3
      const tierRaw = lines[i + 4];
      // Skip code at i+5
      const profit = lines[i + 6];

      // Determine if it's a wallet address or username
      const isWallet = nameOrWallet.toLowerCase().startsWith('0x');

      // Validate this looks like real data
      const validCategories = ['SPORTS', 'CRYPTO', 'POLITICS', 'CULTURE', 'TECH', 'ECONOMICS', 'FINANCE'];
      const validTiers = ['WHALE', 'SHARK', 'DOLPHIN', 'FISH'];

      if (validCategories.includes(category.toUpperCase()) && validTiers.includes(tierRaw.toUpperCase())) {
        entries.push({
          name: isWallet ? nameOrWallet.split('-')[0] : nameOrWallet, // Remove timestamp suffix from wallet names
          wallet: isWallet ? nameOrWallet.split('-')[0] : null,
          tier: tierRaw.toLowerCase(),
          category: category.toLowerCase(),
          profit: profit,
        });
        i += 11; // Skip to next entry
        continue;
      }
    }

    i++;
  }

  return entries;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const rawData = body.data as string;

    if (!rawData) {
      return NextResponse.json(
        { error: "No data provided. Send { data: '...' } with ScanWhale text" },
        { status: 400 }
      );
    }

    // Parse the data
    const entries = parseScanWhaleData(rawData);

    if (entries.length === 0) {
      return NextResponse.json(
        { error: "No valid entries parsed from data", rawLength: rawData.length },
        { status: 400 }
      );
    }

    // Insert entries
    let inserted = 0;
    let updated = 0;
    const errors: string[] = [];

    for (const entry of entries) {
      try {
        const result = await sql`
          INSERT INTO whale_watchlist (wallet, name, tier, category, profit)
          VALUES (${entry.wallet}, ${entry.name}, ${entry.tier}, ${entry.category}, ${entry.profit})
          ON CONFLICT (name) DO UPDATE SET
            wallet = COALESCE(whale_watchlist.wallet, EXCLUDED.wallet),
            tier = EXCLUDED.tier,
            category = EXCLUDED.category,
            profit = EXCLUDED.profit
        `;

        if (result.rowCount && result.rowCount > 0) {
          if (entry.wallet) {
            updated++;
          } else {
            inserted++;
          }
        }
      } catch (err) {
        errors.push(`${entry.name}: ${String(err)}`);
      }
    }

    // Get current counts
    const totalResult = await sql`SELECT COUNT(*) as count FROM whale_watchlist`;
    const withWalletResult = await sql`SELECT COUNT(*) as count FROM whale_watchlist WHERE wallet IS NOT NULL`;

    return NextResponse.json({
      success: true,
      parsed: entries.length,
      inserted,
      updated,
      errors: errors.slice(0, 5), // First 5 errors only
      total: Number(totalResult.rows[0].count),
      withWallet: Number(withWalletResult.rows[0].count),
      pendingWallet: Number(totalResult.rows[0].count) - Number(withWalletResult.rows[0].count),
      sampleEntries: entries.slice(0, 5),
    });
  } catch (err) {
    console.error("Error seeding whales:", err);
    return NextResponse.json(
      { error: "Failed to seed whales", details: String(err) },
      { status: 500 }
    );
  }
}

// GET to view current watchlist
export async function GET() {
  try {
    const result = await sql`
      SELECT * FROM whale_watchlist
      ORDER BY
        CASE tier
          WHEN 'whale' THEN 1
          WHEN 'shark' THEN 2
          WHEN 'dolphin' THEN 3
          ELSE 4
        END,
        profit DESC
      LIMIT 200
    `;

    const stats = await sql`
      SELECT
        COUNT(*) as total,
        COUNT(wallet) as with_wallet,
        COUNT(*) - COUNT(wallet) as pending_wallet,
        COUNT(CASE WHEN tier = 'whale' THEN 1 END) as whales,
        COUNT(CASE WHEN tier = 'shark' THEN 1 END) as sharks,
        COUNT(CASE WHEN tier = 'dolphin' THEN 1 END) as dolphins
      FROM whale_watchlist
    `;

    return NextResponse.json({
      entries: result.rows,
      stats: stats.rows[0],
    });
  } catch (err) {
    console.error("Error fetching watchlist:", err);
    return NextResponse.json(
      { error: "Failed to fetch watchlist", details: String(err) },
      { status: 500 }
    );
  }
}
