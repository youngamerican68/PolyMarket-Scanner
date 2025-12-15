// app/api/collect-trades/route.ts
// Cron job to collect longshot trades from Polymarket API
// Runs every 30 minutes via Vercel cron

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Allow up to 60 seconds for this job

const DATA_API = "https://data-api.polymarket.com";

interface RawTrade {
  id: string;
  proxyWallet: string;
  name?: string;
  pseudonym?: string;
  conditionId: string;
  eventSlug?: string;
  slug?: string;
  title?: string;
  outcome?: string;
  outcomeIndex?: number;
  asset?: string; // Token ID - stable unique identifier per outcome
  timestamp: number;
  price: number;
  size: number;
  side: string;
  transactionHash?: string;
}

async function fetchRecentTrades(): Promise<RawTrade[]> {
  const allTrades: RawTrade[] = [];
  const pageSize = 500;
  const maxPages = 20; // 10,000 trades max per run (increased from 10)

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const url = `${DATA_API}/trades?limit=${pageSize}&offset=${offset}&filterType=CASH&filterAmount=100&takerOnly=true`;

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });

      if (!res.ok) {
        console.error(`API error: ${res.status}`);
        break;
      }

      const trades = await res.json();

      if (!Array.isArray(trades) || trades.length === 0) {
        break;
      }

      // Filter to longshots (<25% odds) and BUY only
      const longshots = trades.filter(
        (t: RawTrade) => t.price < 0.25 && t.side === "BUY"
      );

      allTrades.push(...longshots);
      console.log(
        `Page ${page + 1}: fetched ${trades.length} trades, ${longshots.length} longshots`
      );

      // If we got less than pageSize, we've hit the end
      if (trades.length < pageSize) {
        break;
      }
    } catch (err) {
      console.error(`Error fetching page ${page}:`, err);
      break;
    }
  }

  return allTrades;
}

async function storeTrades(trades: RawTrade[]): Promise<{
  inserted: number;
  legacyIdCount: number;
  legacyIdSamples: string[];
  missingAssetCount: number;
  missingAssetSamples: string[];
}> {
  let inserted = 0;
  let legacyIdCount = 0;
  let missingAssetCount = 0;
  const legacyIdSamples: string[] = []; // Collect up to 3 samples for debugging
  const missingAssetSamples: string[] = []; // Track missing asset separately

  for (const t of trades) {
    try {
      // Normalize asset: trim whitespace, ensure string
      const normalizedAsset = t.asset ? String(t.asset).trim() : null;

      // Use transactionHash + asset (tokenId) as unique trade ID
      // transactionHash is blockchain-unique, asset is the immutable token ID
      // asset is more stable than outcomeIndex or outcome display label
      let tradeId: string;
      if (t.transactionHash && normalizedAsset) {
        tradeId = `${t.transactionHash}_${normalizedAsset}`;
      } else if (t.transactionHash) {
        // MISSING ASSET FALLBACK: Has txHash but no asset - track this regression
        tradeId = `${t.transactionHash}_${t.outcomeIndex ?? 0}`;
        missingAssetCount++;
        if (missingAssetSamples.length < 3) {
          missingAssetSamples.push(`txHash=${t.transactionHash.slice(0,10)}...`);
        }
        console.warn(`[MISSING_ASSET] Has transactionHash but missing asset: txHash=${t.transactionHash.slice(0,10)}, market=${t.conditionId.slice(0,10)}`);
      } else {
        // LEGACY FALLBACK: Missing transactionHash entirely - this shouldn't happen
        tradeId = `${t.proxyWallet}-${t.conditionId}-${t.timestamp}-${Math.round(t.size)}`;
        legacyIdCount++;
        if (legacyIdSamples.length < 3) {
          legacyIdSamples.push(tradeId);
        }
        console.warn(`[LEGACY_ID] Missing transactionHash for trade: wallet=${t.proxyWallet.slice(0,10)}, market=${t.conditionId.slice(0,10)}, ts=${t.timestamp}`);
      }

      // Use INSERT ... ON CONFLICT DO NOTHING to skip duplicates
      const result = await sql`
        INSERT INTO trades (id, wallet, name, market_id, event_slug, title, outcome, timestamp, price, size)
        VALUES (
          ${tradeId},
          ${t.proxyWallet},
          ${t.name || t.pseudonym || "Anonymous"},
          ${t.conditionId},
          ${t.eventSlug || t.slug || ""},
          ${t.title || ""},
          ${t.outcome || ""},
          ${t.timestamp},
          ${t.price},
          ${t.size}
        )
        ON CONFLICT (id) DO NOTHING
      `;

      if (result.rowCount && result.rowCount > 0) {
        inserted++;
      }
    } catch (err) {
      // Skip errors for individual trades
      console.error(`Error inserting trade:`, err);
    }
  }

  if (missingAssetCount > 0) {
    console.warn(`[MISSING_ASSET_SUMMARY] ${missingAssetCount} trades missing asset field (using outcomeIndex fallback)`);
    console.warn(`[MISSING_ASSET_SAMPLES] ${missingAssetSamples.join(', ')}`);
  }

  if (legacyIdCount > 0) {
    console.warn(`[LEGACY_ID_SUMMARY] ${legacyIdCount} trades used legacy ID format (missing transactionHash)`);
    console.warn(`[LEGACY_ID_SAMPLES] ${legacyIdSamples.join(', ')}`);
  }

  return { inserted, legacyIdCount, legacyIdSamples, missingAssetCount, missingAssetSamples };
}

