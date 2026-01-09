-- 008_pending_longshot_wallets.sql
-- Track wallets that made longshot trades but were skipped due to position below threshold
-- These wallets are periodically re-scanned to capture positions once they grow

CREATE TABLE IF NOT EXISTS pending_longshot_wallets (
  -- Primary key
  wallet TEXT PRIMARY KEY CONSTRAINT pending_longshot_wallets_lower CHECK (wallet = LOWER(wallet)),

  -- When first seen making a longshot trade
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Most recent longshot trade details
  last_trade_at TIMESTAMPTZ NOT NULL,
  last_condition_id TEXT NOT NULL,
  last_trade_price NUMERIC NOT NULL,
  last_trade_size NUMERIC NOT NULL,
  last_position_value NUMERIC NULL,

  -- Tracking
  times_skipped INT NOT NULL DEFAULT 1,
  last_scanned_at TIMESTAMPTZ NULL,

  -- Cleanup: remove after position captured or market resolved
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'captured', 'expired'))
);

-- Index for re-scan job to find pending wallets
CREATE INDEX IF NOT EXISTS idx_pending_longshot_wallets_status
ON pending_longshot_wallets(status) WHERE status = 'pending';

-- Index for cleanup of old entries
CREATE INDEX IF NOT EXISTS idx_pending_longshot_wallets_first_seen
ON pending_longshot_wallets(first_seen_at);

COMMENT ON TABLE pending_longshot_wallets IS 'Wallets that made longshot trades (<=25%) but were skipped due to position value <$2500. Re-scanned periodically to capture once threshold met.';
