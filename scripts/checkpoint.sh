#!/usr/bin/env bash
set -euo pipefail

# Resolve env file
if [[ -f ./.env.local ]]; then
  ENV_FILE="./.env.local"
elif [[ -f polymarket_alpha/vercel-dashboard/.env.local ]]; then
  ENV_FILE="polymarket_alpha/vercel-dashboard/.env.local"
else
  ENV_FILE=""
fi

# SHA256 command (graceful fallback)
sha256cmd() {
  if command -v shasum &>/dev/null; then
    shasum -a 256 "$1"
  elif command -v sha256sum &>/dev/null; then
    sha256sum "$1"
  else
    return 1
  fi
}

# Verify git repo
git rev-parse --git-dir >/dev/null 2>&1 || { echo "Not a git repo"; exit 1; }

# Generate tag
TAG="checkpoint-$(date -u +%Y%m%d-%H%M%SZ)"
DIR=".checkpoints/$TAG"
mkdir -p "$DIR"

# Copy env if exists
if [[ -n "$ENV_FILE" ]]; then
  cp "$ENV_FILE" "$DIR/.env.local"
  chmod 600 "$DIR/.env.local"
  if sha256cmd "$ENV_FILE" > "$DIR/env.local.sha256.tmp"; then
    awk '{print $1}' < "$DIR/env.local.sha256.tmp" > "$DIR/env.local.sha256"
    rm -f "$DIR/env.local.sha256.tmp"
  else
    echo "checksum: unavailable (no shasum/sha256sum)" > "$DIR/env.local.sha256"
  fi
fi

# Docker compose config (if available)
if command -v docker &>/dev/null && docker compose version &>/dev/null; then
  if [[ -f docker-compose.yml ]] || [[ -f compose.yml ]]; then
    docker compose config > "$DIR/compose.rendered.yml" 2>/dev/null || true
  fi
fi

# Write metadata
cat > "$DIR/meta.txt" <<EOF
tag: $TAG
sha: $(git rev-parse HEAD)
branch: $(git symbolic-ref --short HEAD 2>/dev/null || echo "detached")
timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

# Create annotated git tag
git tag -a "$TAG" -m "Checkpoint $TAG"

echo "Created checkpoint: $TAG"
echo "Rollback command:   ./scripts/rollback.sh $TAG"