async function pruneOldTrades(): Promise<number> {
  // Delete trades older than 48 hours
  const cutoffTimestamp = Math.floor(Date.now() / 1000) - 48 * 60 * 60;

  const result = await sql`
    DELETE FROM trades WHERE timestamp < ${cutoffTimestamp}
  `;

  return result.rowCount || 0;
}

// Store qualifying longshots ($5K+, <25% odds) to permanent history
// Aggregates trades by wallet+market+outcome to catch positions built from multiple small trades
async function storeToHistory(trades: RawTrade[]): Promise<number> {
  let inserted = 0;
  const MIN_VALUE = 2500; // $2.5K minimum

  // Aggregate trades by wallet + market + outcome
  const aggregated = new Map<string, {
    wallet: string;
    name: string;
    marketId: string;
    eventSlug: string;
    title: string;
    outcome: string;
    totalSize: number;
    totalValue: number;
    latestTimestamp: number;
    avgPrice: number;
  }>();

  for (const t of trades) {
    const key = `${t.proxyWallet}:${t.conditionId}:${t.outcome}`;
    const value = t.price * t.size;
    const existing = aggregated.get(key);

    if (existing) {
      existing.totalSize += t.size;
      existing.totalValue += value;
      existing.avgPrice = existing.totalValue / existing.totalSize;
      if (t.timestamp > existing.latestTimestamp) {
        existing.latestTimestamp = t.timestamp;
      }
    } else {
      aggregated.set(key, {
        wallet: t.proxyWallet,
        name: t.name || t.pseudonym || "Anonymous",
        marketId: t.conditionId,
        eventSlug: t.eventSlug || t.slug || "",
        title: t.title || "",
        outcome: t.outcome || "",
        totalSize: t.size,
        totalValue: value,
        latestTimestamp: t.timestamp,
        avgPrice: t.price,
      });
    }
  }

  // Store aggregated positions that meet $5K threshold
  const positions = Array.from(aggregated.values());
  for (const pos of positions) {
    if (pos.totalValue < MIN_VALUE) continue;

    try {
      // Use wallet + market + outcome as the unique ID (no timestamp - position identity only)
      const tradeId = `${pos.wallet}-${pos.marketId}-${pos.outcome}`;

      const result = await sql`
        INSERT INTO longshot_history (id, wallet, name, market_id, event_slug, title, outcome, timestamp, price, size, value)
        VALUES (
          ${tradeId},
          ${pos.wallet},
          ${pos.name},
          ${pos.marketId},
          ${pos.eventSlug},
          ${pos.title},
          ${pos.outcome},
          ${pos.latestTimestamp},
          ${pos.avgPrice},
          ${pos.totalSize},
          ${pos.totalValue}
        )
        ON CONFLICT (id) DO UPDATE SET
          timestamp = EXCLUDED.timestamp,
          price = EXCLUDED.price,
          size = EXCLUDED.size,
          value = EXCLUDED.value
      `;

      if (result.rowCount && result.rowCount > 0) {
        inserted++;
        console.log(`[history] Saved: ${pos.name} - ${pos.title?.slice(0, 30)} @ ${(pos.avgPrice * 100).toFixed(1)}% = $${pos.totalValue.toFixed(0)}`);
      }
    } catch (err) {
      console.error(`Error inserting to history:`, err);
    }
  }

  return inserted;
}

