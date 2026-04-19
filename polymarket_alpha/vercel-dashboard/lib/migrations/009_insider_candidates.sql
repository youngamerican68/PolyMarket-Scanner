-- 009_insider_candidates.sql
-- Narrow insider-pattern detection: fresh wallets placing small deep-longshot bets.
-- A candidate is an alert_events row that matched the pre-filter (small bet + deep longshot
-- + minimal DB history) and has been verified against the Polymarket /trades API.

CREATE TABLE IF NOT EXISTS insider_candidates (
  alert_event_id UUID PRIMARY KEY REFERENCES alert_events(id) ON DELETE CASCADE,

  -- Trade snapshot (denormalized for page query speed; source of truth is alert_events)
  wallet TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  fill_price NUMERIC NOT NULL,
  fill_value_usd NUMERIC NOT NULL,
  fill_timestamp TIMESTAMPTZ NOT NULL,
  title TEXT NULL,
  event_slug TEXT NULL,
  slug TEXT NULL,

  -- Verification result
  verification_status TEXT NOT NULL
    CHECK (verification_status IN ('pending','confirmed','rejected_established','rejected_lookup_failed')),
  polymarket_lifetime_trades INT NULL,
  polymarket_first_trade_at TIMESTAMPTZ NULL,
  verified_at TIMESTAMPTZ NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insider_candidates_status_time
  ON insider_candidates(verification_status, fill_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_insider_candidates_wallet
  ON insider_candidates(wallet);

COMMENT ON TABLE insider_candidates IS
  'Narrow insider-pattern alerts: new wallet + deep longshot (<10%) + small position ($100-$500), verified via Polymarket trades API.';
