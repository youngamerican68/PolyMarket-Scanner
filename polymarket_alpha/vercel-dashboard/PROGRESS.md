# Polymarket Tracker - Development Progress

## Session: December 20, 2025 (Phase 7: Longshot Position Archive)

### Phase 7: Longshot Position Archive System (Completed)

**Goal:** Start collecting "Large Single Bets" position snapshots NOW so that in ~30 days we can evaluate "successful longshot traders" based on resolved outcomes.

**Key Principle:** Store raw snapshots only. Compute all metrics at query time by joining `market_status`.

**New Table:**
```sql
CREATE TABLE trade_history_longshot_positions (
  id BIGSERIAL PRIMARY KEY,
  dedupe_key TEXT UNIQUE NOT NULL,
  wallet TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  fill_price NUMERIC(10, 6) NOT NULL,
  pos_avg_entry NUMERIC(10, 6),
  position_value_usd NUMERIC(18, 2) NOT NULL,
  potential_win_usd NUMERIC(18, 2),
  observed_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL DEFAULT 'large_single_bet',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Feature Flag:**
- `ENABLE_LONGSHOT_ARCHIVE=true` in Vercel env to enable archival (default: off)

**Archive Helper** (`lib/longshots/archiveLongshotPosition.ts`):
- Best-effort archival - never throws, logs warnings only
- Dedupe key: SHA256 of normalized `wallet|condition_id|outcome|fill_price(6dp)|position_value_usd(2dp)|observed_at_iso`
- `ON CONFLICT (dedupe_key) DO NOTHING` for idempotency

**Integration with Large Single Bets:**
- Fire-and-forget archival after filtering Large Single Bets
- Uses `void archiveLongshotPositionsBatch(...).catch(() => {})` pattern
- Skips snapshots with null fillPrice (never defaults to 0)
- Uses stable timestamp from underlying fill data

**New Endpoint:** `GET /api/leaderboards/longshots`

| Param | Default | Description |
|-------|---------|-------------|
| `sinceDays` | 30 | Lookback window |
| `minResolved` | 5 | Min resolved positions to qualify |
| `threshold` | 0.25 | Longshot threshold (fill_price <=) |
| `sort` | `accuracy` | Sort by: `accuracy` or `profit` |

**Golden Metric Set (Computed at Query Time):**
| Metric | Definition |
|--------|------------|
| `longshot` | `fill_price <= threshold` |
| `win` | `market_resolved = true AND outcome = winning_outcome` |
| `edge_per_usd` | `win::int - fill_price` |
| `profit_preferred` | `win ? +potential_win_usd : -position_value_usd` (rows with potential_win_usd) |
| `profit_fallback` | `risk_usd * edge_per_usd` (rows without potential_win_usd) |
| `accuracy` | `wins_count / resolved_count` |

**Response includes:**
- `metadata`: threshold, min_resolved, since_days, tracking_start_date, mode="per-snapshot", disclaimers, global_resolved_count
- `leaderboard`: wallet stats with separate preferred/fallback profit tracking
- `profit_method`: "preferred" | "fallback" | "mixed" per wallet

**Sorting:**
- `sort=accuracy`: ORDER BY accuracy_unweighted DESC, resolved_count DESC
- `sort=profit`: ORDER BY profit_preferred_usd DESC NULLS LAST, profit_fallback_usd DESC NULLS LAST, resolved_count DESC

**Files Created/Modified:**
- `app/api/admin/migrate/route.ts` - Added Phase 7 table + indexes
- `app/api/report/route.ts` - Added feature flag + fire-and-forget archival
- `lib/longshots/archiveLongshotPosition.ts` - New archive helper
- `app/api/leaderboards/longshots/route.ts` - New leaderboard endpoint

**Deployment Steps:**
1. Deploy code (flag off by default)
2. Run migration: `POST /api/admin/migrate`
3. Enable: Set `ENABLE_LONGSHOT_ARCHIVE=true` in Vercel env
4. Wait ~30 days for market resolutions
5. Query: `GET /api/leaderboards/longshots?sinceDays=30&minResolved=5`

---

## Session: December 19, 2025 (Phase 6: Market Resolution Detection)

### Phase 6: Market Resolution Detection (Completed)

**Goal:** Track market resolution status to show win/loss badges on positions and enable accurate P&L tracking.

**New Table:**
```sql
CREATE TABLE market_status (
  condition_id TEXT PRIMARY KEY,
  market_closed BOOLEAN NOT NULL DEFAULT FALSE,
  market_closed_first_seen_at TIMESTAMPTZ,
  market_resolved BOOLEAN NOT NULL DEFAULT FALSE,
  market_resolved_first_seen_at TIMESTAMPTZ,
  winning_outcome TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**How It Works:**
1. `refresh-prices` job now also checks market resolution via CLOB API `/markets/{conditionId}`
2. Looks for `tokens[].winner = true` to detect resolved markets
3. Stores `winning_outcome` for determining win/loss
4. Preserves first-seen timestamps for audit trail

**UI Enhancements:**
- Win/Loss badges on Convergence groups and Large Single Bets
- Green "WON" badge when `outcome === winning_outcome`
- Red "LOST" badge when resolved but didn't win
- `includeResolved` filter toggle (default: hide resolved)

**Files Modified:**
- `app/api/admin/migrate/route.ts` - Added market_status table
- `app/api/jobs/refresh-prices/route.ts` - Added resolution checking
- `app/api/report/route.ts` - Added market_status JOIN + filtering
- `app/report/page.tsx` - Added resolution badges

---

## Session: December 18, 2025 (Phase 5: Conviction Anomalies)

### Phase 5: Conviction Sizing Anomaly Detection (Completed)

**Goal:** Detect when a wallet makes an unusually large trade relative to their historical trade sizes - a signal of high conviction.

**How It Works:**
1. **Baselines:** For each active wallet, compute median trade notional and MAD (Median Absolute Deviation) over last 90 days
2. **Detection:** When a new trade is ingested, check if it meets anomaly criteria
3. **Criteria:**
   - Trade notional ≥ $500
   - Trade notional ≥ 2.5x wallet's median
   - Robust Z-score ≥ 2.5 (if MAD > 0)

**New Tables:**
```sql
-- Cached baseline stats per wallet
CREATE TABLE wallet_trade_size_baselines (
  wallet TEXT PRIMARY KEY,
  trade_count INTEGER NOT NULL,
  median_notional NUMERIC(18, 6) NOT NULL,
  mad NUMERIC(18, 6) NOT NULL,
  lookback_start TIMESTAMPTZ NOT NULL,
  lookback_end TIMESTAMPTZ NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL
);

-- Detected anomaly events
CREATE TABLE conviction_anomalies (
  id UUID PRIMARY KEY,
  alert_event_id UUID REFERENCES alert_events(id),
  trade_dedupe_id TEXT NOT NULL UNIQUE,
  wallet TEXT NOT NULL,
  fill_timestamp TIMESTAMPTZ NOT NULL,
  trade_notional NUMERIC(18, 6) NOT NULL,
  baseline_median NUMERIC(18, 6) NOT NULL,
  baseline_mad NUMERIC(18, 6) NOT NULL,
  baseline_trade_count INTEGER NOT NULL,
  ratio_to_median NUMERIC(10, 4) NOT NULL,
  robust_z NUMERIC(10, 4) NULL,
  condition_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  title TEXT NULL,
  slug TEXT NULL,
  side TEXT NOT NULL,
  fill_price NUMERIC NOT NULL,
  is_whale BOOLEAN NOT NULL,
  trader_name TEXT NULL
);
```

**New Endpoints:**
- `POST /api/jobs/refresh-baselines` - Recompute baselines for wallets active in last 7 days
- `GET /api/anomalies/conviction` - Fetch recent anomalies with filtering

**API Parameters (conviction endpoint):**
| Param | Default | Description |
|-------|---------|-------------|
| `window` | `24h` | Time window (e.g., "24h", "7d") |
| `limit` | `100` | Max results (capped at 500) |
| `wallet` | - | Filter to specific wallet |
| `whales` | `false` | If `true`, only whale anomalies |
| `minRatio` | - | Filter by minimum ratio |

**UI Integration:**
- Summary card showing total anomalies (clickable to expand section)
- Expandable section with anomaly table:
  - Trader, Market, Trade Size, Median, Ratio, Fill Odds, Time
  - Color-coded ratio (yellow 2.5x+, orange 3x+, red 5x+)
  - Whale indicator (🐋)

**Files Created/Modified:**
- `app/api/admin/migrate/route.ts` - Added Phase 5 table migrations
- `app/api/jobs/refresh-baselines/route.ts` - New baseline refresh job
- `app/api/anomalies/conviction/route.ts` - New anomaly API endpoint
- `app/api/collect-trades/route.ts` - Added anomaly detection on ingestion
- `app/report/page.tsx` - Added Conviction Anomalies section

**Baseline Refresh:**
- Only computes baselines for wallets with ≥30 trades in lookback period
- Only refreshes wallets active in last 7 days (to save compute)
- Uses advisory lock to prevent concurrent runs
- Can be triggered manually or via cron

**Initial Setup:**
1. Run migration: `POST /api/admin/migrate` (creates tables)
2. Run baseline refresh: `POST /api/jobs/refresh-baselines` (populates baselines)
3. Anomalies will be detected automatically on new trade ingestion

**GitHub Actions: Baseline Refresh (Daily)**

Workflow: `.github/workflows/refresh-baselines.yml`

**GitHub Secret Required:**
| Secret | Value |
|--------|-------|
| `REFRESH_BASELINES_URL` | `https://poly-market-scanner.vercel.app/api/jobs/refresh-baselines` |
| `CRON_SECRET` | Same value as Vercel env var |

**Schedule:** Daily at 2 AM UTC

**How it works:**
- Runs once per day to recompute baselines for active wallets
- Uses Bearer token auth with CRON_SECRET
- 409 (job already running) treated as success
- Manual trigger available via "Run workflow" button

---

## Session: December 18, 2025 (Hardening + Deployment)

### Deployment Status: LIVE ✅

**Production URL:** https://poly-market-scanner.vercel.app

| Component | Status |
|-----------|--------|
| Admin Dashboard | ✅ Working (`/admin`) |
| Price Cache | ✅ 50 prices cached, 73.5% coverage |
| Migration | ✅ Phases 1-4 complete |
| Job Tracking | ✅ Recording runs |
| GitHub Actions (10-min refresh) | ✅ Configured |
| Vercel Cron (daily backup) | ✅ Configured |

**Verified Working:**
- Basic Auth protecting `/admin` and `/api/admin/*`
- Manual refresh via admin dashboard button
- Advisory lock preventing concurrent runs (returns 409)
- Cache coverage metrics displaying correctly
- Job runs table recording history

---

### Production Hardening (Completed)

**Goal:** Harden Phase 3 & 4 implementation for production reliability.

**Changes Made:**

1. **Database Constraints**
   - Added CHECK constraint on `outcome_price_cache.price` (0-1 range)
   - Deduplication query to handle any historical duplicates
   - PRIMARY KEY on `(condition_id, outcome)` ensures uniqueness

2. **Refresh Job Robustness**
   - Advisory lock (`pg_advisory_lock`) prevents overlapping job runs
   - Returns 409 Conflict if job is already running
   - Hard cap of 1000 outcomes per run (deterministic ordering)
   - Price validation (reject prices outside 0-1 range)
   - Enhanced metrics: `capApplied`, `oldestFetchedAt`
   - Cache-Control: no-store headers on all responses

3. **Auth Consistency**
   - Migrate route now uses middleware Basic Auth (removed x-admin-secret)
   - Cron auth supports: Bearer token, x-cron-secret header, query param (`?cronSecret=`)
   - Production default-deny if CRON_SECRET not set

4. **Admin Dashboard Ops**
   - Freshness warning banner if last refresh >30 min ago
   - Warning if no successful refresh ever recorded
   - "Run Refresh Now" button for manual triggers
   - Cache coverage metrics: active outcomes, cached count, missing count, coverage %
   - Color-coded coverage indicator (green ≥95%, yellow ≥80%, red <80%)

5. **Post-Migration Optimization**
   - ANALYZE runs on `outcome_price_cache` and `job_runs` tables after migration
   - Ensures query planner has fresh statistics

---

### Pre-Deploy Checklist (Vercel)

**1. Environment Variables** - Set in all environments:
- `ADMIN_BASIC_USER`
- `ADMIN_BASIC_PASS`
- `CRON_SECRET`

**2. Middleware Default-Deny Confirmed**
- Verify hitting `/admin` without auth returns 401 in prod preview/prod

**3. Cron Config Sanity**
- Confirm cron schedule points to `/api/jobs/refresh-prices`
- If cron provider can't send headers, use query-param fallback only there

---

### Post-Deploy Smoke Tests (5 minutes)

**A) Migration**
```bash
curl -X POST https://your-domain.vercel.app/api/admin/migrate \
  -u "admin:password"
```
- Confirm returns success
- Rerun to confirm idempotent (no errors on second run)