// Update whale watchlist with wallet addresses when we see matching names
async function updateWhaleWatchlistMappings(trades: RawTrade[]): Promise<number> {
  let updated = 0;

  // Get all watchlist names that are missing wallets
  const pendingResult = await sql`
    SELECT name FROM whale_watchlist WHERE wallet IS NULL
  `;
  const pendingNames = new Set(pendingResult.rows.map(r => r.name.toLowerCase()));

  if (pendingNames.size === 0) return 0;

  for (const t of trades) {
    const name = t.name || t.pseudonym;
    if (!name) continue;

    if (pendingNames.has(name.toLowerCase())) {
      try {
        const result = await sql`
          UPDATE whale_watchlist
          SET wallet = ${t.proxyWallet}
          WHERE LOWER(name) = ${name.toLowerCase()} AND wallet IS NULL
        `;
        if (result.rowCount && result.rowCount > 0) {
          updated++;
          console.log(`[whale-watchlist] Linked wallet for ${name}: ${t.proxyWallet}`);
          pendingNames.delete(name.toLowerCase());
        }
      } catch (err) {
        console.error(`Error updating whale watchlist:`, err);
      }
    }
  }

  return updated;
}

// Store longshot trades from whale watchlist wallets
async function storeWhaleTrades(trades: RawTrade[]): Promise<number> {
  let stored = 0;

  // Get all whale watchlist wallets with their metadata
  const watchlistResult = await sql`
    SELECT wallet, name, tier, category FROM whale_watchlist WHERE wallet IS NOT NULL
  `;
  const whaleWallets = new Map(
    watchlistResult.rows.map(r => [r.wallet.toLowerCase(), { name: r.name, tier: r.tier, category: r.category }])
  );

  if (whaleWallets.size === 0) return 0;

  for (const t of trades) {
    const whaleInfo = whaleWallets.get(t.proxyWallet.toLowerCase());
    if (!whaleInfo) continue;

    try {
      // Normalize asset: trim whitespace, ensure string
      const normalizedAsset = t.asset ? String(t.asset).trim() : null;

      // Use transactionHash + asset (tokenId) as unique trade ID
      let tradeId: string;
      if (t.transactionHash && normalizedAsset) {
        tradeId = `${t.transactionHash}_${normalizedAsset}`;
      } else if (t.transactionHash) {
        tradeId = `${t.transactionHash}_${t.outcomeIndex ?? 0}`;
        console.warn(`[MISSING_ASSET] Whale trade missing asset: txHash=${t.transactionHash.slice(0,10)}`);
      } else {
        tradeId = `${t.proxyWallet}-${t.conditionId}-${t.timestamp}-${Math.round(t.size)}`;
        console.warn(`[LEGACY_ID] Missing transactionHash for whale trade: wallet=${t.proxyWallet.slice(0,10)}, ts=${t.timestamp}`);
      }
      const value = t.price * t.size;

      const result = await sql`
        INSERT INTO whale_trades (id, wallet, name, whale_tier, whale_category, market_id, event_slug, title, outcome, timestamp, price, size, value)
        VALUES (
          ${tradeId},
          ${t.proxyWallet},
          ${t.name || t.pseudonym || whaleInfo.name},
          ${whaleInfo.tier},
          ${whaleInfo.category},
          ${t.conditionId},
          ${t.eventSlug || t.slug || ""},
          ${t.title || ""},
          ${t.outcome || ""},
          ${t.timestamp},
          ${t.price},
          ${t.size},
          ${value}
        )
        ON CONFLICT (id) DO NOTHING
      `;

      if (result.rowCount && result.rowCount > 0) {
        stored++;
        console.log(`[whale-trade] ${whaleInfo.name} (${whaleInfo.tier}): ${t.title?.slice(0, 30)} @ ${(t.price * 100).toFixed(1)}% = $${value.toFixed(0)}`);
      }
    } catch (err) {
      console.error(`Error storing whale trade:`, err);
    }
  }

  return stored;
}

// Aggregate trades from DB and save qualifying positions to history
// This catches positions built from multiple smaller trades across different API fetches
async function syncHistoryFromDb(): Promise<number> {
  const MIN_VALUE = 2500; // $2.5K minimum
  const cutoff24h = Math.floor(Date.now() / 1000) - 24 * 60 * 60;

  // Get aggregated positions from trades table (last 24h)
  // IMPORTANT: Only GROUP BY wallet, market_id, outcome to match real-time aggregation
  // Use MAX() for display fields (name, event_slug, title) since they may vary across trades
  const result = await sql`
    SELECT
      wallet,
      MAX(name) as name,
      market_id,
      MAX(event_slug) as event_slug,
      MAX(title) as title,
      outcome,
      SUM(size) as total_size,
      SUM(price * size) as total_value,
      SUM(price * size) / SUM(size) as avg_price,
      MAX(timestamp) as latest_timestamp
    FROM trades
    WHERE timestamp >= ${cutoff24h}
    GROUP BY wallet, market_id, outcome
    HAVING SUM(price * size) >= ${MIN_VALUE}
  `;

  let inserted = 0;

  for (const row of result.rows) {
    try {
      // Use wallet + market + outcome as unique ID (no timestamp - position identity only)
      const tradeId = `${row.wallet}-${row.market_id}-${row.outcome}`;

      const insertResult = await sql`
        INSERT INTO longshot_history (id, wallet, name, market_id, event_slug, title, outcome, timestamp, price, size, value)
        VALUES (
          ${tradeId},
          ${row.wallet},
          ${row.name},
          ${row.market_id},
          ${row.event_slug},
          ${row.title},
          ${row.outcome},
          ${row.latest_timestamp},
          ${Number(row.avg_price)},
          ${Number(row.total_size)},
          ${Number(row.total_value)}
        )
        ON CONFLICT (id) DO UPDATE SET
          timestamp = EXCLUDED.timestamp,
          price = EXCLUDED.price,
          size = EXCLUDED.size,
          value = EXCLUDED.value
      `;

      if (insertResult.rowCount && insertResult.rowCount > 0) {
        inserted++;
        console.log(`[history-sync] Saved: ${row.name} - ${row.title?.slice(0, 30)} @ ${(Number(row.avg_price) * 100).toFixed(1)}% = $${Number(row.total_value).toFixed(0)}`);
      }
    } catch (err) {
      console.error(`Error syncing to history:`, err);
    }
  }

  return inserted;
}

