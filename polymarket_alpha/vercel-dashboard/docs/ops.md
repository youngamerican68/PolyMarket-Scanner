# Operations Guide

This document covers monitoring, alerting, and operational procedures.

## Heartbeat Monitoring

Minimal heartbeat monitoring to catch silent job failures. This supports future newsletter/digest reliability.

### How It Works

1. **Heartbeat Endpoint** (`GET /api/ops/health/heartbeat`)
   - Returns health status for all monitored jobs
   - Checks if each job has run successfully within expected timeframe
   - Protected by `OPS_SECRET` Bearer token

2. **GitHub Action** (`.github/workflows/ops-heartbeat.yml`)
   - Runs every 10 minutes
   - Calls heartbeat endpoint and checks `ok` status
   - Fails if any job is stale, triggering GitHub email notifications

3. **Stale Detection**
   - A job is "stale" if:
     - No successful run recorded, OR
     - Last success was more than 2x the expected schedule interval ago
   - Example: `refresh-baselines` runs every 6h, so stale after 12h without success

### Monitored Jobs

| Job Name | Schedule | Stale After |
|----------|----------|-------------|
| `refresh-baselines` | Every 6 hours | 12 hours |
| `generate-digest` | Daily (when implemented) | 48 hours |

### Response Format

```json
{
  "ok": true,
  "generatedAt": "2024-01-15T12:00:00.000Z",
  "checks": [
    {
      "jobName": "refresh-baselines",
      "scheduleMinutes": 360,
      "lastSuccessAt": "2024-01-15T10:00:00.000Z",
      "lastErrorAt": null,
      "stale": false,
      "message": "OK: last success 2h ago"
    }
  ]
}
```

### Setup

#### 1. Vercel Environment Variables (Production)

| Variable | Required | Description |
|----------|----------|-------------|
| `OPS_SECRET` | **Yes** | Bearer token for heartbeat auth. Generate with: `openssl rand -base64 32` |
| `CRON_SECRET` | **Yes** | Bearer token for cron job auth |
| `ENABLE_ADMIN_MIGRATIONS` | **No** | Set to `"true"` **only** when intentionally running migrations. Should be **unset** or `"false"` in Production by default. |

**Important:** `ENABLE_ADMIN_MIGRATIONS` must be exactly `"true"` (strict equality check). Any other value, including being unset, disables migrations.

#### 2. GitHub Repository Secrets

Add these secrets in your GitHub repo (Settings > Secrets and variables > Actions):

| Secret | Description |
|--------|-------------|
| `DOMAIN` | Production domain (e.g., `your-app.vercel.app`) |
| `OPS_SECRET` | Same value as Vercel `OPS_SECRET` |

#### 3. Enable GitHub Email Notifications

Ensure your GitHub notification settings include "Actions" workflow failures:
1. Go to GitHub Settings > Notifications
2. Under "Actions", enable "Send notifications for failed workflows only"

### Testing

```bash
# Run unit tests
npx tsx tests/heartbeat.test.ts

# Manually trigger GitHub Action
# Go to Actions tab > "Ops Heartbeat" > "Run workflow"
```

### Verification

Copy/paste commands to verify the heartbeat endpoint:

```bash
# Set your domain and secret (replace with actual values)
export DOMAIN="your-app.vercel.app"
export OPS_SECRET="your-secret-here"

# 1. Verify 401 without token
curl -s -w "\nHTTP %{http_code}\n" \
  "https://$DOMAIN/api/ops/health/heartbeat"
# Expected: {"error":"Unauthorized"} HTTP 401

# 2. Verify 401 with wrong token
curl -s -w "\nHTTP %{http_code}\n" \
  -H "Authorization: Bearer wrong-token" \
  "https://$DOMAIN/api/ops/health/heartbeat"
# Expected: {"error":"Unauthorized"} HTTP 401

# 3. Verify 200 with correct token
curl -s -w "\nHTTP %{http_code}\n" \
  -H "Authorization: Bearer $OPS_SECRET" \
  "https://$DOMAIN/api/ops/health/heartbeat"
# Expected: {"ok":true,"generatedAt":"...","checks":[...]} HTTP 200

# 4. Check cache headers (should include no-store)
curl -s -I -H "Authorization: Bearer $OPS_SECRET" \
  "https://$DOMAIN/api/ops/health/heartbeat" | grep -i cache
# Expected: Cache-Control: no-store, no-cache, must-revalidate
```