**B) Job Run + Metrics**
```bash
# Any of these work:
curl -X POST https://your-domain.vercel.app/api/jobs/refresh-prices \
  -H "Authorization: Bearer YOUR_CRON_SECRET"

curl -X POST https://your-domain.vercel.app/api/jobs/refresh-prices \
  -H "x-cron-secret: YOUR_CRON_SECRET"

curl -X POST "https://your-domain.vercel.app/api/jobs/refresh-prices?cronSecret=YOUR_CRON_SECRET"
```
- Check `/admin` dashboard:
  - New `job_runs` entry appears
  - Status transitions `running` → `success`
  - Metrics show: `requested`, `updated`, `failed`, `capApplied`, `oldestFetchedAt`

**C) Concurrency Lock**
- Trigger two refresh calls back-to-back
- Confirm second returns `409 Conflict`
- Verify no zombie `running` record left behind

**D) Report Uses Cache Correctly**
- Load `/report` and spot check:
  - "missing" prices show "Price unavailable" (not $0)
  - Stale badge appears for prices > 30min old
  - Sorting still works with null prices

**E) Coverage Card Sanity**
- In `/admin`, verify:
  - "Active Outcomes (72h)" matches expected traffic
  - `Cached + Missing ≈ Active Outcomes`
  - Small discrepancies only if cap applied (1000 limit)

