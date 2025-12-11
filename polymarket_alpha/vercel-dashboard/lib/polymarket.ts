// lib/polymarket.ts
// Data fetching layer for Polymarket Data API and local database

import { sql } from '@vercel/postgres';

export type Trade = {
  id: string;
  wallet: string;
  name: string;
  marketId: string;
  eventSlug: string; // URL-safe slug for polymarket.com/event/{slug}
  title: string;
  outcome: string;
  timestamp: string; // ISO
  price: number;     // 0–1 probability
  size: number;
  realizedPnl?: number;
  settled?: boolean;
  won?: boolean;
  positionStatus?: 'holding' | 'sold' | 'unknown'; // Current position status
};

export type FetchTradesParams = {
  from: Date;
  to: Date;
  minPrice?: number;
  maxPrice?: number;
  minValue?: number;
  wallet?: string;
  limit?: number;
};

export type ClosedPosition = {
  wallet: string;
  conditionId: string;
  title: string;
  outcome: string;
  avgPrice: number;
  curPrice: number;
  realizedPnl: number;
  settled: boolean;
  won: boolean;
};

export type OpenPosition = {
  wallet: string;
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
};

export type WalletProfile = {
  wallet: string;
  name: string;
  totalPnl: number;
  totalPositions: number;
  longshotWins: number;      // Held to settlement and won
  longshotLosses: number;    // Held to settlement and lost
  longshotSoldEarly: number; // Sold before settlement
  longshotPnl: number;
};

const DATA_API = "https://data-api.polymarket.com";

/**
 * Fetch trades from local database (populated by collector script).
 * This gives us reliable 24h coverage instead of API limitations.
 */
export async function fetchTradesFromDB(params: FetchTradesParams): Promise<Trade[]> {
  const { from, to, minPrice = 0, maxPrice = 0.25 } = params;

  const fromTs = Math.floor(from.getTime() / 1000);
  const toTs = Math.floor(to.getTime() / 1000);

  console.log('[fetchTradesFromDB] Starting with params:', { fromTs, toTs, minPrice, maxPrice });
  console.log('[fetchTradesFromDB] POSTGRES_URL exists:', !!process.env.POSTGRES_URL);

  try {
    const result = await sql`
      SELECT id, wallet, name, market_id, event_slug, title, outcome, timestamp, price, size
      FROM trades
      WHERE timestamp >= ${fromTs}
        AND timestamp <= ${toTs}
        AND price >= ${minPrice}
        AND price <= ${maxPrice}
      ORDER BY timestamp DESC
    `;

    console.log('[fetchTradesFromDB] Query returned', result.rows.length, 'rows');

    return result.rows.map((row) => ({
      id: row.id,
      wallet: row.wallet,
      name: row.name || 'Anonymous',
      marketId: row.market_id,
      eventSlug: row.event_slug || '',
      title: row.title || '',
      outcome: row.outcome || '',
      timestamp: new Date(Number(row.timestamp) * 1000).toISOString(),
      price: Number(row.price),
      size: Number(row.size),
      settled: false,
      won: undefined,
    }));
  } catch (err) {
    console.error('[fetchTradesFromDB] Error:', err);
    console.log('[fetchTradesFromDB] Falling back to API');
    // Fallback to API if database fails
    return fetchTrades(params);
  }
}

/**
 * Fetch trades from Polymarket Data API with pagination.
 * Adapts to actual Polymarket schema.
 */
