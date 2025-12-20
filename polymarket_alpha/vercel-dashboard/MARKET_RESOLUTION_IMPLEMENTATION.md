# Market Resolution Detection - Implementation Plan

## Goal
Prevent resolved/settled markets from throwing off dashboard numbers by tracking market resolution status per `condition_id`.

## Key Decisions (from user)
- **Separate table** (`market_status`) instead of adding columns to `alert_events`
- **Hide resolved by default**, with UI toggle to include them
- **Badge + grayed styling** for resolved markets when shown
- **Show winning outcome** (e.g., "Winner: Pelicans")
- **Use `first_seen_*` timestamps** - NOT true resolution time (we don't have that)

---

## Implementation Steps

### 1. Schema: Create `market_status` Table

**File:** `app/api/admin/migrate/route.ts` (add migration)

```sql
CREATE TABLE IF NOT EXISTS market_status (
  condition_id TEXT PRIMARY KEY,
  market_closed BOOLEAN NOT NULL DEFAULT FALSE,
  market_closed_first_seen_at TIMESTAMPTZ,
  market_resolved BOOLEAN NOT NULL DEFAULT FALSE,
  market_resolved_first_seen_at TIMESTAMPTZ,
  winning_outcome TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_market_status_resolved
ON market_status (market_resolved, updated_at DESC);
```

### 2. Enrichment Job: Extend `refresh-prices`

**File:** `app/api/jobs/refresh-prices/route.ts`

**Reuse existing CLOB client:** Use the same fetch pattern from `app/api/check-resolutions/route.ts` (already has the endpoint shape).

**Verify response shape matches check-resolutions:** The interface in check-resolutions shows:
```ts
interface MarketData {
  condition_id: string;
  closed: boolean;
  tokens: { token_id: string; outcome: string; winner: boolean; price?: number; }[];
}
```
Use `tokens.find(t => t.winner)?.outcome` for the human-readable winning outcome label.

Add to existing job:
1. Get distinct `condition_id` from `alert_events` (last 7-14 days)
   - **Bound the query:** `WHERE fill_timestamp > NOW() - INTERVAL '14 days'`
   - **Exclude nulls:** `AND condition_id IS NOT NULL AND condition_id != ''`
2. For each, call CLOB API (reuse existing pattern from check-resolutions)
3. Parse response:
   - `winnerFound = tokens.some(t => t.winner === true)`
   - `market_resolved = winnerFound`
   - `market_closed = closed || market_resolved` (resolved implies closed)
   - `winning_outcome = tokens.find(t => t.winner)?.outcome`
4. UPSERT into `market_status` (with proper first-seen preservation):
```sql
INSERT INTO market_status (
  condition_id, market_closed, market_resolved, winning_outcome,
  market_closed_first_seen_at, market_resolved_first_seen_at, updated_at
)
VALUES (
  $1, $2, $3, $4,
  CASE WHEN $2 = TRUE THEN NOW() ELSE NULL END,  -- set closed_first_seen on INSERT if closed
  CASE WHEN $3 = TRUE THEN NOW() ELSE NULL END,  -- set resolved_first_seen on INSERT if resolved
  NOW()
)
ON CONFLICT (condition_id) DO UPDATE SET
  market_closed = EXCLUDED.market_closed,
  market_closed_first_seen_at = CASE
    WHEN market_status.market_closed = FALSE AND EXCLUDED.market_closed = TRUE
    THEN NOW()
    ELSE market_status.market_closed_first_seen_at
  END,
  market_resolved = EXCLUDED.market_resolved,
  market_resolved_first_seen_at = CASE
    WHEN market_status.market_resolved = FALSE AND EXCLUDED.market_resolved = TRUE
    THEN NOW()
    ELSE market_status.market_resolved_first_seen_at
  END,
  winning_outcome = COALESCE(EXCLUDED.winning_outcome, market_status.winning_outcome),
  updated_at = NOW();
```
   - **INSERT:** Sets `first_seen_at` to NOW() if status is true on first insert
   - **UPDATE:** Only sets `first_seen_at` on false→true transition (never overwrites)
5. Log count of updated condition_ids (no secrets)

**Resilience:**
- Concurrency limit: 5-10 parallel requests max
- Basic retry with backoff on failure
- Skip/continue on 404s or timeouts (don't fail entire job)
- Log warnings for skipped markets

### 3. Backend: Update Report API

**File:** `app/api/report/route.ts`

**Query change:**
```sql
SELECT ae.*,
       ms.market_resolved,
       ms.market_closed,
       ms.winning_outcome
FROM alert_events ae
LEFT JOIN market_status ms ON ae.condition_id = ms.condition_id
WHERE ...existing filters...
  AND COALESCE(ms.market_resolved, FALSE) = FALSE  -- default: hide resolved
```

**Add parameter:**
- `includeResolved=true` → **fully removes** the `COALESCE(ms.market_resolved, FALSE) = FALSE` clause from WHERE
- Implementation: Build query conditionally, don't AND both cases:
```ts
const whereClause = includeResolved
  ? `WHERE ...existing filters only...`
  : `WHERE ...existing filters... AND COALESCE(ms.market_resolved, FALSE) = FALSE`;
```

**Response mapping (snake_case → camelCase):**
Follow existing pattern in `formattedAlerts` mapping:
```ts
marketResolved: row.market_resolved ?? false,
marketClosed: row.market_closed ?? false,
winningOutcome: row.winning_outcome ?? null,
```

**Ensure one row per alert event:** The LEFT JOIN on `condition_id` is safe since `market_status` is keyed by `condition_id` (1:1 per market, many alerts can reference same market).
- **Don't multiply rows:** `market_status.condition_id` is PRIMARY KEY, so JOIN is 1:1. Never join to `tokens` or other multi-row tables in this query.

### 4. Frontend: UI Toggle + Styling

**File:** `app/report/page.tsx`

**Add to filters section:**
```tsx
<label className="text-poly-muted text-sm">
  <input
    type="checkbox"
    checked={includeResolved}
    onChange={(e) => setIncludeResolved(e.target.checked)}
    className="mr-2"
  />
  Show Resolved
</label>
```

**Pass to API:**
```ts
if (includeResolved) params.set('includeResolved', 'true')
```

**Row styling for resolved markets:**
```tsx
<tr className={alert.marketResolved ? 'opacity-50' : ''}>
  {alert.marketResolved && (
    <span className="bg-gray-600 text-xs px-2 py-0.5 rounded">RESOLVED</span>
  )}
  {alert.winningOutcome && (
    <span className="text-xs text-poly-muted">Market winner: {alert.winningOutcome}</span>
  )}
</tr>
```
**Note:** Use "Market winner" (not "Winner") to avoid confusion when user bet on opposite outcome.

### 5. Update PROGRESS.md

Add note explaining:
- `first_seen_*` timestamps = when OUR system detected resolution
- NOT the actual on-chain resolution time
- Markets without `market_status` row treated as active (not hidden)

---

## Files to Modify

| File | Change |
|------|--------|
| `app/api/admin/migrate/route.ts` | Add migration for `market_status` table |
| `app/api/jobs/refresh-prices/route.ts` | Add CLOB API call for market status |
| `app/api/report/route.ts` | LEFT JOIN + filter + param + response fields |
| `app/report/page.tsx` | Toggle checkbox + row styling + badge |
| `PROGRESS.md` | Document the feature |

---

## Definition of Done

- [ ] Resolved markets are hidden by default in the report results
- [ ] `includeResolved=true` shows them
- [ ] Resolved rows show a RESOLVED badge + dim styling + "Market winner: ..."
- [ ] `market_*_first_seen_at` is set on initial insert if already true, and never overwritten after
- [ ] Job doesn't fail on a few bad markets (timeouts/404), and doesn't hammer the API

---

## Verification

Test with known resolved markets:
- Rockets vs. Pelicans (Pelicans won)
- Hawks vs. Hornets (Hornets won)

Check:
1. Hidden by default in dashboard
2. Appear when "Show Resolved" is checked
3. Display "RESOLVED" badge + grayed styling
4. Show "Market winner: Pelicans" / "Market winner: Hornets"