---

### Operational Notes

**If cache coverage dips, check:**
1. **Cron not running / auth failing** - Check job_runs for errors
2. **Upstream API rate limiting** - Look for high `failed` count in metrics
3. **Active outcomes grew beyond 1000 cap** - `capApplied: true` in metrics

The admin dashboard cards show which one at a glance.

---

### GitHub Actions: Price Refresh (Every 10 Minutes)

Vercel Hobby plan limits cron jobs to once per day. GitHub Actions handles the frequent refresh instead.

**Workflow:** `.github/workflows/refresh-prices.yml`

**GitHub Secrets Required:**

| Secret | Value |
|--------|-------|
| `REFRESH_PRICES_URL` | `https://poly-market-scanner.vercel.app/api/jobs/refresh-prices` |
| `CRON_SECRET` | Same value as Vercel env var |

**To set secrets:**
1. Go to GitHub repo → Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Add both `REFRESH_PRICES_URL` and `CRON_SECRET`

**How it works:**
- Runs every 10 minutes via GitHub Actions scheduler
- Calls the refresh-prices endpoint with Bearer token auth
- 409 status (job already running) is treated as success - means advisory lock prevented overlap
- Manual trigger available via "Run workflow" button in Actions tab

**Monitoring:**
- Check GitHub Actions tab for run history
- Check `/admin` dashboard for job_runs entries and cache freshness
- If jobs fail, check Actions logs for HTTP status and response

