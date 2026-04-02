# Polymarket Longshot Tracker - Progress

## Current Status: Live & Automated (last activity: 2026-04-01)

Dashboard URL: `https://poly-market-scanner.vercel.app`

---

## What We're Tracking

### Top Longshot Trades
- **Criteria:** $5K+ value trades at <25% odds
- **Data shown:**
  - Market title (clickable link to Polymarket)
  - Trader name/wallet (clickable link to profile)
  - Settled record (W-L for resolved bets)
  - Position status: Holding, Sold, or Hedge indicator
  - Current odds (live from Polymarket)
  - 24h Value (amount added in last 24 hours)
  - Total Position (full holding value: shares × current price)
  - Potential payout (if bet wins at $1/share)
- **Filtering:** Dropdown to filter by odds range (All <25%, <20%, <15%, <10%, <5%)

### Sharp Convergence Alerts
- **Criteria:** 2+ wallets independently betting on same longshot outcome
- **Minimum bet:** $5K per wallet
- **Maximum odds:** 25%
- **Signal:** Multiple sharp bettors agreeing = stronger conviction

### Hedge Detection
- **Indicator:** Balance scale emoji shown when wallet holds both sides of same market
- **Scope:** Same market only (not event-level hedging)

---

## Data Collection

### Automated Cron Job
- **Frequency:** Every 30 minutes via GitHub Actions
- **Endpoint:** `/api/collect-trades`
- **Process:**
  1. Fetches recent trades from Polymarket API (up to 10K per run)
  2. Stores in Vercel Postgres database
  3. Prunes trades older than 48 hours

### Database
- **Provider:** Vercel Postgres (Neon) - Free tier
- **Retention:** 48 hours rolling window
- **Capacity:** ~256 MB limit, currently using ~30 MB estimated
- **All trades stored** (not just longshots) for filter flexibility

### API Limits
- Polymarket: 10K trades per API call
- At current volume (~2K trades per 30 min), well under limit
- If volume spikes, can increase cron frequency to 15 minutes

---

## Decisions Made - Not Tracking

### Historical Win Tracking
- **What:** Track longshot winners over time to build "sharp" profiles
- **Why not:** Adds database complexity, would need separate tables for outcomes
- **Revisit if:** Want to surface "this trader has won 3 longshots this month"

### Event-Level Hedge Detection
- **What:** Detect hedges across different markets in same event (e.g., Fed rate bets)
- **Why not:** Complex to implement, event relationships not clean in API
- **Current approach:** User can eyeball related markets manually
- **Example:** sorcerer.05 betting "no change" AND "-25 bps" on Fed meeting - both are +EV if uncertain, not truly hedged

### Sub-$5K Trades
- **What:** Track smaller longshot bets
- **Why not:** Verified that sub-$5K trades at <10% odds are mostly $100-500 lottery tickets
- **Rationale:** Insiders with real information would bet larger amounts

### Settlement Anomalies
- **What:** Flag markets that settled unexpectedly
- **Why not:** Too noisy, not actionable for finding sharps

### Sold-Early Trades
- **What:** Include trades where position was already closed
- **Why not:** Can't verify if they won or lost, position size unknown
- **Current:** Only show trades where wallet is still holding

---

## Technical Stack

- **Frontend:** Next.js 14 + Tailwind CSS
- **Backend:** Next.js API routes
- **Database:** Vercel Postgres
- **Hosting:** Vercel (Hobby plan)
- **Cron:** GitHub Actions (Vercel cron limited to daily on free plan)
- **Data source:** Polymarket CLOB API + Gamma API

---

## December 19, 2024 - Auth Hotfix & Heartbeat Alignment

### Problem
- Data flow stopped due to auth header mismatch between GitHub Actions and API endpoints
- Route handlers checked spoofable `x-middleware-auth` header (security issue)
- Inconsistent auth: some endpoints expected `x-cron-secret`, others `Authorization: Bearer`
- Heartbeat reported false "stale" alarms (threshold was 6h but baselines run daily)

