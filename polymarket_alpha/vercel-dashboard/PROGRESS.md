# Polymarket Tracker - Development Progress

## Session: December 17, 2025

### Phase 2: Longshot Alpha Report (Completed)

**Goal:** Build a new `/report` page that's DB-only (no external API calls at render time) with convergence detection to identify when multiple wallets bet on the same outcome.

**Features Implemented:**

1. **Convergence Detection**
   - Groups trades by market/outcome to find multi-wallet convergence
   - Qualification thresholds: 6h = 2+ wallets; 24h/72h = 3+ wallets OR $10K+ total value
   - Shows odds range (min-max %) for each convergence group
   - Expandable wallet details with individual odds, position value, potential win

2. **Alerts Table**
   - Paginated (50 per page) with Prev/Next/First/Last navigation
   - Sortable columns (time, odds, fill value, position value)
   - Filters: time window (6h/24h/72h), whales only, category
   - Shows: Market, Trader, Odds, Fill Value, Position Value, Avg Price, Potential Win, Time

3. **Potential Win Calculation**
   - Formula: `position_size × (1 - avg_price)`
   - Shows profit if position resolves to $1

**Bug Fixes:**

| Issue | Fix |
|-------|-----|
| Convergence always showing 6h window | Client was sending `hours` but API expected `alertWindowHours`. Now sends both `alertWindowHours` and `convergenceWindowHours` |
| Trades under $2.5K appearing in table | Alerts query was missing `position_current_value >= minPosition` filter |
| Type mismatches after deployment | Updated client interfaces to match API response fields |

**Files Created/Modified:**
- `app/api/report/route.ts` - DB-only report endpoint with convergence detection
- `app/report/page.tsx` - New Longshot Alpha Report UI
- `app/api/admin/migrate/route.ts` - Added convergence indexes

**Database Indexes Added:**
```sql
CREATE INDEX idx_alert_events_convergence
  ON alert_events (condition_id, outcome, wallet, fill_timestamp DESC);
CREATE INDEX idx_alert_events_convergence_filtered
  ON alert_events (fill_timestamp DESC, fill_price)
  INCLUDE (position_current_value, condition_id, outcome, wallet, is_whale, whale_category)
  WHERE position_current_value IS NOT NULL;
```

**UI Components:**
- Summary cards: Total Alerts, Whales, Unique Wallets, Page
- Convergence section with expandable groups
- Alerts table with pagination
- Filter controls: Window dropdown, Whales Only checkbox, Category dropdown

---

## Session: December 15, 2025

### Phase 1: Trade ID Uniqueness (Completed)

**Problem:** Trade IDs were constructed as `wallet-marketId-timestamp-size`, risking collisions if same wallet made identical trades in same second.

**Solution:** Now using `transactionHash_asset` for guaranteed uniqueness:
- `transactionHash` = blockchain tx hash (unique per transaction)
- `asset` = token ID (immutable identifier per outcome)

**Changes:**
- `app/api/collect-trades/route.ts` - Updated ID generation with fallback tracking
- Added `asset` field to RawTrade interface
- Asset normalization: `String(asset).trim()`

**Monitoring:**
```json
{
  "legacyIdCount": 0,      // Missing transactionHash (should always be 0)
  "legacyIdSamples": [],
  "missingAssetCount": 0,  // Has txHash but no asset (should always be 0)
  "missingAssetSamples": []
}
```

**Log tags for alerts:**
- `[LEGACY_ID]` - Missing transactionHash
- `[MISSING_ASSET]` - Has txHash but missing asset field

---

### Phase 2: Resolution States (Completed)

**Problem:** No distinction between officially confirmed resolutions and price-inferred guesses. Trades marked as "Lost" based only on price inference could be wrong.

**Solution:** Added `resolution_state` and `resolution_source` columns to distinguish:

| State | Source | Meaning |
|-------|--------|---------|
| `confirmed` | `official_api` | Polymarket API says market.closed=true with winner |
| `inferred` | `price_inference` | Price at 98%+ but market not officially closed |
| `unresolved` | null | Market still open |

**Database Changes:**
```sql
ALTER TABLE longshot_history ADD COLUMN resolution_state TEXT DEFAULT 'unresolved';
ALTER TABLE longshot_history ADD COLUMN resolution_source TEXT;
```

