// lib/polymarket.ts
// Data fetching layer for Polymarket Data API

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
  title: string;
  outcome: string;
  avgPrice: number;
  curPrice: number;
  realizedPnl: number;
  settled: boolean;
  won: boolean;
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
 */
export async function fetchWalletProfile(wallet: string): Promise<WalletProfile | null> {
  try {
    // Fetch all closed positions to calculate historical stats
    const url = `${DATA_API}/closed-positions?user=${wallet}&limit=500&sortBy=REALIZEDPNL&sortDirection=DESC`;

    const res = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      return null;
    }

    const positions = await res.json();

    if (!Array.isArray(positions) || positions.length === 0) {
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

    // Find a matching position (by outcome/title)
    const match = positions.find(
      (p) =>
        p.avgPrice < 0.25 &&
        (p.title.includes(t.title.slice(0, 20)) || t.title.includes(p.title.slice(0, 20)))
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