**Note:** Vercel cron remains as daily backup. GitHub Actions is the primary frequent refresher.

---

### Phase 3: Price Cache (Completed)

**Goal:** Cache current outcome prices in DB with 10-minute refresh, removing the need for external API calls at render time.

**Features Implemented:**

1. **Price Cache Table**
   - `outcome_price_cache` table keyed by `(condition_id, outcome)`
   - Stores `price`, `fetched_at`, and `source`
   - Indexed by `fetched_at` for staleness queries

2. **Price Refresh Job**
   - `/api/jobs/refresh-prices` endpoint
   - Fetches prices from Polymarket CLOB API (`/midpoint` endpoint)
   - Queries active outcomes from last 72h of alert_events
   - Batch processing with concurrency control (50 at a time)
   - Runs every 10 minutes via Vercel cron

3. **Report Page Integration**
   - LEFT JOIN on `outcome_price_cache` for each alert
   - Shows "Current Price" column with cached market price
   - Price status: `fresh` (≤30min), `stale` (>30min), `missing` (no cache)
   - Yellow warning indicator for stale prices
   - "Price unavailable" instead of $0 for missing

**Database Schema:**
```sql
CREATE TABLE outcome_price_cache (
  condition_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  price NUMERIC(10, 6) NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT,
  PRIMARY KEY (condition_id, outcome)
);
```