export async function fetchTrades(params: FetchTradesParams): Promise<Trade[]> {
  const { from, to, minValue = 500, maxPrice, limit = 5000 } = params;

  const fromTs = Math.floor(from.getTime() / 1000);
  const toTs = Math.floor(to.getTime() / 1000);

  const allTrades: Trade[] = [];
  let offset = 0;
  const pageSize = 500;
  const maxPages = Math.ceil(limit / pageSize);

  for (let page = 0; page < maxPages; page++) {
    try {
      const url = `${DATA_API}/trades?limit=${pageSize}&offset=${offset}&filterType=CASH&filterAmount=${minValue}&takerOnly=true`;

      const res = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });

      if (!res.ok) {
        console.error(`Polymarket API error: ${res.status}`);
        break;
      }

      const rawTrades = await res.json();

      if (!Array.isArray(rawTrades) || rawTrades.length === 0) {
        break;
      }

      // Filter by time window and map to our Trade type
      for (const t of rawTrades) {
        const ts = t.timestamp ?? 0;
        if (ts < fromTs) continue;
        if (ts > toTs) continue;

        const price = Number(t.price);
        if (maxPrice != null && price > maxPrice) continue;

        // Only BUY trades for longshot analysis
        if (t.side !== "BUY") continue;

        allTrades.push({
          id: String(t.id ?? `${t.proxyWallet}-${ts}`),
          wallet: String(t.proxyWallet ?? ""),
          name: String(t.name ?? t.pseudonym ?? "Anonymous"),
          marketId: String(t.conditionId ?? ""),
          eventSlug: String(t.eventSlug ?? t.slug ?? ""), // URL slug for market links
          title: String(t.title ?? ""),
          outcome: String(t.outcome ?? ""),
          timestamp: new Date(ts * 1000).toISOString(),
          price: price,
          size: Number(t.size ?? 0),
          // Settlement info not directly available from /trades
          // Will be enriched from closed-positions if needed
          settled: false,
          won: undefined,
        });
      }

      // Check if we've gone past the time window
      const oldestTs = Math.min(...rawTrades.map((t: any) => t.timestamp ?? Infinity));
      if (oldestTs < fromTs) {
        break;
      }

      offset += pageSize;

      if (allTrades.length >= limit) {
        break;
      }
    } catch (err) {
      console.error("Error fetching trades:", err);
      break;
    }
  }

  return allTrades.slice(0, limit);
}

/**
 * Fetch closed positions for a wallet to get settlement info.
 */
export async function fetchClosedPositions(wallet: string): Promise<ClosedPosition[]> {
  try {
    const url = `${DATA_API}/closed-positions?user=${wallet}&limit=100&sortBy=REALIZEDPNL&sortDirection=DESC`;

    const res = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      return [];
    }

    const positions = await res.json();

    if (!Array.isArray(positions)) {
      return [];
    }

    return positions.map((p: any) => ({
      wallet,
      conditionId: String(p.conditionId ?? ""),
      title: String(p.title ?? ""),
      outcome: String(p.outcome ?? ""),
      avgPrice: Number(p.avgPrice ?? 0),
      curPrice: Number(p.curPrice ?? 0),
      realizedPnl: Number(p.realizedPnl ?? 0),
      settled: p.curPrice >= 0.99 || p.curPrice <= 0.01,
      won: p.curPrice >= 0.99,
    }));
  } catch (err) {
    console.error("Error fetching closed positions:", err);
    return [];
  }
}

/**
 * Fetch open positions for a wallet to check if they're still holding.
 */
export async function fetchOpenPositions(wallet: string): Promise<OpenPosition[]> {
  try {
    const url = `${DATA_API}/positions?user=${wallet}&limit=100`;

    const res = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      return [];
    }

    const positions = await res.json();

    if (!Array.isArray(positions)) {
      return [];
    }

    // Only return positions with size > 0 (still holding)
    return positions
      .filter((p: any) => Number(p.size ?? 0) > 0)
      .map((p: any) => ({
        wallet,
        conditionId: String(p.conditionId ?? ""),
        title: String(p.title ?? ""),
        outcome: String(p.outcome ?? ""),
        size: Number(p.size ?? 0),
        avgPrice: Number(p.avgPrice ?? 0),
        curPrice: Number(p.curPrice ?? 0),
      }));
  } catch (err) {
    console.error("Error fetching open positions:", err);
    return [];
  }
}

/**
 * Check if a wallet has positions on both sides of a market.
 * Returns a map of marketId -> hedge info
 *
 * Note: Only detects hedges for OPEN positions. If position is closed/sold,
 * we cannot determine if it was hedged.
 */
