// scripts/setup-db.ts
// Run with: npx ts-node --esm scripts/setup-db.ts

import { sql } from '@vercel/postgres';
import 'dotenv/config';

async function setupDatabase() {
  console.log('Creating trades table...');

  await sql`
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      name TEXT,
      market_id TEXT NOT NULL,
      event_slug TEXT,
      title TEXT,
      outcome TEXT,
      timestamp BIGINT NOT NULL,
      price DECIMAL(10, 6) NOT NULL,
      size DECIMAL(18, 2) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  console.log('Creating indexes...');

  // Index for time-based queries and cleanup
  await sql`
    CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp DESC)
  `;

  // Index for wallet lookups
  await sql`
    CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(wallet)
  `;

  // Index for market lookups
  await sql`
    CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market_id, outcome)
  `;

  console.log('Creating longshot_history table...');

  await sql`
    CREATE TABLE IF NOT EXISTS longshot_history (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      name TEXT,
      market_id TEXT NOT NULL,
      event_slug TEXT,
      title TEXT,
      outcome TEXT,
      timestamp BIGINT NOT NULL,
      price DECIMAL(10, 6) NOT NULL,
      size DECIMAL(18, 2) NOT NULL,
      value DECIMAL(18, 2) NOT NULL,
      resolved BOOLEAN DEFAULT FALSE,
      won BOOLEAN,
      pnl DECIMAL(18, 2),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  // Index for wallet lookups in history
  await sql`
    CREATE INDEX IF NOT EXISTS idx_longshot_history_wallet ON longshot_history(wallet)
  `;

  // Index for unresolved markets
  await sql`
    CREATE INDEX IF NOT EXISTS idx_longshot_history_resolved ON longshot_history(resolved, market_id)
  `;

  // Index for time-based queries
  await sql`
    CREATE INDEX IF NOT EXISTS idx_longshot_history_timestamp ON longshot_history(timestamp DESC)
  `;

  console.log('Database setup complete!');

  // Verify
  const result = await sql`SELECT COUNT(*) as count FROM trades`;
  console.log(`Trades table has ${result.rows[0].count} rows`);

  const historyResult = await sql`SELECT COUNT(*) as count FROM longshot_history`;
  console.log(`Longshot history table has ${historyResult.rows[0].count} rows`);
}

setupDatabase()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error setting up database:', err);
    process.exit(1);
  });
