# Polymarket Tracker - Development Progress

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