export async function GET() {
  const startTime = Date.now();

  try {
    console.log("Starting trade collection...");
    console.log(`Time: ${new Date().toISOString()}`);

    // Fetch recent trades
    const trades = await fetchRecentTrades();
    console.log(`Fetched ${trades.length} longshot trades total`);

    // Store in database
    const { inserted, legacyIdCount, legacyIdSamples, missingAssetCount, missingAssetSamples } = await storeTrades(trades);
    console.log(`Inserted ${inserted} new trades${legacyIdCount > 0 ? ` (${legacyIdCount} legacy ID)` : ''}${missingAssetCount > 0 ? ` (${missingAssetCount} missing asset)` : ''}`);

    // Update whale watchlist with wallet mappings
    const whaleWalletsLinked = await updateWhaleWatchlistMappings(trades);
    console.log(`Linked ${whaleWalletsLinked} whale wallet mappings`);

    // Store whale trades
    const whaleTradesStored = await storeWhaleTrades(trades);
    console.log(`Stored ${whaleTradesStored} whale trades`);

    // Store qualifying trades to permanent history (from fresh API data)
    const historyInserted = await storeToHistory(trades);
    console.log(`Inserted ${historyInserted} trades to history from API`);

    // Also sync aggregated positions from DB to history
    // This catches positions built from multiple smaller trades
    const historySynced = await syncHistoryFromDb();
    console.log(`Synced ${historySynced} additional trades to history from DB aggregation`);

    // Prune old trades (from rolling 48h table only)
    const pruned = await pruneOldTrades();
    console.log(`Pruned ${pruned} old trades`);

    // Report current state
    const countResult = await sql`SELECT COUNT(*) as count FROM trades`;
    const totalTrades = countResult.rows[0].count;
    console.log(`Database now has ${totalTrades} trades`);

    const historyCountResult = await sql`SELECT COUNT(*) as count FROM longshot_history`;
    const historyTotal = historyCountResult.rows[0].count;
    console.log(`History has ${historyTotal} longshot trades`);

    // Get whale stats
    let whaleWatchlistTotal = 0;
    let whaleTradesTotal = 0;
    try {
      const whaleWatchlistResult = await sql`SELECT COUNT(*) as count FROM whale_watchlist`;
      whaleWatchlistTotal = Number(whaleWatchlistResult.rows[0].count);
      const whaleTradesResult = await sql`SELECT COUNT(*) as count FROM whale_trades`;
      whaleTradesTotal = Number(whaleTradesResult.rows[0].count);
    } catch {
      // Tables may not exist yet
    }

    const duration = Date.now() - startTime;

    return NextResponse.json({
      success: true,
      fetched: trades.length,
      inserted,
      // Data quality metrics - all should be 0 in normal operation
      legacyIdCount, // Missing transactionHash entirely
      legacyIdSamples, // Sample IDs for debugging (max 3)
      missingAssetCount, // Has txHash but missing asset field
      missingAssetSamples, // Sample txHashes for debugging (max 3)
      whaleWalletsLinked,
      whaleTradesStored,
      historyInserted,
      historySynced,
      pruned,
      totalInDb: totalTrades,
      historyTotal,
      whaleWatchlistTotal,
      whaleTradesTotal,
      durationMs: duration,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Error in collect-trades:", err);
    return NextResponse.json(
      { error: "Failed to collect trades", details: String(err) },
      { status: 500 }
    );
  }
}
// trigger redeploy Fri Dec 12 16:04:45 EST 2025
