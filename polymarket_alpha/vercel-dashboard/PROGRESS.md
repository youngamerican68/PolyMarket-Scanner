# Polymarket Tracker - Development Progress

## Session: December 28, 2025 (Sync-Positions Wallet Sourcing Fix)

### Bug: 291 Snapshot Wallets Not Being Synced (Fixed)

**Symptom:** Reconciliation analysis showed 291 wallets existed in `wallet_position_snapshot` but were never picked up by the `sync-positions` job. These wallets had unresolved positions that weren't being refreshed.

**Root Cause:** The `sync-positions` job only sourced wallets from `alert_events` with:
- `fill_timestamp >= 72 hours ago`
- `position_current_value IS NOT NULL`

This missed wallets that:
- Had older alert_events (>72h)
- Still had unresolved positions captured in snapshot

**Fix:** Unified wallet sourcing from both `alert_events` AND `wallet_position_snapshot`:

```typescript
// New wallet selection combines both sources
WITH
  unresolved_conditions AS (...),  -- Consistent predicate
  alert_wallets AS (...),          -- From alert_events (72h)
  snapshot_wallets AS (...),       -- From wallet_position_snapshot
  combined_wallets AS (UNION ALL),
  deduped_wallets AS (GROUP BY wallet),
  wallet_with_overlay AS (LEFT JOIN wallet_sync_state)
SELECT wallet ORDER BY priority ASC, last_activity DESC
```

**Priority-Based Selection:**
| Priority | Status | Description |
|----------|--------|-------------|
| 1 | missing | No wallet_sync_state row |
| 2 | never_synced | Row exists, last_synced_at IS NULL |
| 3 | stale | last_synced_at > 30 min ago |
| 4 | fresh | Recently synced |

**New Metrics:**
```json
{
  "fromAlertEvents": 84,
  "fromSnapshot": 63,
  "missingOverlay": 0,
  "staleOverlay": 75,
  "unresolvedNotInOverlay": 7
}
```

**Result:** `unresolvedNotInOverlay` dropped from **291 → 7** (97.6% reduction) on first run after deployment.

**Migration 006:** Added performance indexes for new query patterns:
- `idx_alert_events_fill_ts_condition` - 72h window scan
- `idx_alert_events_wallet_fill_condition` - per-wallet lookups
- `idx_wallet_position_snapshot_condition` - condition_id lookups
- `idx_wallet_position_snapshot_wallet_condition` - wallet + condition
- `idx_wallet_sync_state_wallet_last_synced` - overlay freshness
- `idx_position_sync_overlay_reconciliation` - reconciliation check

**Commit:** `4b49453` - fix(sync-positions): unify wallet sourcing from alert_events + snapshot

**Files Created/Modified:**
- `app/api/jobs/sync-positions/route.ts` - Unified wallet sourcing
- `lib/migrations/006_sync_positions_indexes.sql` - New indexes
- `tests/sync-positions-wallet-selection.test.ts` - Regression tests

---

### Known Issue: 100-Position Truncation (Future TODO)

**Observation:** Multiple wallets hit the 100-position fetch limit:
```
[fetchPositionsWithRetry] Wallet 0x... returned 100 positions (at limit, may be truncated)
```

**Impact:** Wallets with >100 positions may have incomplete data in the overlay.

**Future Fix:** Add pagination to `fetchPositionsWithRetry()` to loop until `results.length < limit`.

**Priority:** Low - doesn't affect wallet sourcing fix, only affects large position counts for specific wallets.

---

## Session: December 28, 2025 (Sync Overlay Hardening)

### Comprehensive Sync Overlay Hardening (Completed ✅)

**Problem:** Persistent "missing overlay" backlog despite wallet sourcing fix. Root causes:
1. "Overlay row exists" was ambiguously defined
2. Stub rows with NULL fields were masking missing data
3. No observability into sync runs

**Result:** Backlog drained from **341 → 32** (steady-state). The 32 remaining are "phantom" positions where snapshot says shares > 0 but API returns not_found.