### Fix Applied
1. **Created `lib/cronAuth.ts`** - Shared auth helper using `crypto.timingSafeEqual`
2. **Standardized auth** - All cron routes now accept `Authorization: Bearer <CRON_SECRET>` (preferred) or `x-cron-secret` (legacy)
3. **Removed spoofable headers** - No more `x-middleware-auth` trust pattern
4. **Fixed heartbeat threshold** - Changed from 360 min (6h) to 1440 min (daily)
5. **Added missing secret** - `REFRESH_BASELINES_URL` was missing from GitHub Actions

### Verification
- All three GitHub Actions workflows passing:
  - `Collect Trades` - every 5 minutes
  - `Refresh Prices` - every 10 minutes
  - `Refresh Baselines` - daily at 2 AM UTC
- Heartbeat endpoint: `GET /api/ops/health/heartbeat` (requires `OPS_SECRET`)

### Commit
`99a2c94` - fix: standardize cron auth; remove x-middleware-auth; align heartbeat schedule

---

## Local Gap Detection Runbook

To check database freshness locally (useful for debugging data flow issues):

```bash
# 1. Pull production env vars
cd polymarket_alpha/vercel-dashboard
vercel env pull .env.local --environment=production

# 2. Export DATABASE_URL (Vercel uses POSTGRES_URL)
export DATABASE_URL=$(grep '^POSTGRES_URL=' .env.local | cut -d= -f2- | tr -d '"')

# 3. Run gap detection (from repo root)
cd ../..
TRADES_TABLE="alert_events" TRADES_TS_COLUMN="fill_timestamp" ./gap_detect_db.sh
```

**Key tables:**
- `alert_events.fill_timestamp` - Dashboard reads from this (use for monitoring)
- `trades.created_at` - Raw trade ingestion (legacy, may be stale)

---

## December 19, 2025 - Credential Rotation & Gap Analysis

### Credential Rotation
Database credentials were rotated after being visible in debug sessions:
1. Reset Neon database password via console (Branches → Roles & Databases)
2. Updated `POSTGRES_URL` in Vercel environment variables
3. Redeployed to pick up new credentials

### Gap Analysis Findings
Investigated apparent "stale data" alerts from gap detection scripts.

**Root Cause:** Scripts were checking wrong table (`trades.created_at`) instead of dashboard source (`alert_events.fill_timestamp`).

**Key Metrics (verified healthy):**
| Metric | Value | Status |
|--------|-------|--------|
| Insert freshness (`created_at` lag) | ~22 min | ✓ Normal |
| Event freshness (`fill_timestamp` lag) | ~22 min | ✓ Normal |
| Max ingestion delay (6h) | 11 min | ✓ Healthy |
| Rows per hour | ~24 | Expected for filtered data |

**Important Distinction:**
- `fill_timestamp` = when trade occurred on Polymarket
- `created_at` = when row was inserted into our DB

Empty 5-minute buckets are **expected** - they represent quiet market periods with no qualifying trades ($5K+ at <25% odds), not ingestion failures.

**For true ingestion liveness monitoring**, use `created_at` column:
```bash
TRADES_TABLE="alert_events" TRADES_TS_COLUMN="created_at" ./gap_detect_db.sh
```

---

## Checkpoint & Rollback System

Scripts added for creating snapshots and rolling back to known-good states:

    ./scripts/checkpoint.sh              # Create tagged snapshot
    ./scripts/rollback.sh <TAG>          # Restore to checkpoint
    ./scripts/healthcheck.sh             # Verify DB freshness

See `CHECKPOINT.md` for full usage instructions.

---

## Price Staleness

GitHub Actions cron schedules are best-effort and may be delayed during high-load periods.
When prices are stale (>30 minutes since last refresh):
- Dashboard still shows all in-scope trades
- Stale prices display with yellow "⚠ Xm ago" indicator showing age
- Missing prices show "No price yet" but row still appears

This does NOT indicate missing trades - only that the price refresh job hasn't run recently.
The `refresh-prices` job queries distinct outcomes from the last 72 hours of `alert_events`,
so all trades will eventually get prices when the job runs.

