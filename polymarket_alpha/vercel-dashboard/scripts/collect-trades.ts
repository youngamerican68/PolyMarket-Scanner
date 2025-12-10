// scripts/collect-trades.ts
// Fetches longshot trades from Polymarket API and stores in database
// Run with: POSTGRES_URL=... npx tsx scripts/collect-trades.ts

import { sql } from '@vercel/postgres';

const DATA_API = 'https://data-api.polymarket.com';

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
  timestamp: number;
  price: number;
  size: number;
  side: string;
}

async function fetchRecentTrades(): Promise<RawTrade[]> {
  const allTrades: RawTrade[] = [];
  const pageSize = 500;
  const maxPages = 10; // 5000 trades max per run

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const url = `${DATA_API}/trades?limit=${pageSize}&offset=${offset}&filterType=CASH&filterAmount=100&takerOnly=true`;

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
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
        (t: RawTrade) => t.price < 0.25 && t.side === 'BUY'
      );

      allTrades.push(...longshots);
      console.log(`Page ${page + 1}: fetched ${trades.length} trades, ${longshots.length} longshots`);

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

async function storeTrades(trades: RawTrade[]): Promise<number> {
  let inserted = 0;

  for (const t of trades) {
    try {
      // Generate a unique ID from wallet + market + timestamp + size
      const tradeId = `${t.proxyWallet}-${t.conditionId}-${t.timestamp}-${t.size}`;

      // Use INSERT ... ON CONFLICT DO NOTHING to skip duplicates
      const result = await sql`
        INSERT INTO trades (id, wallet, name, market_id, event_slug, title, outcome, timestamp, price, size)
        VALUES (
          ${tradeId},
          ${t.proxyWallet},
          ${t.name || t.pseudonym || 'Anonymous'},
          ${t.conditionId},
          ${t.eventSlug || t.slug || ''},
          ${t.title || ''},
          ${t.outcome || ''},
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
      console.error(`Error inserting trade ${t.id}:`, err);
    }
  }

  return inserted;
}

async function pruneOldTrades(): Promise<number> {
  // Delete trades older than 48 hours
  const cutoffTimestamp = Math.floor(Date.now() / 1000) - 48 * 60 * 60;

  const result = await sql`
    DELETE FROM trades WHERE timestamp < ${cutoffTimestamp}
  `;

  return result.rowCount || 0;
}

async function main() {
  console.log('Starting trade collection...');
  console.log(`Time: ${new Date().toISOString()}`);

  // Fetch recent trades
  const trades = await fetchRecentTrades();
  console.log(`Fetched ${trades.length} longshot trades total`);

  // Store in database
  const inserted = await storeTrades(trades);
  console.log(`Inserted ${inserted} new trades`);

  // Prune old trades
  const pruned = await pruneOldTrades();
  console.log(`Pruned ${pruned} old trades`);

  // Report current state
  const countResult = await sql`SELECT COUNT(*) as count FROM trades`;
  console.log(`Database now has ${countResult.rows[0].count} trades`);

  console.log('Done!');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
