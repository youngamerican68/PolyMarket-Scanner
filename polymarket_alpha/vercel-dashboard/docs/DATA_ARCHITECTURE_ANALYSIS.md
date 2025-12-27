# Comprehensive Trading/Accounting Data Analysis

**Date:** 2025-12-26
**Analyst:** Claude Code
**Scope:** Data collection, sync mechanisms, and completeness assessment

---

## Executive Summary

This system is designed to **capture longshot BUY trades** (≤25% odds, ≥$2,500 position value) from the Polymarket Data API. It does **NOT** capture all trades—it's a filtered alerting system for high-conviction bets on unlikely outcomes.

---

## A) Data Sources & Endpoints Inventory

| Source | Endpoint | What It Returns |
|--------|----------|-----------------|
| **Polymarket Data API** | `https://data-api.polymarket.com/trades?takerOnly=true&filterType=CASH&filterAmount=100` | Recent trades (taker-side only, ≥$100) |
| **Polymarket Data API** | `https://data-api.polymarket.com/positions?user={wallet}&limit=100` | Current open positions for a wallet |
| **Polymarket CLOB API** | `https://clob.polymarket.com/midpoint?token_id={asset}` | Current mid-price for an outcome |
| **Polymarket CLOB API** | `https://clob.polymarket.com/markets/{conditionId}` | Market resolution status |

---

## B) Manual Sync Button Trace

**File:** `app/api/positions/refresh/route.ts:304-417`

### Full Execution Path:

1. **Feature flag check** - Requires `ENABLE_POSITION_SYNC=true`
2. **Determine wallets to sync**:
   - `scope=wallets`: Use explicitly provided wallet list
   - `scope=filter`: Query `alert_events` to find wallets matching current dashboard filters
3. **TTL check** - Skip wallets synced within `SYNC_TTL_MS` (default 2 minutes)
4. **For each wallet** (concurrency=5):
   - Fetch positions from `https://data-api.polymarket.com/positions?user={wallet}&limit=100`
   - Query `alert_events` to get condition_id+outcome pairs for this wallet (last 72h)
   - For each dashboard row:
     - If position **found** in API response:
       - UPSERT to `position_sync_overlay` with `sync_status='synced'`, `position_state='open'`
       - Update both `synced_*` AND `last_known_*` columns
     - If position **NOT found** in API response:
       - UPSERT with `sync_status='not_found'`, `position_state='not_found_in_sync'`
       - **CRITICAL:** Does NOT overwrite `last_known_*` columns (preserves historical snapshot)
5. **Update `wallet_sync_state`** with sync timestamp and result

**Key Insight:** Manual sync only syncs positions that already have `alert_events` rows. It cannot discover new positions.

---

## C) Sync Semantics & Completeness

### Automated Trade Ingestion

**File:** `app/api/collect-trades/route.ts` (NOT configured as cron in vercel.json!)

> **IMPORTANT FINDING:** The `collect-trades` endpoint is NOT in `vercel.json` cron configuration. Only these crons are configured:
>
> ```json
> {
>   "crons": [
>     { "path": "/api/jobs/refresh-prices", "schedule": "0 0 * * *" },
>     { "path": "/api/jobs/refresh-baselines", "schedule": "0 12 * * *" }
>   ]
> }
> ```

### Ingestion Pipeline (when manually triggered):

1. Fetch recent trades: `takerOnly=true`, `filterAmount=100`, `limit=500`
2. Filter to **longshot candidates**: `side='BUY' AND price <= 0.25`
3. Generate dedupe ID: `{transactionHash}_{asset}_{side}_{timestamp}_{price}_{size}`
4. Check `alert_events` for existing dedupe IDs (skip duplicates)
5. For each new candidate:
   - Fetch positions for wallet
   - Match trade to position by `asset` + `conditionId` + `outcomeIndex`
   - **Qualification check:** `position.initialValue >= $2,500` OR `position.currentValue >= $2,500`
   - If qualified: INSERT to `alert_events`
   - Check for conviction sizing anomaly (if baseline exists)

### What Gets Filtered OUT:

| Filter | Location | Impact |
|--------|----------|--------|
| `side != 'BUY'` | `collect-trades/route.ts:101-103` | All SELL trades ignored |
| `price > 0.25` | `collect-trades/route.ts:101-103` | Trades at >25% odds ignored |
| `positionValue < $2,500` | `collect-trades/route.ts:216-219` | Small positions ignored |
| `takerOnly=true` | `polymarket.ts:77` | Maker trades invisible |
| No position match | `collect-trades/route.ts:197-200` | Trades without matching position skipped |

---