---

### Phase 4: Job Tracking + Admin Dashboard (Completed)

**Goal:** Track cron job executions and provide admin visibility into system health.

**Features Implemented:**

1. **Job Runs Table**
   - `job_runs` table tracking all job executions
   - Fields: `job_name`, `status`, `started_at`, `finished_at`, `duration_ms`, `metrics`, `error`
   - Status: `running`, `success`, `error`

2. **Admin Dashboard** (`/admin`)
   - Price cache stats: total cached, fresh count, stale count
   - Job status summary: latest run per job, last success/error times
   - Recent runs table: last 100 job executions with metrics
   - Error display for failed jobs

3. **Security**
   - Basic Auth for `/admin`, `/api/admin/*`, `/api/jobs/*`
   - Bearer token bypass for cron jobs (`CRON_SECRET`)
   - Env vars: `ADMIN_BASIC_USER`, `ADMIN_BASIC_PASS`, `CRON_SECRET`

**Database Schema:**
```sql
CREATE TABLE job_runs (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  metrics JSONB,
  error TEXT
);
```

**Files Created/Modified:**
- `app/api/admin/migrate/route.ts` - Added Phase 3-4 table migrations
- `app/api/jobs/refresh-prices/route.ts` - New price refresh job endpoint
- `app/api/report/route.ts` - Added cached price lookup via LEFT JOIN
- `app/report/page.tsx` - Added Current Price column with status indicators
- `app/admin/page.tsx` - New admin dashboard
- `middleware.ts` - Added Basic Auth for admin routes
- `vercel.json` - Added cron schedule for price refresh

**Environment Variables Required:**
```
ADMIN_BASIC_USER=<admin username>
ADMIN_BASIC_PASS=<admin password>
CRON_SECRET=<secret for cron jobs>
```

---

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

## Completed Phases Summary

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Trade Ingestion + Alerts | ✅ Completed |
| 2 | Convergence Detection | ✅ Completed |
| 3 | Price Cache | ✅ Completed |
| 4 | Job Tracking + Admin | ✅ Completed |
| 5 | Conviction Sizing Anomalies | ✅ Completed |
| 6 | Market Resolution Detection | ✅ Completed |
| 7 | Longshot Position Archive | ✅ Completed |

## Remaining Phases (Planned)

### Phase 8: Position Accumulator
- Track positions across days
- Catch wallets buying $1K/day that cross $2.5K threshold
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
