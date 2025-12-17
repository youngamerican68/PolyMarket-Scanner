# Phase 1 Implementation Spec

## Rebuild Around High-Accuracy Primitives

**Goal**: Near-100% data accuracy. Prefer removing features over showing misleading values.

---

## Table of Contents

1. [Decisions & Constraints](#decisions--constraints)
2. [Database Schema: alert_events](#database-schema-alert_events)
3. [Zod Schemas & Safe Parsing](#zod-schemas--safe-parsing)
4. [Decimal-Safe Math](#decimal-safe-math)
5. [Trade Dedupe ID Generation](#trade-dedupe-id-generation)
6. [Position Matching Logic](#position-matching-logic)
7. [Ingestion Algorithm](#ingestion-algorithm)
8. [Dashboard API Rewrites](#dashboard-api-rewrites)
9. [UI Component Updates](#ui-component-updates)
10. [Migration Execution](#migration-execution)
11. [File Manifest](#file-manifest)
12. [Acceptance Criteria](#acceptance-criteria)

---

## Decisions & Constraints

### Core Decisions

| Decision | Resolution |
|----------|------------|
| Legacy data migration | **Start fresh**. Do not backfill from `trades`, `whale_trades`, `longshot_history`. Keep legacy tables intact but stop reading from them. |
| Whale watchlist | **Keep as-is**. Ensure `wallet` column is lowercase with unique index. |
| Closed-positions investigation | **Defer to pre-Phase 3**. Investigate reliability before implementing outcome confirmation. |

### Non-Negotiable Accuracy Rules

1. **Never treat missing price/value as 0**. Use `NULL` and display "N/A".
2. **Never fetch "current price" from Gamma or CLOB for dashboards**.
3. **`/positions` is the ONLY source of truth** for position-level fields: `size`, `avgPrice`, `curPrice`, `initialValue`, `currentValue`, `cashPnl`.
4. **Stored trade fills are "signals"**; stored positions are "state snapshots".
5. **Remove heuristic win/loss inference** based on price thresholds.
6. **Skip alert creation if no position match** — never guess.

---

## Database Schema: alert_events

### Migration SQL

```sql
-- No pgcrypto needed — UUIDs generated in application code

CREATE TABLE IF NOT EXISTS alert_events (
  -- Primary key (generated in code via crypto.randomUUID())
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Trade identity / dedupe
  trade_dedupe_id TEXT NOT NULL UNIQUE,
  transaction_hash TEXT NULL,
  fill_timestamp TIMESTAMPTZ NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  fill_price NUMERIC NOT NULL,
  fill_size NUMERIC NOT NULL,
  fill_value_usd NUMERIC NOT NULL,

  -- Actor
  wallet TEXT NOT NULL CONSTRAINT alert_events_wallet_lower CHECK (wallet = LOWER(wallet)),
  trader_name TEXT NULL,
  trader_pseudonym TEXT NULL,

  -- Market identifiers
  asset TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  outcome_index INT NOT NULL,
  title TEXT NULL,
  slug TEXT NULL,
  event_slug TEXT NULL,

  -- Position snapshot (from /positions at ingestion time)
  position_size NUMERIC NULL,
  position_avg_price NUMERIC NULL,
  position_cur_price NUMERIC NULL,
  position_initial_value NUMERIC NULL,
  position_current_value NUMERIC NULL,
  position_cash_pnl NUMERIC NULL,
  position_snapshot_at TIMESTAMPTZ NULL,

  -- Qualification flags/params
  longshot_threshold NUMERIC NOT NULL DEFAULT 0.25,
  min_position_threshold NUMERIC NOT NULL DEFAULT 2500,
  qualifies_longshot BOOLEAN NOT NULL,
  qualifies_min_position BOOLEAN NOT NULL,

  -- Audit: which value was used for threshold check
  threshold_value_used NUMERIC NULL,
  threshold_source TEXT NULL,

  -- Whale metadata (from whale_watchlist join)
  is_whale BOOLEAN NOT NULL DEFAULT FALSE,
  whale_label TEXT NULL,
  whale_tier TEXT NULL,
  whale_category TEXT NULL
);

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS idx_alert_events_fill_timestamp
  ON alert_events (fill_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_alert_events_wallet_timestamp
  ON alert_events (wallet, fill_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_alert_events_event_slug
  ON alert_events (event_slug);

CREATE INDEX IF NOT EXISTS idx_alert_events_condition_outcome
  ON alert_events (condition_id, outcome_index);

CREATE INDEX IF NOT EXISTS idx_alert_events_asset
  ON alert_events (asset);

CREATE INDEX IF NOT EXISTS idx_alert_events_is_whale
  ON alert_events (is_whale) WHERE is_whale = TRUE;
```

### Whale Watchlist Index Update

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_whale_watchlist_wallet_lower
  ON whale_watchlist (LOWER(wallet));
```

---

## Zod Schemas & Safe Parsing

### Numeric Helpers (CRITICAL)

These helpers prevent silent coercion of empty strings to 0:

```typescript
// /lib/schemas.ts

import { z } from 'zod';

/**
 * Normalize timestamp: if > 1e12, treat as milliseconds and convert to seconds.
 */
export function normalizeTimestamp(ts: number): number {
  return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
}

/**
 * Optional numeric field — allows null, rejects empty strings and invalid values.
 * "" → null (not 0)
 * null/undefined → null
 * "0.25" → 0.25
 * 0 → 0 (explicit zero is valid)
 * "abc" → NaN (fails validation)
 */
export const optionalNumber = z.preprocess((val) => {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string' && val.trim() === '') return null;

  const n =
    typeof val === 'number' ? val :
    typeof val === 'string' ? Number(val) :
    NaN;

  return Number.isFinite(n) ? n : NaN;
}, z.number().nullable());

/**
 * Required numeric field — must be present and valid.
 * "" → validation error
 * null/undefined → validation error
 * "0.25" → 0.25
 * 0 → 0 (explicit zero is valid)
 * "abc" → validation error
 */
export const requiredNumber = z.preprocess((val) => {
  if (val === null || val === undefined) return undefined;
  if (typeof val === 'string' && val.trim() === '') return undefined;

  const n =
    typeof val === 'number' ? val :
    typeof val === 'string' ? Number(val) :
    NaN;

  return Number.isFinite(n) ? n : undefined;
}, z.number());

/**
 * Optional integer field — allows null, rejects empty strings and invalid values.
 */
export const optionalInt = z.preprocess((val) => {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string' && val.trim() === '') return null;

  const n =
    typeof val === 'number' ? val :
    typeof val === 'string' ? Number(val) :
    NaN;

  return Number.isFinite(n) && Number.isInteger(n) ? n : NaN;
}, z.number().int().nullable());

/**
 * Required integer field — must be present and valid.
 */
export const requiredInt = z.preprocess((val) => {
  if (val === null || val === undefined) return undefined;
  if (typeof val === 'string' && val.trim() === '') return undefined;

  const n =
    typeof val === 'number' ? val :
    typeof val === 'string' ? Number(val) :
    NaN;

  return Number.isFinite(n) && Number.isInteger(n) ? n : undefined;
}, z.number().int());
```

### Trade Schema

```typescript
export const TradeSchema = z.object({
  proxyWallet: z.string(),
  side: z.enum(['BUY', 'SELL']),
  asset: z.string(),
  conditionId: z.string(),
  size: requiredNumber,
  price: requiredNumber,
  timestamp: requiredNumber,
  title: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  eventSlug: z.string().nullable().optional(),
  outcome: z.string(),
  outcomeIndex: requiredInt,
  name: z.string().nullable().optional(),
  pseudonym: z.string().nullable().optional(),
  transactionHash: z.string().nullable().optional(),
});

export type Trade = z.infer<typeof TradeSchema>;

export const TradesResponseSchema = z.array(TradeSchema);
```

### Position Schema

```typescript
export const PositionSchema = z.object({
  proxyWallet: z.string(),
  asset: z.string(),
  conditionId: z.string(),
  size: optionalNumber,
  avgPrice: optionalNumber,
  curPrice: optionalNumber,
  initialValue: optionalNumber,
  currentValue: optionalNumber,
  cashPnl: optionalNumber,
  title: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  eventSlug: z.string().nullable().optional(),
  outcome: z.string().nullable().optional(),
  outcomeIndex: optionalInt,
});

export type Position = z.infer<typeof PositionSchema>;

export const PositionsResponseSchema = z.array(PositionSchema);
```

---

## Decimal-Safe Math

### Dependency

```bash
npm install decimal.js-light
```

### Usage

```typescript
// /lib/decimal.ts

import Decimal from 'decimal.js-light';

/**
 * Compute fill_value_usd as price * size using decimal-safe math.
 * Returns string for direct insertion into Postgres NUMERIC column.
 */
export function computeFillValue(price: number, size: number): string {
  return new Decimal(price).mul(new Decimal(size)).toDecimalPlaces(6).toString();
}

/**
 * Round price to 6 decimal places for dedupe ID.
 * Returns string to avoid float drift.
 */
export function roundPrice(price: number): string {
  return new Decimal(price).toDecimalPlaces(6).toString();
}

/**
 * Round size to 2 decimal places for dedupe ID.
 * Returns string to avoid float drift.
 */
export function roundSize(size: number): string {
  return new Decimal(size).toDecimalPlaces(2).toString();
}
```

---

## Trade Dedupe ID Generation

### Algorithm

```typescript
// /lib/dedupe.ts

import { roundPrice, roundSize } from './decimal';
import { normalizeTimestamp } from './schemas';

/**
 * Generate deterministic dedupe ID for a trade.
 *
 * Format with transactionHash:
 *   ${transactionHash}_${asset}_${side}_${timestampSeconds}_${priceRounded}_${sizeRounded}
 *
 * Format without transactionHash (fallback):
 *   noTx_${wallet}_${asset}_${side}_${timestampSeconds}_${priceRounded}_${sizeRounded}
 */
export function generateTradeDedupeId(params: {
  transactionHash: string | null | undefined;
  wallet: string;
  asset: string;
  side: 'BUY' | 'SELL';
  timestamp: number;
  price: number;
  size: number;
}): string {
  const { transactionHash, wallet, asset, side, timestamp, price, size } = params;

  const timestampSeconds = normalizeTimestamp(timestamp);
  const priceRounded = roundPrice(price);
  const sizeRounded = roundSize(size);

  if (transactionHash && transactionHash.trim() !== '') {
    return `${transactionHash}_${asset}_${side}_${timestampSeconds}_${priceRounded}_${sizeRounded}`;
  }

  return `noTx_${wallet.toLowerCase()}_${asset}_${side}_${timestampSeconds}_${priceRounded}_${sizeRounded}`;
}
```

---

## Position Matching Logic

### Primary Join

```
wallet (lowercase) + asset
```

### Matching Function

```typescript
function matchTradeToPosition(trade: Trade, positions: Position[]): Position | null {
  const walletLower = trade.proxyWallet.toLowerCase();

  const candidates = positions.filter(
    (p) => p.proxyWallet.toLowerCase() === walletLower && p.asset === trade.asset
  );

  if (candidates.length === 0) return null;

  const conditionMatches = candidates.filter((p) => p.conditionId === trade.conditionId);
  if (conditionMatches.length === 0) {
    console.warn('[matchPosition] conditionId mismatch', {
      trade: trade.conditionId,
      candidates: candidates.map((c) => c.conditionId),
    });
    return null;
  }

  const exact = conditionMatches.find((p) => {
    return p.outcomeIndex === null || p.outcomeIndex === undefined || p.outcomeIndex === trade.outcomeIndex;
  });

  if (!exact) {
    console.warn('[matchPosition] outcomeIndex mismatch', {
      trade: trade.outcomeIndex,
      candidates: conditionMatches.map((c) => c.outcomeIndex),
    });
    return null;
  }

  return exact;
}
```

### Min Position Threshold ($2,500)

```typescript
let thresholdValue: number | null = null;
let thresholdSource: string | null = null;

if (position.initialValue !== null && position.initialValue !== undefined) {
  thresholdValue = position.initialValue;
  thresholdSource = 'initialValue';
} else if (position.currentValue !== null && position.currentValue !== undefined) {
  thresholdValue = position.currentValue;
  thresholdSource = 'currentValue';
}

const qualifiesMinPosition = thresholdValue !== null && thresholdValue >= 2500;
```

---

## Ingestion Algorithm

### File: `/app/api/collect-trades/route.ts`

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
```

### Algorithm Steps

```
1. FETCH recent trades from /trades API
   - filterType=CASH, filterAmount=100, takerOnly=true
   - Parse each trade item with TradeSchema.safeParse(). Trades missing required fields (including outcome/outcomeIndex) fail safeParse, are logged, and skipped.

2. FILTER candidates:
   - Use constant `const LONGSHOT_THRESHOLD = 0.25`
   - side === 'BUY'
   - price <= LONGSHOT_THRESHOLD
   - qualifies_longshot = (trade.side === 'BUY' && trade.price <= LONGSHOT_THRESHOLD)
   - Insert `longshot_threshold` column as 0.25

3. DEDUPE candidates by trade_dedupe_id
   - Use timestampSeconds = normalizeTimestamp(trade.timestamp) in dedupe ID
   - Skip if ID already exists in alert_events

4. GROUP candidates by wallet
   - Build Map<wallet, Trade[]>

5. FETCH positions for each unique wallet (using p-limit)
   - Concurrency limit: max 5 parallel requests
   - Retry with exponential backoff on 429/5xx (1s, 2s, 4s, max 3 retries)
   - Cache in Map<wallet, Position[]>
   - WARN if positions.length === limit (truncation risk)

6. FOR each candidate trade:
   - Compute `const timestampSeconds = normalizeTimestamp(trade.timestamp)` per trade and use it for both dedupe ID generation and `fill_timestamp` insertion.
   a. MATCH position using matchTradeToPosition()
   b. If no position match: log, increment skipped_no_position_match, continue
   c. COMPUTE threshold qualification
   d. If !qualifies_min_position: increment skipped_below_threshold, continue
   e. COMPUTE fill_value_usd using computeFillValue() from decimal.js-light
   f. GENERATE UUID via crypto.randomUUID()
   g. LOOKUP whale metadata from whale_watchlist (by lowercase wallet)
   h. INSERT into alert_events with ON CONFLICT (trade_dedupe_id) DO NOTHING
      - Insert fill_timestamp as new Date(timestampSeconds * 1000).toISOString() (TIMESTAMPTZ)

7. LOG structured summary:
   {
     trades_fetched: number,
     candidates_after_filter: number,
     unique_wallets_queried: number,
     positions_fetched: number,
     positions_at_limit_warning: number,
     alerts_inserted: number,
     skipped_duplicate: number,
     skipped_no_position_match: number,
     skipped_validation_failed: number,
     skipped_below_threshold: number,
     errors: string[]
   }
```

### Concurrency Control with p-limit

```typescript
import pLimit from 'p-limit';

const limit = pLimit(5);

await Promise.all(
  wallets.map((wallet) =>
    limit(async () => {
      const positions = await fetchPositionsWithRetry(wallet);
      positionsByWallet.set(wallet.toLowerCase(), positions);
    })
  )
);
```

### Retry with Backoff

```typescript
// Thin wrapper for fetching positions
async function fetchPositionsWithRetry(wallet: string): Promise<Position[]> {
  const url = `https://data-api.polymarket.com/positions?user=${wallet}&sizeThreshold=0`;
  return fetchWithRetry(url, PositionsResponseSchema);
}

async function fetchWithRetry<T>(
  url: string,
  schema: z.ZodSchema<T>,
  maxRetries: number = 3
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
      });

      if (res.status === 429 || res.status >= 500) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`[RETRY] ${url} returned ${res.status}, waiting ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      return schema.parse(data);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error('Fetch failed after retries');
}
```

---

## Dashboard API Rewrites

### Common Query Pattern

All dashboards read from `alert_events` only. No external API calls at page load.

Note: Postgres `NUMERIC` fields may be returned as strings; format at the UI boundary and never invent 0 for missing values.

### `/api/daily-report/route.ts`

```sql
SELECT * FROM alert_events
WHERE fill_timestamp >= NOW() - INTERVAL '24 hours'
ORDER BY fill_timestamp DESC
LIMIT 500
```

**Remove**:
- All Gamma/CLOB price fetching
- `fetchOpenPositions()` calls
- `enrichTradesWithSettlement()` calls
- `detectSharpConvergence()` (defer to Phase 2 DB-only version)
- `detectDormantSharps()` (defer to Phase 2)
- `rankAnomalousWallets()` z-score logic

**Keep**:
- Summary stats (count, unique wallets, total value)
- Repeat winners query from `alert_events` (if confirmed outcomes exist)

### `/api/whale-trades/route.ts`

```sql
SELECT * FROM alert_events
WHERE is_whale = TRUE
ORDER BY fill_timestamp DESC
LIMIT 500
```

**Remove**:
- `fetchMarketPrices()` via Gamma API
- `fetchWalletPnL()` via Data API
- Live price lookups
- `inferredStatus` computation

### `/api/longshot-history/route.ts`

```sql
SELECT * FROM alert_events
WHERE qualifies_longshot = TRUE
ORDER BY fill_timestamp DESC
LIMIT 500
OFFSET $1
```

**Remove**:
- `fetchMarketPrices()` via CLOB API
- `inferredStatus` based on price thresholds

---

## UI Component Updates

### Column Renames

| Old Label | New Label |
|-----------|-----------|
| Entry Price | Fill Price (this trade) |
| Odds | Fill Odds |
| Position | Position Value (snapshot) |
| Current Price | — (remove or show snapshot) |

### New Columns to Add

| Column | Source Field | Notes |
|--------|--------------|-------|
| Position Avg Entry | `position_avg_price` | Show "N/A" if null |
| Position Value | `position_current_value` | Show "N/A" if null |
| Position Size | `position_size` | Show "N/A" if null |

### Null Handling

```typescript
function formatValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return 'N/A';
  // ... format logic
}
```

### Remove from UI

- `inferredStatus` display (likely_won, likely_lost, etc.)
- All price-based status indicators
- "Holding" / "Sold" status derived from live lookups

### Files to Update

- `/app/report/page.tsx`
- `/app/whales/page.tsx`
- `/app/history/page.tsx`

---

## Migration Execution

### Admin Route: `/app/api/admin/migrate/route.ts`

```typescript
export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (process.env.ENABLE_ADMIN_MIGRATIONS !== 'true') {
    return NextResponse.json(
      { error: 'Admin migrations disabled' },
      { status: 403 }
    );
  }

  const secret = request.headers.get('x-admin-secret');
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json(
      { error: 'Invalid admin secret' },
      { status: 401 }
    );
  }

  // Pseudocode — actual implementation reads from /lib/migrations/001_alert_events.sql
  // or executes the full CREATE TABLE statement inline
  try {
    await sql`CREATE TABLE IF NOT EXISTS alert_events ( /* full schema from spec */ )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_alert_events_fill_timestamp ON alert_events (fill_timestamp DESC)`;
    // ... remaining indexes

    return NextResponse.json({ success: true, message: 'Migration complete' });
  } catch (err) {
    return NextResponse.json(
      { error: 'Migration failed', details: String(err) },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
```

### Environment Variables Required

```
ADMIN_SECRET=<random-secret-string>
ENABLE_ADMIN_MIGRATIONS=true
```

### Raw SQL File

Also provide `/lib/migrations/001_alert_events.sql` for manual execution if preferred.

---

## File Manifest

### New Files to Create

| File | Purpose |
|------|---------|
| `/lib/schemas.ts` | Zod schemas with safe numeric helpers |
| `/lib/decimal.ts` | Decimal-safe math utilities |
| `/lib/dedupe.ts` | Trade dedupe ID generation |
| `/lib/migrations/001_alert_events.sql` | Raw SQL migration |
| `/app/api/admin/migrate/route.ts` | Secure migration endpoint |

### Files to Rewrite

| File | Changes |
|------|---------|
| `/lib/polymarket.ts` | Typed fetchers with Zod, retry/backoff, no Gamma/CLOB |
| `/app/api/collect-trades/route.ts` | New ingestion into alert_events |
| `/app/api/daily-report/route.ts` | Query alert_events only |
| `/app/api/whale-trades/route.ts` | Query alert_events only |
| `/app/api/longshot-history/route.ts` | Query alert_events only |

### Files to Update

| File | Changes |
|------|---------|
| `/app/report/page.tsx` | New labels, N/A handling, remove inference display |
| `/app/whales/page.tsx` | New labels, N/A handling, remove inference display |
| `/app/history/page.tsx` | New labels, N/A handling, remove inference display |
| `package.json` | Add decimal.js-light, zod, p-limit dependencies |

### Files to Deprecate (Keep but Stop Using)

| File | Notes |
|------|-------|
| `/lib/scoring.ts` | Z-score logic deferred; may revive in Phase 2 |
| Legacy tables | `trades`, `whale_trades`, `longshot_history` — keep data, stop reads |

---

## Acceptance Criteria

### Data Accuracy

- [ ] No endpoint returns `curPrice=0` as a fallback
- [ ] No endpoint returns `position=0` when data is missing (must be NULL/"N/A")
- [ ] For any alert row, position fields exactly match `/positions` response at ingestion time
- [ ] Trade dedupe IDs are deterministic and unique

### API Behavior

- [ ] `/api/daily-report` returns only last 24h alerts from `alert_events`
- [ ] `/api/whale-trades` returns only `is_whale=true` alerts from `alert_events`
- [ ] `/api/longshot-history` returns only `qualifies_longshot = TRUE` alerts from `alert_events` (paginated)
- [ ] No dashboard API makes Gamma or CLOB requests
- [ ] All dashboard APIs return in <2s under normal load

### Ingestion Reliability

- [ ] Ingestion is idempotent (safe to run multiple times)
- [ ] Alerts are only created when position match is found AND validated
- [ ] Alerts are only created when min position threshold ($2,500) is met
- [ ] Structured logs show all skip reasons with counts
- [ ] Truncation warning logged when positions.length === limit

### UI Consistency

- [ ] All three dashboards display consistent data (same source table)
- [ ] Null values display as "N/A", never as "0" or "$0"
- [ ] No "likely_won", "likely_lost", or inferred status indicators
- [ ] Column labels match spec (Fill Price, Position Value snapshot, etc.)

### Security

- [ ] Admin migration route is POST-only
- [ ] Admin migration requires `ADMIN_SECRET` header
- [ ] Admin migration requires `ENABLE_ADMIN_MIGRATIONS=true` env var
- [ ] Migration is idempotent (safe to run twice)

---

## Execution Order

1. Install dependencies (`decimal.js-light`, `zod`, `p-limit`)
2. Create `/lib/schemas.ts` with Zod schemas
3. Create `/lib/decimal.ts` with decimal utilities
4. Create `/lib/dedupe.ts` with dedupe ID generator
5. Create `/lib/migrations/001_alert_events.sql`
6. Create `/app/api/admin/migrate/route.ts`
7. Run migration (create `alert_events` table)
8. Add whale_watchlist index
9. Rewrite `/lib/polymarket.ts`
10. Rewrite `/app/api/collect-trades/route.ts`
11. Rewrite `/app/api/daily-report/route.ts`
12. Rewrite `/app/api/whale-trades/route.ts`
13. Rewrite `/app/api/longshot-history/route.ts`
14. Update `/app/report/page.tsx`
15. Update `/app/whales/page.tsx`
16. Update `/app/history/page.tsx`
17. Test all acceptance criteria
18. Deploy