**Files Modified:**
- `app/api/migrate-resolution-state/route.ts` - Migration endpoint (run once)
- `app/api/check-resolutions/route.ts` - Now sets resolution_state/source
- `app/api/longshot-history/route.ts` - Returns new fields, updated inferredStatus logic
- `app/history/page.tsx` - Updated UI with new status indicators

**UI Status Display:**
| Status | Icon | Meaning |
|--------|------|---------|
| Confirmed Won | `✅ Won` | Officially confirmed |
| Confirmed Lost | `❌ Lost` | Officially confirmed |
| Inferred Won | `📈 Won*` | Price-based (stored in DB) |
| Inferred Lost | `📉 Lost*` | Price-based (stored in DB) |
| Likely Won | `🔄 Likely Won` | Live price inference |
| Likely Lost | `🔄 Likely Lost` | Live price inference |
| Holding | `⏳ Holding` | Market still open |

**check-resolutions Response:**
```json
{
  "checked": 19,
  "confirmed": 14,
  "inferred": 0,
  "won": 3
}
```

---

### Phase 2b: Report Page Sync (Completed)

**Problem:** The `/report` page wasn't updated with Phase 2 resolution state logic, showing inconsistent status indicators compared to `/history`.

**Solution:** Updated report page to use same status hierarchy and lookup resolution states from longshot_history.

**Files Modified:**
- `app/api/daily-report/route.ts` - Added resolution state lookup from longshot_history
- `app/report/page.tsx` - Updated inferredStatus type and status display

**API Changes:**
```typescript
// daily-report now queries longshot_history for resolution states
const historyLookupResult = await sql`
  SELECT wallet, market_id, outcome, resolution_state, won
  FROM longshot_history
  WHERE resolution_state IN ('confirmed', 'inferred')
`;

// Creates lookup map: wallet:marketId:outcome -> { state, won }
// Uses this to override live price inference with stored resolutions
```

**UI Now Consistent Across Pages:**
| Page | Status Icons |
|------|-------------|
| `/history` | ✅❌ (confirmed) \| 📈📉 Won*/Lost* (inferred) \| 🔄 Likely \| ⏳ Holding |
| `/report` | Same display, plus looks up resolutions from longshot_history |

**Sharp Convergence Updates:**
- Added `positionStatus` to sharp wallet display
- Shows "Sold" badge for wallets that have exited positions
- Fades sold/hedged positions with `opacity-60`

---

## Deployment Log

| Commit | Description | Date |
|--------|-------------|------|
| `63022f8` | Phase 1 & 2: Trade ID uniqueness + resolution states | Dec 15, 2025 |
| `2c6dea9` | Report page resolution state support | Dec 15, 2025 |
| `1f74d57` | Position, Potential, Status columns to history | Dec 15, 2025 |

---

## Remaining Phases (Planned)

### Phase 3: Price Cache
- Cache market prices in DB with 10-min refresh
- Removes 50-market fetch limit
- Shows "price unavailable" instead of false $0

### Phase 4: Job Tracking + Admin Page
- Track cron job runs in DB
- Add /admin dashboard for monitoring
- Catch failures and see job history

### Phase 5: Accumulator for $2.5K Threshold
- Track positions across days
- Catch wallets buying $1K/day that cross threshold
- Prevents loss from 48h trade pruning

---

## Database Schema (Current)

### longshot_history
```sql
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
resolution_state TEXT DEFAULT 'unresolved',  -- NEW
resolution_source TEXT,                       -- NEW
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
```

### whale_trades
```sql
id TEXT PRIMARY KEY,  -- Now uses transactionHash_asset format
wallet TEXT,
name TEXT,
whale_tier TEXT,
whale_category TEXT,
market_id TEXT,
event_slug TEXT,
title TEXT,
outcome TEXT,
timestamp BIGINT,
price DECIMAL,
size DECIMAL,
value DECIMAL,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
```

### trades (rolling 48h)
```sql
id TEXT PRIMARY KEY,  -- Now uses transactionHash_asset format
wallet TEXT NOT NULL,
name TEXT,
market_id TEXT NOT NULL,
event_slug TEXT,
title TEXT,
outcome TEXT,
timestamp BIGINT NOT NULL,
price DECIMAL(10, 6) NOT NULL,
size DECIMAL(18, 2) NOT NULL
```
