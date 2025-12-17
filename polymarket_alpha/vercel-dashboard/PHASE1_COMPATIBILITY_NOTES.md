# Phase 1 Compatibility Notes

**Status: DEPLOYED AND OPERATIONAL** (December 2024)

This document captures important context and decisions for Phase 1 that future phases must respect.

## Deployment Status

- [x] Database migration (`alert_events` table) - Complete
- [x] Ingestion endpoint (`POST /api/collect-trades`) - Secured with `CRON_SECRET`
- [x] GitHub Actions cron job - Running every 5 minutes
- [x] Dashboard APIs - Querying `alert_events` only
- [x] UI updates - All three dashboards showing consistent data
- [x] Data accuracy verified against Polymarket profiles

## Critical: Do NOT Re-introduce These Problems

### 1. Float Math Errors
- **Problem**: JavaScript float multiplication causes precision errors (e.g., `0.1 * 0.2 !== 0.02`)
- **Solution**: All fill_value_usd calculations use `decimal.js-light`
- **Future phases**: NEVER use native `*` or `/` for money calculations

### 2. Empty String Coercion
- **Problem**: `z.coerce.number()` turns `""` into `0`, hiding missing data
- **Solution**: Custom Zod preprocessors that reject empty strings
- **Future phases**: Always use `requiredNumber`, `optionalNumber`, `requiredInt`, `optionalInt` from `/lib/schemas.ts`

### 3. Transaction Hash Fallback
- **Problem**: Some trades may arrive without `transactionHash` (API quirks)
- **Solution**: Deterministic fallback ID format that's still unique
- **Future phases**: Never assume transactionHash exists; always use `generateTradeDedupeId()`

### 4. Timestamp Format Inconsistency
- **Problem**: Polymarket APIs sometimes return milliseconds, sometimes seconds
- **Solution**: Always normalize timestamps to epoch seconds before generating `trade_dedupe_id` and before storing `fill_timestamp` (convert ms -> s when needed)
- **Future phases**: Check if timestamp > 1e12, divide by 1000

## Schema Contracts

### alert_events Table
- `id`: UUID generated in code (not DB default)
- `trade_dedupe_id`: Deterministic, format-frozen (see `/lib/dedupe.ts`)
- `fill_value_usd`: Computed with decimal.js-light; insert as string to Postgres NUMERIC (no JS float math)
- `position_*`: Position data captured at ingestion, NEVER re-fetched

### Join Keys
- Primary: `wallet.toLowerCase() + asset`
- Validation: Must verify `conditionId` and `outcomeIndex` match after join
- Wallets must be normalized to lowercase before insert into `alert_events.wallet`

### Alert Eligibility Threshold
- Use `initialValue` if present, else `currentValue`
- Must be >= $2,500 to qualify for alert insertion

## API Behavior Notes

### /positions Endpoint
- Returns max 500 positions per wallet
- Heavy traders may have truncated data
- Phase 1 logs truncation warnings but continues
- Future phases should implement pagination if needed

### /trades Endpoint
- No reliable sorting guarantees
- De-duplication by `trade_dedupe_id` is essential
- `transactionHash` may be null in edge cases

## Deferred for Future Phases

1. **Convergence Detection**: Multiple whales on same market
2. **Outcome Confirmation UI**: Confirmed vs inferred resolution display
3. **Position Tracking**: Multi-day accumulation across sessions
4. **Enhanced Rate Limiting**: Phase 1 uses p-limit(5) + exponential backoff (1s/2s/4s); future phases may improve it

## Environment Variables Required

```env
POSTGRES_URL=...              # Required: Database connection
CRON_SECRET=...               # Required: Auth header for POST /api/collect-trades
ENABLE_ADMIN_MIGRATIONS=true  # Required for /api/admin/migrate
ADMIN_SECRET=...              # Required: Header auth for admin routes
```

## Known Issues Fixed

### SQL INTERVAL Parameterization
- **Problem**: Using `NOW() - INTERVAL '1 hour' * ${hours}` failed for 24-hour queries
- **Solution**: Calculate cutoff timestamp in JavaScript, pass as ISO string:
  ```typescript
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  WHERE fill_timestamp >= ${cutoffTime}::timestamptz
  ```
- **Location**: `/app/api/daily-report/route.ts`

### Position Size Formatting
- **Problem**: Position size (shares) was formatted with `$` prefix like money
- **Solution**: Added `formatShares()` function that returns just the number (e.g., "13.0K" not "$13.0K")
- **Location**: All API routes that return `positionSizeFormatted`

## Testing Checklist

- [x] Empty string handling in all Zod schemas (implemented)
- [x] Decimal precision in fill_value_usd calculations (using decimal.js-light)
- [x] trade_dedupe_id uniqueness under concurrent writes (verified)
- [x] Timestamp normalization (ms vs seconds) (implemented)
- [x] Position truncation logging (implemented)
- [x] Admin route security (POST-only, secret header) (tested 401/200)
- [x] Data accuracy verified against Polymarket profiles (CryptoVadikOne-tg, Hauchn, KnureKnume)
- [x] 24-hour time filter working correctly
- [x] Cron ingestion running every 5 minutes via GitHub Actions