**Solution: 6-Part Hardening**

#### A) Rule A: "Overlay row exists" = `sync_status='synced' AND synced_at IS NOT NULL`

Updated all queries to use this strict definition:
- `getWalletsToSync()` - backlog_wallets CTE
- `countUnresolvedSnapshotWalletsNotInOverlay()` - reconciliation check
- Ensures stub rows are never counted as "synced"

#### B) Backlog-First Wallet Selection

New priority order:
| Priority | Category | Description |
|----------|----------|-------------|
| 1 | Backlog | Snapshot positions with no valid overlay (Rule A) |
| 2 | Lagging | `snapshot.updated_at > overlay.synced_at + 10min` |
| 3 | Stale | Overlay older than 30 minutes |
| 4-6 | Fresh | Source-based (alert_events, snapshot, other) |

**New metrics:**
- `walletsFromBacklog` - Priority 1 wallets selected
- `walletsFromLagging` - Priority 2 wallets selected

#### C) Prevent Stub Rows

Schema constraints ensure no NULL-stub rows can be created:
- `wallet`, `condition_id`, `outcome` are all `NOT NULL`
- `sync_status` defaults to `'pending'` and is `NOT NULL`
- `CHECK (sync_status IN ('pending', 'synced', 'not_found', 'error'))`
- `CHECK (sync_status <> 'synced' OR synced_at IS NOT NULL)`

#### D) Schema Hardening (Migration 007)

```sql
-- Key columns NOT NULL
ALTER TABLE position_sync_overlay
  ALTER COLUMN wallet SET NOT NULL,
  ALTER COLUMN condition_id SET NOT NULL,
  ALTER COLUMN outcome SET NOT NULL;

-- sync_status validation
ALTER TABLE position_sync_overlay
  ADD CONSTRAINT chk_sync_status
  CHECK (sync_status IN ('pending', 'synced', 'not_found', 'error'));

-- synced_at required when synced
ALTER TABLE position_sync_overlay
  ADD CONSTRAINT chk_synced_at_required
  CHECK (sync_status <> 'synced' OR synced_at IS NOT NULL);
```

#### E) Data Cleanup (Migration 007)

Migration 007 sections run in order:
1. Normalize empty strings to NULL
2. Delete rows with NULL key columns
3. Fix invalid sync_status values
4. Ensure synced rows have synced_at
5. Mark incomplete stub rows as error
6. **Deduplicate rows** before adding unique index

```sql
-- Dedupe keeping best row per key
WITH ranked AS (
  SELECT ctid, ROW_NUMBER() OVER (
    PARTITION BY wallet, condition_id, outcome
    ORDER BY synced_at DESC NULLS LAST, last_nonzero_at DESC NULLS LAST
  ) AS rn
  FROM position_sync_overlay
)
DELETE FROM position_sync_overlay p
USING ranked r
WHERE p.ctid = r.ctid AND r.rn > 1;
```

#### F) Observability Tables

```sql
CREATE TABLE position_sync_run (
  id UUID PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
  wallets_requested INT,
  wallets_synced INT,
  wallets_failed INT,
  positions_upserted INT,
  positions_not_found INT,
  backlog_wallets_selected INT,
  lagging_wallets_selected INT,
  error_message TEXT,
  metrics JSONB
);

CREATE TABLE position_sync_run_wallet (
  run_id UUID REFERENCES position_sync_run(id),
  wallet TEXT NOT NULL,
  selection_reason TEXT NOT NULL, -- 'backlog'|'lagging'|'stale'|...
  status TEXT NOT NULL,
  positions_synced INT,
  positions_not_found INT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, wallet)
);
```

**Files Created/Modified:**
- `app/api/jobs/sync-positions/route.ts` - Backlog-first selection, new metrics
- `lib/migrations/007_sync_overlay_hardening.sql` - Schema + cleanup + observability

