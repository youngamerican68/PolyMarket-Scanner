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

  console.log('Database setup complete!');

  // Verify
  const result = await sql`SELECT COUNT(*) as count FROM trades`;
  console.log(`Trades table has ${result.rows[0].count} rows`);
}

setupDatabase()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error setting up database:', err);
    process.exit(1);
  });