---

## Market Resolution Detection (Phase 6)

Markets that have settled/resolved are now hidden by default to reduce noise.

### How It Works
- The `refresh-prices` job also checks market resolution status via CLOB API
- Resolution status is stored in the `market_status` table with first-seen timestamps
- Dashboard hides resolved markets by default; use "Show Resolved" checkbox to include them
- Resolved rows appear with 50% opacity and a `RESOLVED` badge

### Database Table: `market_status`
| Column | Type | Description |
|--------|------|-------------|
| condition_id | TEXT PK | Market identifier |
| market_closed | BOOLEAN | Market closed for trading |
| market_resolved | BOOLEAN | Market has a winning outcome |
| winning_outcome | TEXT | The winning outcome (e.g., "Yes", "No") |
| market_closed_first_seen_at | TIMESTAMPTZ | When we first detected closure |
| market_resolved_first_seen_at | TIMESTAMPTZ | When we first detected resolution |
| updated_at | TIMESTAMPTZ | Last status check |

### UI Changes
- New "Show Resolved" checkbox in filters section (default: unchecked)
- Resolved rows display with `opacity-50` styling
- `RESOLVED` badge shows next to market title, with winning outcome in tooltip

### API Parameter
- `includeResolved=true` to include resolved markets in report response
- Default behavior excludes resolved markets

---

## February 7, 2026 - Critical Fixes (Collect Trades & Stale Prices)

### Problem 1: Collect Trades Failing with HTTP 400
All `collect-trades` workflow runs were failing with:
```
Fatal: HTTP 400: Bad Request
{"error":"max historical activity offset of 3000 exceeded"}
```

**Root Cause:** Polymarket's Data API has an undocumented **max offset of 3000**. Our code had `MAX_PAGES=120` with `PAGE_SIZE=500`, which would try offsets up to 59,500.

**Fix Applied:**
1. Reduced `MAX_PAGES` from 120 to 6 (max offset 2500, safely under limit)
2. Added graceful handling for offset limit error - returns `hitOffsetLimit: true` instead of throwing
3. Updated `fetchRawTrades()` to detect and handle the specific 400 error

**Commits:** `7ec051d`, `d570fcd`

### Problem 2: Radar Showing Stale Current Values
Position "Current Value" was wildly off from Polymarket (e.g., $87K vs $111K for same position).

**Root Cause:** Radar relied on `outcome_price_cache` table which is only refreshed hourly by `refresh-prices` job. When prices moved significantly, Current Value became stale.

**Fix Applied:**
1. Radar now fetches **live CLOB prices** directly from midpoint API
2. Added `fetchFreshPrice()` and `fetchFreshPrices()` functions
3. Fetches in batches of 20 to avoid rate limiting
4. Falls back to cached price only if CLOB fetch fails
5. Added `asset` field to SQL query for token ID lookup

**Commits:** `715aaa8`, `d570fcd`

### Problem 3: Cron Schedule Not Taking Effect
Workflow runs were still happening every 10 minutes despite changing to hourly.

**Root Cause:** Commit changing cron schedule was never **pushed** to remote. GitHub Actions uses the schedule from the remote branch, not local.

**Fix Applied:** Pushed the commit. Schedule changes require push to take effect.

### Updated Cron Schedules
| Workflow | Schedule | Purpose |
|----------|----------|---------|
| collect-trades | Hourly at :05 | Ingest new trades |
| refresh-prices | Hourly at :15 | Update CLOB prices & check resolutions |
| sync-positions | Hourly at :30 | Sync position overlays |

### API Limits Discovered
| API | Limit | Notes |
|-----|-------|-------|
| Polymarket Data API | max offset 3000 | Returns HTTP 400 if exceeded |
| CLOB midpoint | No documented limit | Batch requests to avoid rate limiting |

---

## Future Considerations

- Increase cron to 15-minute intervals if trade volume grows
- Historical win tracking if want to identify consistently profitable wallets
- Alert system (email/Discord) when new sharp convergence detected
- Extend retention beyond 48 hours for trend analysis