**Commits:**
- `34af8b9` - feat(sync-positions): backlog-first selection + schema hardening
- `f120b96` - fix(sync-positions): exclude resolved markets from backlog metric

**Verification Results (Post-Migration 007):**
```sql
-- All checks passed
null_status: 0      -- No NULL sync_status
bad_synced: 0       -- No synced rows without synced_at
empty_keys: 0       -- No empty/whitespace keys
```

**Steady-State Explanation:**
The 32 remaining backlog wallets are "phantom" positions:
- Snapshot has `shares > 0` for unresolved markets
- API returns "not found" (position closed/redeemed)
- These retry each run (aggressive retry strategy)
- Will clear when markets resolve or snapshots update

**Logs to Monitor:**
```json
{
  "fromBacklog": 0,           // Should stay near 0
  "fromLagging": 0,           // Occasional spikes OK
  "unresolvedNotInOverlay": 32 // Steady-state (phantom positions)
}
```

---

## Session: December 28, 2025 (Convergence Wallet Details Fix)

### Bug: Convergence Tabs Not Expanding for Resolved Markets (Fixed)

**Symptom:** Clicking convergence rows did nothing. Groups showed "Wallets: 3" but "Total Cost / Value: $0 / $0".

**Root Cause:** The wallet details query was **recomputing** group qualification independently from the aggregate query. For resolved markets, `outcome_price_cache.price` is NULL, causing `effective_current_value` calculations to fail and produce different group keys than the aggregate query already determined.