export async function detectHedgedPositions(
  wallet: string,
  marketIds: string[]
): Promise<Map<string, { hasHedge: boolean; positionFound: boolean; otherOutcome: string; otherSideSize: number; otherSideValue: number }>> {
  const results = new Map<string, { hasHedge: boolean; positionFound: boolean; otherOutcome: string; otherSideSize: number; otherSideValue: number }>();

  // Initialize all markets as not found
  for (const marketId of marketIds) {
    results.set(marketId, {
      hasHedge: false,
      positionFound: false,
      otherOutcome: '',
      otherSideSize: 0,
      otherSideValue: 0,
    });
  }

  try {
    const positions = await fetchOpenPositions(wallet);

    // Group positions by market (conditionId)
    const positionsByMarket = new Map<string, OpenPosition[]>();
    for (const p of positions) {
      const arr = positionsByMarket.get(p.conditionId) ?? [];
      arr.push(p);
      positionsByMarket.set(p.conditionId, arr);
    }

    // Check each market we care about
    for (const marketId of marketIds) {
      const marketPositions = positionsByMarket.get(marketId) ?? [];

      if (marketPositions.length > 1) {
        // Has multiple positions in same market = hedged
        const sorted = marketPositions.sort((a, b) => (b.size * b.avgPrice) - (a.size * a.avgPrice));
        const otherSide = sorted[1];

        results.set(marketId, {
          hasHedge: true,
          positionFound: true,
          otherOutcome: otherSide.outcome,
          otherSideSize: otherSide.size,
          otherSideValue: otherSide.size * otherSide.avgPrice,
        });
      } else if (marketPositions.length === 1) {
        // Single position = not hedged
        results.set(marketId, {
          hasHedge: false,
          positionFound: true,
          otherOutcome: '',
          otherSideSize: 0,
          otherSideValue: 0,
        });
      }
      // If length === 0, keep the default (positionFound: false)
    }
  } catch (err) {
    console.error("Error detecting hedged positions:", err);
  }

  return results;
}

/**
 * Convenience: last 24h longshots (< 25% odds).
 */
export async function fetchLast24hLongshots(now: Date = new Date()): Promise<Trade[]> {
  const to = now;
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);

  return fetchTrades({
    from,
    to,
    maxPrice: 0.25,
  });
}

/**
 * Fetch wallet profile with overall PnL stats.
 * Paginates through ALL closed positions to get accurate total PnL.
 */
export async function fetchWalletProfile(wallet: string): Promise<WalletProfile | null> {
  try {
    // Paginate through ALL closed positions to get accurate PnL
    // IMPORTANT: Do NOT sort by REALIZEDPNL - this biases towards winners!
    // For wallets with >500 positions, sorting by PnL DESC misses losses.
    const positions: any[] = [];
    const pageSize = 500;
    const maxPages = 10; // Cap at 5000 positions to avoid excessive API calls

    for (let page = 0; page < maxPages; page++) {
      const offset = page * pageSize;
      const url = `${DATA_API}/closed-positions?user=${wallet}&limit=${pageSize}&offset=${offset}`;

      const res = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });

      if (!res.ok) {
        if (page === 0) return null; // First page failed
        break; // Later pages failed, use what we have
      }

      const pageData = await res.json();

      if (!Array.isArray(pageData) || pageData.length === 0) {
        break; // No more data
      }

      positions.push(...pageData);

      // If we got less than pageSize, we've fetched everything
      if (pageData.length < pageSize) {
        break;
      }
    }

    if (positions.length === 0) {
      return null;
    }

    let totalPnl = 0;
    let longshotWins = 0;
    let longshotLosses = 0;
    let longshotSoldEarly = 0;
    let longshotPnl = 0;
    let name = "Anonymous";

    for (const p of positions) {
      const pnl = Number(p.realizedPnl ?? 0);
      const avgPrice = Number(p.avgPrice ?? 0);
      const curPrice = Number(p.curPrice ?? 0);
      const size = Number(p.size ?? 0);

      // Market is settled if final price is at extreme (0 or 1)
      const settled = curPrice >= 0.99 || curPrice <= 0.01;
      const outcomeWon = curPrice >= 0.99;

      totalPnl += pnl;

      if (p.name && p.name !== "Anonymous") {
        name = p.name;
      }

      // Track longshot stats (entry < 25%)
      if (avgPrice < 0.25) {
        longshotPnl += pnl;

        if (settled) {
          // Market has resolved - check if they held or sold early
          // Expected PnL if held to settlement:
          // - If won: size * (1 - avgPrice) = profit from $1 payout minus cost
          // - If lost: -size * avgPrice = lost their stake
          const expectedPnlIfHeld = outcomeWon
            ? size * (1 - avgPrice)  // Won: get $1 per share minus cost
            : -size * avgPrice;       // Lost: lose entire stake

          // If actual PnL is significantly different from expected, they sold early
          // Use 20% tolerance to account for fees and rounding
          const tolerance = Math.abs(expectedPnlIfHeld) * 0.2 + 1; // 20% or $1 minimum
          const soldEarly = Math.abs(pnl - expectedPnlIfHeld) > tolerance;

          if (soldEarly) {
            longshotSoldEarly++;
          } else if (outcomeWon) {
            longshotWins++;
          } else {
            longshotLosses++;
          }
        } else {
          // Market not settled yet but position is closed = sold early
          longshotSoldEarly++;
        }
      }
    }

    // Also fetch open positions and calculate unrealized PnL
    // This is critical - without it, we only count realized gains and miss unrealized losses
    const openPositions = await fetchOpenPositions(wallet);
    let unrealizedPnl = 0;
    for (const pos of openPositions) {
      // Unrealized PnL = size * (current price - entry price)
      unrealizedPnl += pos.size * (pos.curPrice - pos.avgPrice);
    }
    totalPnl += unrealizedPnl;

    return {
      wallet,
      name,
      totalPnl,
      totalPositions: positions.length,
      longshotWins,
      longshotLosses,
      longshotSoldEarly,
      longshotPnl,
    };
  } catch (err) {
    console.error("Error fetching wallet profile:", err);
    return null;
  }
}

