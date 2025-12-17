-- 001_alert_events.sql
-- Phase 1 Migration: Create alert_events table for high-accuracy data storage
-- No pgcrypto needed — UUIDs generated in application code

CREATE TABLE IF NOT EXISTS alert_events (
  -- Primary key (generated in code via crypto.randomUUID())
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Trade identity / dedupe
  trade_dedupe_id TEXT NOT NULL UNIQUE,
  transaction_hash TEXT NULL,
  fill_timestamp TIMESTAMPTZ NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  fill_price NUMERIC NOT NULL,
  fill_size NUMERIC NOT NULL,
  fill_value_usd NUMERIC NOT NULL,

  -- Actor
  wallet TEXT NOT NULL CONSTRAINT alert_events_wallet_lower CHECK (wallet = LOWER(wallet)),
  trader_name TEXT NULL,
  trader_pseudonym TEXT NULL,

  -- Market identifiers
  asset TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  outcome_index INT NOT NULL,
  title TEXT NULL,
  slug TEXT NULL,
  event_slug TEXT NULL,

  -- Position snapshot (from /positions at ingestion time)
  position_size NUMERIC NULL,
  position_avg_price NUMERIC NULL,
  position_cur_price NUMERIC NULL,
  position_initial_value NUMERIC NULL,
  position_current_value NUMERIC NULL,
  position_cash_pnl NUMERIC NULL,
  position_snapshot_at TIMESTAMPTZ NULL,

  -- Qualification flags/params
  longshot_threshold NUMERIC NOT NULL DEFAULT 0.25,
  min_position_threshold NUMERIC NOT NULL DEFAULT 2500,
  qualifies_longshot BOOLEAN NOT NULL,
  qualifies_min_position BOOLEAN NOT NULL,

  -- Audit: which value was used for threshold check
  threshold_value_used NUMERIC NULL,
  threshold_source TEXT NULL,

  -- Whale metadata (from whale_watchlist join)
  is_whale BOOLEAN NOT NULL DEFAULT FALSE,
  whale_label TEXT NULL,
  whale_tier TEXT NULL,
  whale_category TEXT NULL
);

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS idx_alert_events_fill_timestamp
  ON alert_events (fill_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_alert_events_wallet_timestamp
  ON alert_events (wallet, fill_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_alert_events_event_slug
  ON alert_events (event_slug);

CREATE INDEX IF NOT EXISTS idx_alert_events_condition_outcome
  ON alert_events (condition_id, outcome_index);

CREATE INDEX IF NOT EXISTS idx_alert_events_asset
  ON alert_events (asset);

CREATE INDEX IF NOT EXISTS idx_alert_events_is_whale
  ON alert_events (is_whale) WHERE is_whale = TRUE;

CREATE INDEX IF NOT EXISTS idx_alert_events_qualifies_longshot
  ON alert_events (qualifies_longshot) WHERE qualifies_longshot = TRUE;

-- Whale Watchlist Index Update
-- Ensure wallet is indexed and unique (lowercase normalized)
CREATE UNIQUE INDEX IF NOT EXISTS idx_whale_watchlist_wallet_lower
  ON whale_watchlist (LOWER(wallet));