**Example ok=false response** (when a job is stale):
```json
{
  "ok": false,
  "generatedAt": "2024-01-15T12:00:00.000Z",
  "checks": [
    {
      "jobName": "refresh-baselines",
      "scheduleMinutes": 360,
      "lastSuccessAt": null,
      "lastErrorAt": null,
      "stale": true,
      "message": "STALE: no successful run recorded"
    }
  ]
}
```

### Troubleshooting

**Heartbeat returns 401:**
- Verify `OPS_SECRET` is set in Vercel
- Check Authorization header format: `Bearer <token>`

**Job shows as stale:**
- Check Vercel cron logs for the job
- Verify job is configured in `vercel.json`
- Check `job_runs` table for errors:
  ```sql
  SELECT * FROM job_runs
  WHERE job_name = 'refresh-baselines'
  ORDER BY started_at DESC LIMIT 10;
  ```

**GitHub Action failing:**
- Verify `DOMAIN` and `OPS_SECRET` secrets are set
- Check if endpoint is accessible from GitHub's IP ranges

### Adding New Jobs

To monitor a new job:

1. Add to `lib/heartbeat.ts` `MONITORED_JOBS` array:
   ```typescript
   { jobName: 'new-job-name', scheduleMinutes: 60 }
   ```

2. Ensure the job writes to `job_runs` table on completion

### Future Enhancements

- Slack/webhook notifications (not implemented yet)
- Per-job alert thresholds
- Historical health dashboards

---

## Scheduled Job Triggers (GitHub Actions)

All recurring jobs are triggered via GitHub Actions workflows, not Vercel crons.

### Architecture

- **Scheduler**: GitHub Actions (`.github/workflows/*.yml`)
- **Endpoints**: Vercel-hosted Next.js API routes
- **Method**: GET (all job endpoints accept GET requests)
- **Auth**: Bearer token via `Authorization: Bearer $CRON_SECRET` header

### Required GitHub Secrets

Set these in GitHub → Settings → Secrets and variables → Actions:

| Secret | Description |
|--------|-------------|
| `CRON_SECRET` | Bearer token for job endpoint auth (same as Vercel env var) |
| `COLLECT_TRADES_URL` | `https://poly-market-scanner.vercel.app/api/collect-trades` |
| `REFRESH_PRICES_URL` | `https://poly-market-scanner.vercel.app/api/jobs/refresh-prices` |
| `REFRESH_BASELINES_URL` | `https://poly-market-scanner.vercel.app/api/jobs/refresh-baselines` |
| `SYNC_POSITIONS_URL` | `https://poly-market-scanner.vercel.app/api/jobs/sync-positions` |

**Note**: `collect-trades` is at `/api/collect-trades`, other jobs are under `/api/jobs/`.

**Important**: Use the stable primary domain (`poly-market-scanner.vercel.app`), not deployment-specific URLs.

### Workflows

| Workflow | Schedule | Endpoint |
|----------|----------|----------|
| `collect-trades.yml` | Every 5 min | `/api/collect-trades` |
| `refresh-prices.yml` | Every 10 min | `/api/jobs/refresh-prices` |
| `sync-positions.yml` | Every 15 min | `/api/jobs/sync-positions` |
| `refresh-baselines.yml` | Daily 2 AM UTC | `/api/jobs/refresh-baselines` |

### Expected HTTP Status Codes

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 204 | Success (no content) |
| 401 | Missing or invalid `CRON_SECRET` |
| 409 | Job already running (advisory lock prevents overlap) |
| 405 | Wrong HTTP method (should be GET) |
| 500 | Server error - check Vercel function logs |

### Troubleshooting

**405 Method Not Allowed:**
- Ensure workflows use GET (no `-X POST`)

**401 Unauthorized:**
- Verify `CRON_SECRET` matches between GitHub secrets and Vercel env vars

**Workflow not running on schedule:**
- Scheduled workflows only run from the **default branch**
- Verify fixes are merged to the default branch

**Empty URL error:**
- Add the missing URL secret in GitHub → Settings → Secrets and variables → Actions