/**
 * Enrich trades with settlement info from closed positions.
 * Groups by wallet and fetches their closed positions.
 */
export async function enrichTradesWithSettlement(trades: Trade[]): Promise<Trade[]> {
  // Get unique wallets
  const wallets = Array.from(new Set(trades.map((t) => t.wallet)));

  // Fetch closed positions for each wallet (limit to top 20 by volume to avoid rate limits)
  const walletVolume = new Map<string, number>();
  for (const t of trades) {
    walletVolume.set(t.wallet, (walletVolume.get(t.wallet) ?? 0) + t.price * t.size);
  }

  const topWallets = Array.from(walletVolume.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w);

  // Build a map of wallet -> closed positions
  const positionsByWallet = new Map<string, ClosedPosition[]>();
  for (const wallet of topWallets) {
    const positions = await fetchClosedPositions(wallet);
    positionsByWallet.set(wallet, positions);
  }

  // Enrich trades with settlement data
  return trades.map((t) => {
    const positions = positionsByWallet.get(t.wallet) ?? [];

    // Find a matching position by conditionId (marketId) and outcome
    const match = positions.find(
      (p) =>
        p.conditionId === t.marketId &&
        p.outcome === t.outcome
    );

    if (match) {
      return {
        ...t,
        settled: match.settled,
        won: match.won,
        realizedPnl: match.realizedPnl,
      };
    }

    return t;
  });
}

/**
 * Fetch wallet profiles for multiple wallets.
 */
export async function fetchWalletProfiles(wallets: string[]): Promise<Map<string, WalletProfile>> {
  const profiles = new Map<string, WalletProfile>();

  // Limit to avoid rate limits
  const walletsToFetch = wallets.slice(0, 30);

  for (const wallet of walletsToFetch) {
    const profile = await fetchWalletProfile(wallet);
    if (profile) {
      profiles.set(wallet, profile);
    }
  }

  return profiles;
}

/**
 * Fetch the last trade timestamp for a wallet.
 * Returns the timestamp of their most recent trade (before the current window).
 */
export async function fetchWalletLastActivity(wallet: string, beforeDate?: Date): Promise<Date | null> {
  try {
    // Fetch recent trades for the wallet
    const url = `${DATA_API}/activity?user=${wallet}&limit=10&sortBy=TIMESTAMP&sortDirection=DESC`;

    const res = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      return null;
    }

    const activities = await res.json();

    if (!Array.isArray(activities) || activities.length === 0) {
      return null;
    }

    // Find the most recent activity that's before the current window
    const beforeTs = beforeDate ? Math.floor(beforeDate.getTime() / 1000) : Infinity;

    for (const activity of activities) {
      const ts = Number(activity.timestamp ?? 0);
      if (ts > 0 && ts < beforeTs) {
        return new Date(ts * 1000);
      }
    }

    // If all activities are in current window, return the oldest one
    const oldestTs = Math.min(...activities.map((a: any) => Number(a.timestamp ?? Infinity)));
    if (oldestTs < Infinity) {
      return new Date(oldestTs * 1000);
    }

    return null;
  } catch (err) {
    console.error("Error fetching wallet last activity:", err);
    return null;
  }
}

/**
 * Fetch last activity for multiple wallets.
 */
export async function fetchWalletsLastActivity(
  wallets: string[],
  beforeDate?: Date
): Promise<Map<string, Date>> {
  const results = new Map<string, Date>();

  // Limit to avoid rate limits
  const walletsToFetch = wallets.slice(0, 30);

  for (const wallet of walletsToFetch) {
    const lastActivity = await fetchWalletLastActivity(wallet, beforeDate);
    if (lastActivity) {
      results.set(wallet, lastActivity);
    }
  }

  return results;
}
