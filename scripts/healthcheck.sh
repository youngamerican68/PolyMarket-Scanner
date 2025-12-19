#!/usr/bin/env bash
set -euo pipefail

# Resolve env file
if [[ -f ./.env.local ]]; then
  ENV_PATH="./.env.local"
elif [[ -f polymarket_alpha/vercel-dashboard/.env.local ]]; then
  ENV_PATH="polymarket_alpha/vercel-dashboard/.env.local"
else
  echo "healthcheck: no env file found; skipping"
  exit 0
fi

set -a; . "$ENV_PATH" 2>/dev/null; set +a
DB_URL="${DATABASE_URL:-${POSTGRES_URL:-}}"

if [[ -z "$DB_URL" ]]; then
  echo "healthcheck: DB_URL not set; skipping"
  exit 0
fi

SQL="SELECT
  now() AS now,
  max(created_at) AS newest_created_at,
  now() - max(created_at) AS created_at_lag,
  max(fill_timestamp) AS newest_fill_timestamp,
  now() - max(fill_timestamp) AS fill_timestamp_lag,
  (SELECT max(created_at - fill_timestamp) FROM alert_events WHERE created_at >= now() - interval '6 hours') AS max_ingestion_delay_6h
FROM alert_events;"

if ! psql "$DB_URL" -v ON_ERROR_STOP=1 -X -q -c "$SQL"; then
  echo "healthcheck skipped (schema mismatch)"
  exit 0
fi
