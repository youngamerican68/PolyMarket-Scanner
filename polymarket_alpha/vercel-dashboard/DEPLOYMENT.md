# Phase 1 Deployment Guide

## Overview

This guide deploys the Phase 1 accuracy-first rebuild with `alert_events` table. The deployment follows a Preview smoke test followed by Production rollout.

**What's being deployed:**
- `alert_events` table schema and migration endpoint
- Secured ingestion endpoint (`POST /api/collect-trades` with `x-cron-secret`)
- Dashboard APIs querying `alert_events` only (no external API calls at page load)
- GitHub Actions cron workflow (every 5 minutes)

---

## Phase A: Preview Smoke Test

### Step 1: Get your Preview URL

1. Go to Vercel dashboard
2. Navigate to your project → Deployments
3. Find the Preview deployment for branch `claude/polymarket-wallet-tracker-01Y7cw8eXboZod66THDMFyou`
4. Copy the full URL: `https://poly-market-scanner-abc123.vercel.app`

---

### Step 2: Set Preview environment variables

1. Vercel dashboard → Settings → Environment Variables
2. Add these variables (select **Preview** scope only):

| Variable | Value |
|----------|-------|
| `CRON_SECRET` | Generate: `openssl rand -hex 32` |
| `ADMIN_SECRET` | Generate: `openssl rand -hex 32` |
| `ENABLE_ADMIN_MIGRATIONS` | `true` |

3. Click Save
4. **Redeploy** the Preview branch: Deployments → ⋯ → Redeploy

---

### Step 3: Run migration

```bash
curl -i -f -X POST "https://YOUR-PREVIEW-URL/api/admin/migrate" \
  -H "x-admin-secret: YOUR_ADMIN_SECRET"
```

**Expected:** `200 OK` with `{"success":true,"message":"Migration complete"}`

---

### Step 4: Disable migrations

1. Vercel dashboard → Environment Variables
2. Change `ENABLE_ADMIN_MIGRATIONS` to `false` (Preview scope)
3. **Redeploy** the Preview branch for this change to take effect

---

### Step 5: Test auth protection

```bash
# Should return 401 Unauthorized
curl -i -X POST "https://YOUR-PREVIEW-URL/api/collect-trades"

# Should return 200 OK with summary JSON
curl -i -X POST "https://YOUR-PREVIEW-URL/api/collect-trades" \
  -H "x-cron-secret: YOUR_CRON_SECRET"
```

Check the response body for counts: `trades_fetched`, `candidates_after_filter`, `alerts_inserted`.

---

### Step 6: Check database

1. Vercel dashboard → Storage → Postgres → Data
2. Run query:

```sql
SELECT COUNT(*), MAX(fill_timestamp) FROM alert_events;
```

**Interpretation:**
- `COUNT(*) > 0` → Ingestion working, at least one $2.5K+ longshot detected
- `COUNT(*) = 0` → Either no qualifying events yet OR ingestion issue
- `MAX(fill_timestamp)` will be `NULL` until the first row exists (expected)

If zero rows, check Vercel logs (Deployments → Logs) for `/api/collect-trades` to confirm it ran successfully with no errors.

---

### Step 7: Test dashboards

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://YOUR-PREVIEW-URL/api/daily-report"
curl -s -o /dev/null -w "%{http_code}\n" "https://YOUR-PREVIEW-URL/api/whale-trades"
curl -s -o /dev/null -w "%{http_code}\n" "https://YOUR-PREVIEW-URL/api/longshot-history"
```

All should return `200`.

---

## Phase B: Production Rollout

### Step 8: Set Production environment variables

1. Vercel dashboard → Settings → Environment Variables
2. Add these variables (select **Production** scope):

| Variable | Value |
|----------|-------|
| `CRON_SECRET` | Generate new: `openssl rand -hex 32` |
| `ADMIN_SECRET` | Generate new: `openssl rand -hex 32` |
| `ENABLE_ADMIN_MIGRATIONS` | `true` |

**Note:** Use different secrets than Preview for isolation.

---

### Step 9: Merge to main

```bash
git checkout main
git pull
git merge claude/polymarket-wallet-tracker-01Y7cw8eXboZod66THDMFyou
git push
```

---

### Step 9.5: Verify Production deployment is live

1. Vercel dashboard → Deployments
2. Confirm `main` deployment status is **Ready**
3. Run health check:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://YOUR-PRODUCTION-URL/api/daily-report"
```

**Expected:** `200` (even if alerts array is empty)

---

### Step 10: Run migration on Production

```bash
curl -i -f -X POST "https://YOUR-PRODUCTION-URL/api/admin/migrate" \
  -H "x-admin-secret: YOUR_ADMIN_SECRET"
```

**Expected:** `200 OK` with `{"success":true,"message":"Migration complete"}`

---

### Step 11: Disable migrations

1. Vercel dashboard → Environment Variables
2. Change `ENABLE_ADMIN_MIGRATIONS` to `false` (Production scope)
3. **Redeploy** Production for this change to take effect

---

### Step 12: Set GitHub Secrets

1. GitHub repo → Settings → Secrets and variables → Actions
2. Click "New repository secret" and add:

| Secret | Value |
|--------|-------|
| `COLLECT_TRADES_URL` | `https://YOUR-PRODUCTION-URL/api/collect-trades` |
| `CRON_SECRET` | Same as Vercel Production `CRON_SECRET` |

---

### Step 12.5: Test Production auth protection

```bash
# Should return 401 Unauthorized
curl -i -X POST "https://YOUR-PRODUCTION-URL/api/collect-trades"

# Should return 200 OK with summary JSON
curl -i -X POST "https://YOUR-PRODUCTION-URL/api/collect-trades" \
  -H "x-cron-secret: YOUR_PROD_CRON_SECRET"
```

---

### Step 13: Test GitHub Actions

1. GitHub repo → Actions
2. Find "Collect Trades" workflow
3. Click "Run workflow" button

**Verify:**
- GitHub Actions run completes green
- Vercel logs show `/api/collect-trades` activity
- DB row count increases (if qualifying trades exist)

---

## Done

Cron runs every 5 minutes automatically via GitHub Actions.

---

## Troubleshooting

### Migration returns 403
- Check `ENABLE_ADMIN_MIGRATIONS` is set to `true` (not `"true"` with quotes)
- Redeploy after setting the env var

### Migration returns 401
- Check `x-admin-secret` header matches `ADMIN_SECRET` env var exactly

### Ingestion returns 401
- Check `x-cron-secret` header matches `CRON_SECRET` env var exactly

### GitHub Actions failing
- Verify `COLLECT_TRADES_URL` points to Production URL
- Verify `CRON_SECRET` matches Vercel Production env var

### No rows in alert_events after ingestion
- Check Vercel logs for errors
- Verify the ingestion response shows `trades_fetched > 0`
- No rows is expected if no $2.5K+ longshot trades occurred

### Env var changes not taking effect
- Redeploy after any env var change
- Verify you're setting the correct scope (Preview vs Production)
