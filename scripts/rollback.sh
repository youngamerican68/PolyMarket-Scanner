#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-}"
RESET_DB=""
[[ "${2:-}" == "--reset-db" ]] && RESET_DB=1

[[ -z "$TAG" ]] && { echo "Usage: $0 <TAG> [--reset-db]"; exit 1; }

git fetch --tags 2>/dev/null || true

# Stash if dirty
if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  git stash push -u -m "pre-rollback $TAG $(date -u +%Y%m%dT%H%M%SZ)"
  echo "Stashed uncommitted changes"
fi

git checkout --detach "$TAG"
echo "Checked out $TAG"

# Restore env
CKPT_ENV=".checkpoints/$TAG/.env.local"
if [[ -f "$CKPT_ENV" ]]; then
  if [[ -f ./.env.local ]] || [[ ! -d polymarket_alpha/vercel-dashboard ]]; then
    cp "$CKPT_ENV" ./.env.local
    chmod 600 ./.env.local
    echo "Restored ./.env.local"
  else
    cp "$CKPT_ENV" polymarket_alpha/vercel-dashboard/.env.local
    chmod 600 polymarket_alpha/vercel-dashboard/.env.local
    echo "Restored polymarket_alpha/vercel-dashboard/.env.local"
  fi
fi

# Docker compose restart
HAS_COMPOSE=""
if command -v docker &>/dev/null && docker compose version &>/dev/null; then
  if [[ -f docker-compose.yml ]] || [[ -f compose.yml ]]; then
    HAS_COMPOSE=1
  fi
fi

if [[ -n "$HAS_COMPOSE" ]]; then
  [[ -n "$RESET_DB" ]] && docker compose down -v || docker compose down
  docker compose up -d --build
  echo "Services restarted"
else
  echo "docker compose not configured; restart the app with your usual command"
fi

# Healthcheck
if ./scripts/healthcheck.sh; then
  echo "Healthcheck passed"
else
  echo "WARNING: Healthcheck failed (rollback still complete)"
fi