## D) Database Schema Inventory

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `alert_events` | Trade fill records that passed all filters | `wallet, condition_id, outcome, fill_price, fill_size, position_*` |
| `position_sync_overlay` | Real-time position snapshots | `synced_*, last_known_*, sync_status, position_state` |
| `wallet_sync_state` | Sync metadata per wallet | `last_synced_at, last_sync_status` |
| `market_status` | Market resolution tracking | `condition_id, market_resolved, winning_outcome` |
| `outcome_price_cache` | Current mid-prices | `condition_id, outcome, price, fetched_at` |
| `wallet_trade_size_baselines` | Conviction sizing baselines | `wallet, median_notional, mad, trade_count` |
| `conviction_anomalies` | Unusually large trades for a wallet | `wallet, trade_notional, ratio_to_median, severity` |
| `whale_watchlist` | Known whale wallets | `wallet, name, tier, category` |
| `job_runs` | Cron job execution tracking | `job_name, status, started_at, metrics` |

### Position Sync Overlay State Machine

```
position_state values:
  - 'open'               → Position found in latest sync
  - 'not_found_in_sync'  → Position not in API response (may be closed/redeemed)
  - 'closed_confirmed'   → Manually confirmed as closed
  - 'redeemed_confirmed' → Manually confirmed as redeemed
  - 'unknown'            → Initial state before any sync
```

### Safe State Model

The `position_sync_overlay` table implements a "Safe State Model" with two sets of columns:

- **`synced_*`** columns: Current API response values (can be NULL if not found)
- **`last_known_*`** columns: Preserved historical values (never overwritten with NULL)

This ensures that when a position disappears from the API (closed/redeemed), we still have the last known values for display and P&L calculation.

---

## E) Can We "Capture All Entries"?

### NO — By Design

This system is an **alerting system for interesting longshots**, not a comprehensive trade ledger. Specific gaps:

| Gap | Technical Reason | Impact |
|-----|------------------|--------|
| **SELL trades** | `side='BUY'` filter | Exit trades not captured |
| **High-odds trades** | `price <= 0.25` filter | Favorites ignored |
| **Small positions** | `$2,500 minimum` | Retail traders invisible |
| **Maker trades** | `takerOnly=true` API param | Limit orders not seen |
| **Historical trades** | No backfill mechanism | Only captures trades when cron runs |
| **Trades without open position** | `matchTradeToPosition` fails | Edge case: position closed between trade and fetch |

### What Would Be Needed for "All Entries":

1. Remove `takerOnly=true` from API call
2. Remove `side='BUY'` filter
3. Remove `price <= 0.25` filter
4. Remove `$2,500 minimum` check
5. Add historical backfill from genesis (Polymarket API supports pagination)
6. Run ingestion more frequently (currently appears to require manual trigger)

---

## F) Risks/Gaps for "Interesting Longshot Entries"

### Critical Gap: Trade Collection Not Automated

**Finding:** `vercel.json` does NOT include `/api/collect-trades` in the cron schedule:

```json
"crons": [
  { "path": "/api/jobs/refresh-prices", "schedule": "0 0 * * *" },
  { "path": "/api/jobs/refresh-baselines", "schedule": "0 12 * * *" }
]
```

**Impact:** Unless triggered manually or via external scheduler, no new trades are being ingested automatically.

### Other Gaps:

| Risk | Severity | Mitigation |
|------|----------|------------|
| Position fetch limit (100) | Medium | `atLimit` warning logged, but truncation possible |
| No historical backfill | High | System only captures trades prospectively |
| Trades landing between cron runs | Medium | Depends on how often collect-trades is triggered |
| Market closes before resolution check | Low | Daily resolution check covers most cases |
| Wallet positions closed before sync | Medium | `last_known_*` columns preserve historical values |

### Race Condition Protections (Well Designed):

- **Advisory locks** prevent overlapping cron jobs (`refresh-prices/route.ts:403-422`)
- **Dedupe IDs** prevent duplicate alert insertions (`collect-trades/route.ts:117-148`)
- **Quality-based tie-breakers** in position sync (`position_sync_overlay` concurrency model)
- **Safe State Model** preserves `last_known_*` when positions disappear

---

## Appendix: Key File References

| File | Purpose |
|------|---------|
| `app/api/collect-trades/route.ts` | Trade ingestion pipeline |
| `app/api/positions/refresh/route.ts` | Manual sync button handler |
| `app/api/jobs/refresh-prices/route.ts` | Price refresh + resolution check cron |
| `app/api/jobs/refresh-baselines/route.ts` | Conviction sizing baseline cron |
| `app/api/report/route.ts` | Dashboard data API |
| `lib/polymarket.ts` | Polymarket API client |
| `lib/dedupe.ts` | Trade deduplication logic |
| `lib/schemas.ts` | Zod validation schemas |
| `lib/migrations/*.sql` | Database schema definitions |

---

## Recommendations

1. **Add `/api/collect-trades` to vercel.json cron** - Currently not scheduled
2. **Consider more frequent trade collection** - Every 5-10 minutes to reduce gaps
3. **Add position limit increase** - 100 positions may truncate active traders
4. **Document the filtering intentionally** - Make clear this is an alerting system, not a ledger
5. **Add monitoring for ingestion gaps** - Alert if no trades collected in X hours