**Fix:** Pass known group keys from `groupMap` to wallet details query using JSON (since sql template doesn't support arrays). Applied to all 4 `filterMode` cases (both, whalesOnly, categoryOnly, none).

```typescript
// Build JSON of known groups from aggregate query
const knownGroupsJson = JSON.stringify(
  Array.from(groupMap.values()).map(g => ({
    condition_id: g.conditionId,
    outcome: g.outcome
  }))
);
```

```sql
-- In SQL, extract with jsonb_array_elements
WITH known_groups AS (
  SELECT elem->>'condition_id' as condition_id, elem->>'outcome' as outcome
  FROM jsonb_array_elements(${knownGroupsJson}::jsonb) as elem
),
deduped AS (
  ...
  INNER JOIN known_groups kg ON ae.condition_id = kg.condition_id AND ae.outcome = kg.outcome
  ...
)
```

**Result:** -166 lines of redundant recomputation logic, +69 lines using known keys. Wallet details now always match aggregate groups.

**Commit:** `6aeed26` - fix(convergence): use known group keys for wallet details query

**Files Modified:**
- `app/api/report/route.ts`

---

## Session: December 27, 2025 (GitHub Actions Job Logging)

### GitHub Actions job_runs Logging (Completed)

**Goal:** Make the GitHub Actions–scheduled `collect-trades` job log to the same `public.job_runs` table that Vercel jobs use, enabling heartbeat monitoring visibility.

**Implementation:**

1. **New Script:** `scripts/gha-job-logger.ts`
   - Direct PostgreSQL connection to Neon (via `pg` package)
   - Commands: `sanity-check`, `start <job_name>`, `finish <id> success|error`
   - SSL with fallback for CI environments
   - Prints only sanitized host/db (never secrets)
   - Adds `source: "github-actions"` to metrics for disambiguation

2. **Workflow Updates:** `.github/workflows/collect-trades.yml`
   - Checkout repo, setup Node 20, `npm ci`
   - DB sanity check before starting
   - Insert `job_runs` row with `status='running'` at start
   - EXIT trap updates to `success` or `error` on completion
   - Guard against empty `JOB_RUN_ID` if start fails

3. **Dependencies:** Moved `pg` from devDependencies to dependencies (runtime dep for GHA)

**Required GitHub Secret:**
- `POSTGRES_URL` - Neon connection string with `sslmode=require`

**Metrics JSONB includes:**
- `source`: `"github-actions"` (vs absent for Vercel-logged)
- `gha.git_sha`: Short commit hash (8 chars)
- `gha.workflow_run_id`: GitHub Actions run ID
- `gha.run_number`: Sequential run number
- `gha.workflow`: Workflow name
- `gha.actor`: GitHub user who triggered

**Verification SQL:**
```sql
SELECT id, status, started_at, finished_at,
       metrics->>'source' as source,
       metrics->'gha'->>'workflow_run_id' as gha_run_id,
       metrics->'gha'->>'git_sha' as git_sha
FROM public.job_runs
WHERE job_name = 'collect-trades'
ORDER BY started_at DESC
LIMIT 5;
```

**Files Created/Modified:**
- `scripts/gha-job-logger.ts` (new)
- `scripts/verify-job-runs-schema.ts` (new - schema verification utility)
- `.github/workflows/collect-trades.yml`
- `package.json`
- `docs/ops.md`

---

## Session: December 24, 2025 (Phase 10 + UI Fixes)

### Phase 10: Position Sync Overlay (Completed)

**Goal:** On-demand refresh of position data from Polymarket API to show real-time position values (not just stale snapshots from trade ingestion).

**Feature Flag:** `ENABLE_POSITION_SYNC=true`

**New Tables:**
```sql
CREATE TABLE position_sync_overlay (
  wallet TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  synced_position_size NUMERIC,
  synced_avg_price NUMERIC,
  synced_current_value NUMERIC,
  synced_payout_if_wins NUMERIC,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sync_status TEXT NOT NULL DEFAULT 'synced',
  sync_error TEXT,
  PRIMARY KEY (wallet, condition_id, outcome)
);

CREATE TABLE wallet_sync_state (
  wallet TEXT PRIMARY KEY,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sync_status TEXT NOT NULL DEFAULT 'pending',
  last_sync_error TEXT,
  positions_count INTEGER,
  last_sync_duration_ms INTEGER
);
```

**How It Works:**
1. User clicks "Refresh Positions" button in dashboard
2. POST to `/api/positions/refresh` with current filter params
3. API fetches positions from Polymarket for wallets in scope
4. Overlays stored in `position_sync_overlay` table
5. UI displays synced values with "⟳ Xm ago" indicator

**UI Components:**
- `SyncedPayoutIfWins` - Shows synced payout with freshness indicator
- `SyncedPositionCostValue` - Shows synced cost/value with freshness indicator
- Position values show "(closed)" when sync_status='not_found'

**TTL:** 2-minute cache per wallet to prevent excessive API calls

**Files Created/Modified:**
- `app/api/positions/refresh/route.ts` - POST (sync) + GET (status) endpoints
- `app/api/report/route.ts` - LEFT JOIN to overlay, synced fields in response
- `app/report/page.tsx` - Refresh button, synced components
- `app/api/admin/migrate/route.ts` - Phase 10 migration

---

### UI Fix: Million Dollar Formatting (Completed)

**Problem:** Large values like $3,163,600 displayed as "$3163.6K" which is hard to read.

**Solution:** Updated `formatMoney()` in all 6 locations to use millions format:
- `>= $1,000,000` → `$3.16M` (2 decimal places)
- `>= $1,000` → `$163.6K` (1 decimal place)
- `< $1,000` → `$500` (whole dollars)

**Files Modified:**
- `app/report/page.tsx`
- `app/api/report/route.ts`
- `app/api/whale-trades/route.ts`
- `app/api/longshot-history/route.ts`
- `app/api/daily-report/route.ts`
- `lib/scoring.ts`

---

### UI Fix: Consistent Payout if Wins in All Longshot Trades (Completed)

**Problem:** Multiple trades from the same wallet in the same market showed different "Payout if Wins" values because each row used its historical position snapshot.

**Example:** Arbguy on "Epstein client list 2025" showed $39K for one trade and $45.5K for another, even though it's the same total position.

**Solution:** Added CTE to fetch latest position_size for each (condition_id, outcome, wallet):
```sql
WITH latest_positions AS (
  SELECT DISTINCT ON (condition_id, outcome, wallet)
    condition_id, outcome, wallet, position_size as latest_position_size
  FROM alert_events
  WHERE fill_timestamp >= ${alertCutoff}::timestamptz
  ORDER BY condition_id, outcome, wallet, fill_timestamp DESC
)
SELECT ..., lp.latest_position_size, ...
FROM alert_events ae
LEFT JOIN latest_positions lp ON ...
```

Now all trades from the same wallet/market show the **same (latest) payout value**.

**Files Modified:**
- `app/api/report/route.ts` - All 4 alert query branches updated

---

### Commits
- `2e21961` - feat: add currentPrice to convergence/large single bet wallets
- `ee47c5e` - ui: format large numbers as X.XXM instead of XXXXK
- `82089d2` - fix: use latest position snapshot for Payout if Wins

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
| 8 | Finalize Resolved P&L | ✅ Completed |
| 9 | Position Snapshots + Estimated P&L | ✅ Completed |
| 10 | Position Sync Overlay | ✅ Completed |

---

## Session: December 20, 2025 (Resolved Market Filtering Fixes)

### Issue: Completed Games Still Showing in Dashboard

**Problem:** Resolved markets (e.g., Eagles vs. Commanders) were still appearing in Convergence and other dashboard views even after markets had resolved on Polymarket.

**Root Causes Identified:**

1. **Filter Inconsistency**: Wallet detail queries used a simpler `market_resolved = TRUE` filter while aggregation queries required `market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != ''`

2. **Refresh Scope Too Narrow**: The refresh-prices job only checked markets from a 14-day window with 500 limit, missing markets that fell outside this scope

3. **404 Noise**: Resolved markets returned 404 from CLOB midpoint API (closed order books), counted as failures

4. **Convergence Enrichment Bug**: Enrichment query scanned all `alert_events` instead of using collected `conditionIds` from groups

### Fixes Implemented

**1. EXISTS Predicate Standardization** (commit `66c11ae`)
- All wallet detail queries now use correlated `EXISTS/NOT EXISTS` predicates
- Consistent filter: `market_resolved = TRUE AND winning_outcome IS NOT NULL AND TRIM(winning_outcome) != ''`
- Added table alias `ae` to support correlated subqueries

**2. Partial Index for Performance** (commit `4fee918`)
```sql
CREATE INDEX idx_market_status_resolved_winner
ON market_status (condition_id)
WHERE market_resolved = TRUE
  AND winning_outcome IS NOT NULL
  AND TRIM(winning_outcome) != '';
```

**3. DB-Driven Refresh Scope** (commit `e0e3fd5`)
- Resolution check now queries all `condition_ids` from `alert_events` NOT already resolved
- Uses `NOT EXISTS` to find markets missing from `market_status` or without known winner
- Removes arbitrary 14-day window dependency

**4. Skip Resolved Markets for Midpoint** (commit `e0e3fd5`)
- Price fetching now excludes markets already marked resolved
- New metric: `skippedResolved` tracks skipped assets
- Eliminates 404 noise from closed order books

**5. Convergence Enrichment Fix** (commit `dbe73ed`)
- Changed enrichment query to use collected `conditionIds` array
- Uses `jsonb_array_elements_text()` for efficient array matching
- Fixes badges not showing for resolved markets in Convergence view

### New Metrics in refresh-prices

| Metric | Description |
|--------|-------------|
| `skippedResolved` | Assets skipped due to already being resolved |
| `marketsResolved` | Newly resolved markets found this run |

### Sample Job Output (After Fixes)
```json
{
  "requested": 61,
  "updated": 60,
  "failed": 1,
  "skippedResolved": 106,
  "marketsResolved": 1
}
```
vs previous: 106 "failures" from 404s

### Deployment Steps

1. Deploy code changes
2. `POST /api/admin/migrate` - Creates partial index
3. Trigger refresh-prices to backfill `market_status`
4. Verify resolved markets disappear from unresolved views

### Files Modified
- `app/api/report/route.ts` - EXISTS predicates, enrichment fix
- `app/api/jobs/refresh-prices/route.ts` - DB-driven scope, skip resolved
- `app/api/admin/migrate/route.ts` - Partial index

### Note on Resolution Timing
Polymarket resolves markets with a delay after events end. If a game is over but still showing, check the CLOB API:
```bash
curl "https://clob.polymarket.com/markets/{condition_id}" | jq '{closed, tokens}'
```
If `closed: false`, Polymarket hasn't resolved it yet.

---

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

## Session: December 21, 2025 (Phase 8-9: Final P&L + Position Snapshots)

### Phase 8: Finalize Resolved P&L (Completed)

**Problem:** Position data becomes stale because we capture snapshots at trade ingestion time. If a trader continues buying after our last alert, the final P&L displayed is incorrect.

**Solution:** When a market resolves, fetch current positions from Polymarket API and store final P&L.

**New Table:**
```sql
CREATE TABLE market_final_pnl (
  condition_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  outcome TEXT NOT NULL,
  position_found BOOLEAN NOT NULL DEFAULT FALSE,
  shares NUMERIC,
  avg_price NUMERIC,
  potential_win NUMERIC,
  cost_basis NUMERIC,
  final_pnl NUMERIC,
  winning_outcome TEXT NOT NULL,
  finalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (condition_id, wallet, outcome)
);
```

**New Column:**
- `market_status.finalized_at` - Tracks when P&L finalization ran for each market

**Files Created/Modified:**
- `lib/finalize-resolved-pnl.ts` - Core finalization logic
- `app/api/admin/finalize-resolved-pnl/route.ts` - Manual endpoint for backfill
- `app/api/jobs/refresh-prices/route.ts` - Integrated automatic finalization
- `app/api/report/route.ts` - Returns finalPnl, finalPositionFound fields
- `app/report/page.tsx` - ActualPnL/ConvergenceWalletPnL components

---

### Phase 9: Position Snapshots + Estimated P&L (Completed)

**Problem:** Polymarket positions API only returns open positions. Once markets resolve and positions are redeemed, they disappear from the API. Phase 8's "fetch on resolution" approach can't reliably get final positions.

**Solution:** Continuously snapshot open positions before resolution, then use those snapshots to estimate P&L when API positions are unavailable.

**New Table:**
```sql
CREATE TABLE wallet_position_snapshot (
  wallet TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  shares DOUBLE PRECISION NOT NULL,
  avg_price DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wallet, condition_id, outcome)
);
```

**New Columns on market_final_pnl:**
- `is_estimated BOOLEAN` - Whether P&L is estimated vs exact
- `estimate_source TEXT` - 'position_snapshot' or 'alert_snapshot'
- `estimate_as_of TIMESTAMPTZ` - When the source snapshot was taken

**How It Works:**

1. **Position Snapshotting** (refresh-prices cron):
   - Every 10 minutes, fetch open positions for tracked wallets
   - Upsert to `wallet_position_snapshot` table
   - Defensive avgPrice normalization (if >1, assume 0-100 scale)

2. **Finalization Fallback** (finalize-resolved-pnl):
   - First tries Polymarket API (usually empty for resolved markets)
   - Falls back to `wallet_position_snapshot` → `is_estimated=true, estimate_source='position_snapshot'`
   - Falls back to `alert_events` → `is_estimated=true, estimate_source='alert_snapshot'`
   - If neither available → `final_pnl=NULL`

3. **UI Display:**
   - Exact P&L: `+$X` or `-$X` (bold)
   - Estimated P&L: `~+$X` or `~-$X` (with tooltip, slightly transparent)
   - No data: "P&L unavailable"
   - Not yet finalized: "Pending..."

**Files Modified:**
- `app/api/admin/migrate/route.ts` - Phase 9 migration
- `app/api/jobs/refresh-prices/route.ts` - Position snapshotting
- `lib/finalize-resolved-pnl.ts` - Snapshot fallback logic
- `app/api/report/route.ts` - Estimate metadata fields
- `app/report/page.tsx` - Estimated vs exact P&L display

**Deployment Steps:**
1. Deploy code
2. Enable `ENABLE_ADMIN_MIGRATIONS=true` in Vercel
3. Run migration: `POST /api/admin/migrate`
4. Wait for refresh-prices cron (or trigger manually) to populate snapshots
5. Run finalization: `POST /api/admin/finalize-resolved-pnl`
6. Disable `ENABLE_ADMIN_MIGRATIONS=false`

**Limitations:**
- Already-resolved markets without snapshots will show estimates from alert_events (may be stale)
- Accuracy improves over time as more snapshots accumulate before resolution

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
| 8 | Finalize Resolved P&L | ✅ Completed |
| 9 | Position Snapshots + Estimated P&L | ✅ Completed |

## Session: December 21, 2025 (UI Consistency & Table Alignment)

### UI Fixes: Table Column Consistency (Completed)

**Problem:** Tables had inconsistent columns and confusing labels:
- "Fill Price" vs "Position Value" semantics unclear (per-trade vs total position)
- "Position Value" showed even when "Current Price" was missing
- Tables had different column structures making comparison difficult

**Solution:** Standardized all tables with consistent columns and clear labeling.

### Column Naming Standardization

**Renamed for clarity:**
- `Fill Price` → `Last Fill Price` (per-trade, not position)
- `Fill Value` → `Last Fill Value` (per-trade, not position)
- `Position Value` → `Position Cost / Value` (shows both cost basis and current value)

**Format:** `$COST / $VALUE` or `$COST / —` if no current price available

### New Components

**PositionCostValue** (for AlertRow tables):
```typescript
// Computes from normalized prices for consistency
const positionCost = shares * normalizeProb(avgEntry)
const positionValue = shares * normalizeProb(currentPrice) // only if available
// Displays: "$8.4K / $12.1K" or "$8.4K / —"
```

**ConvergencePositionCostValue** (for ConvergenceWallet tables):
```typescript
// ConvergenceWallet lacks currentPrice, so value always shows "—"
// Displays: "$8.4K / —"
```

### Table Column Alignment

| Table | Columns | Notes |
|-------|---------|-------|
| All Longshot Trades | 9: Market, Trader, Last Fill Price, Current Price, Last Fill Value, Position Cost/Value, Pos Avg Entry, Potential Win, Time | Full data available |
| Whale Trades | 9: Same as above | Full data available |
| Convergence | 6: Wallet, Last Fill Price, Pos Avg Entry, Position Cost/Value, Potential Win, Time | No currentPrice in ConvergenceWallet |
| Large Single Bets | 6: Same as Convergence | No currentPrice in ConvergenceWallet |

### Key Behavior Fixes

1. **"No price yet" + Position Value** - Previously showed a value even without current price. Now shows `$COST / —`

2. **Consistent Potential Win** - Uses `calcPotentialWinUsd()` with normalized prices across all tables

3. **Dev-only sanity check** - Console warning in dev mode when currentPrice ≤ 0.5% but positionValue ≥ $1K (helps detect cross-wiring)

### Sorting Removed

Removed interactive column sorting from All Longshot Trades table for simplicity. Data displays in API-provided order.

### Files Modified
- `app/report/page.tsx` - All UI changes

### Commits
- `a5c7263` - Remove table sorting
- `6658748` - Add PositionCostValue component for consistent display
- `c5c3fcb` - Rename Fill Price/Value to Last Fill Price/Value
- `bcc2682` - Apply Last Fill Price to all tables
- `889f092` - Align all tables with Position Cost / Value column

---

## Remaining Phases (Planned)

### Phase 11: Position Accumulator (Future)
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
