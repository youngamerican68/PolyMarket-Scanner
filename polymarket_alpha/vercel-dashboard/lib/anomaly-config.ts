// /lib/anomaly-config.ts
// Phase 5 Hardening: Centralized configuration for conviction sizing anomaly detection
// All thresholds are configurable via environment variables with sensible defaults

// Environment variable parsing helpers
function parseEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

// =========================================================================
// Baseline computation thresholds
// =========================================================================

/** Number of days to look back for trade history (default: 90) */
export const BASELINE_LOOKBACK_DAYS = parseEnvInt('BASELINE_LOOKBACK_DAYS', 90);

/** Minimum number of trades required to compute a baseline (default: 30) */
export const MIN_TRADES = parseEnvInt('ANOMALY_MIN_TRADES', 30);

/** Only recompute baselines for wallets active in last N days (default: 7) */
export const ACTIVE_DAYS = parseEnvInt('BASELINE_ACTIVE_DAYS', 7);

// =========================================================================
// Anomaly detection thresholds
// =========================================================================

/** Minimum trade notional in USD to consider for anomaly detection (default: 500) */
export const MIN_ABS_NOTIONAL_USD = parseEnvNumber('ANOMALY_MIN_NOTIONAL_USD', 500);

/** Minimum ratio to median required to flag as anomaly (default: 2.5) */
export const RATIO_THRESHOLD = parseEnvNumber('ANOMALY_RATIO_THRESHOLD', 2.5);

/** Robust Z-score threshold (optional, only applied if MAD > 0) (default: 2.5) */
export const ROBUST_Z_THRESHOLD = parseEnvNumber('ANOMALY_ROBUST_Z_THRESHOLD', 2.5);

/**
 * Minimum median in USD below which we skip ratio-based anomalies
 * Wallets with median < this require additional absolute notional threshold
 * (default: 50)
 */
export const MIN_MEDIAN_USD = parseEnvNumber('ANOMALY_MIN_MEDIAN_USD', 50);

/**
 * Floor for denominator when computing ratio to avoid division by tiny numbers
 * effectiveMedian = max(median, DENOMINATOR_FLOOR_USD)
 * (default: 50)
 */
export const DENOMINATOR_FLOOR_USD = parseEnvNumber('ANOMALY_DENOMINATOR_FLOOR_USD', 50);

/**
 * Additional absolute notional threshold required when median < MIN_MEDIAN_USD
 * This prevents false positives from wallets with very small typical trades
 * (default: 2000)
 */
export const SMALL_MEDIAN_ABS_THRESHOLD = parseEnvNumber('ANOMALY_SMALL_MEDIAN_ABS_THRESHOLD', 2000);

/** Small epsilon for robust_z scale to avoid division by zero (default: 1e-9) */
export const EPS = 1e-9;

// =========================================================================
// Dedupe / Cooldown
// =========================================================================

/** Dedupe window in minutes - anomalies for same wallet+market within this window are merged */
export const DEDUPE_WINDOW_MINUTES = parseEnvInt('ANOMALY_DEDUPE_WINDOW_MINUTES', 10);

// =========================================================================
// Utility functions
// =========================================================================

/**
 * Compute severity score for an anomaly
 * severity = ln(1 + notional) * ln(1 + ratio)
 * This is monotonic in both inputs and bounded-ish for practical values
 */
export function computeSeverity(notionalUsd: number, ratio: number): number {
  return Math.log1p(notionalUsd) * Math.log1p(ratio);
}

/**
 * Compute the effective median with floor applied
 */
export function computeEffectiveMedian(medianNotional: number): number {
  return Math.max(medianNotional, DENOMINATOR_FLOOR_USD);
}

/**
 * Compute robust Z-score with epsilon floor for scale
 * robust_z = (notional - median) / (1.4826 * MAD)
 * Returns null if MAD is not available or effectively zero
 */
export function computeRobustZ(notionalUsd: number, medianNotional: number, mad: number): number | null {
  if (mad <= 0) return null;
  const scale = Math.max(EPS, 1.4826 * mad);
  return (notionalUsd - medianNotional) / scale;
}

/**
 * Check if a trade qualifies as an anomaly based on all criteria
 * Returns { qualifies: boolean, reason?: string, ratio, robustZ, severity }
 */
export function evaluateAnomaly(
  notionalUsd: number,
  medianNotional: number,
  mad: number,
  tradeCount: number
): {
  qualifies: boolean;
  reason?: string;
  ratio: number;
  robustZ: number | null;
  severity: number;
  effectiveMedian: number;
} {
  // Check minimum trade count
  if (tradeCount < MIN_TRADES) {
    return {
      qualifies: false,
      reason: 'insufficient_trades',
      ratio: 0,
      robustZ: null,
      severity: 0,
      effectiveMedian: 0,
    };
  }

  // Check minimum absolute notional
  if (notionalUsd < MIN_ABS_NOTIONAL_USD) {
    return {
      qualifies: false,
      reason: 'below_min_notional',
      ratio: 0,
      robustZ: null,
      severity: 0,
      effectiveMedian: 0,
    };
  }

  // Compute effective median with floor
  const effectiveMedian = computeEffectiveMedian(medianNotional);
  const ratio = notionalUsd / effectiveMedian;

  // Compute robust Z-score
  const robustZ = computeRobustZ(notionalUsd, medianNotional, mad);

  // Compute severity
  const severity = computeSeverity(notionalUsd, ratio);

  // Check if median is too small - require additional absolute threshold
  if (medianNotional < MIN_MEDIAN_USD) {
    if (notionalUsd < SMALL_MEDIAN_ABS_THRESHOLD) {
      return {
        qualifies: false,
        reason: 'small_median_below_abs_threshold',
        ratio,
        robustZ,
        severity,
        effectiveMedian,
      };
    }
    // Wallet has small median but trade is large enough in absolute terms
    // Still require ratio threshold
  }

  // Check ratio threshold
  if (ratio < RATIO_THRESHOLD) {
    return {
      qualifies: false,
      reason: 'below_ratio_threshold',
      ratio,
      robustZ,
      severity,
      effectiveMedian,
    };
  }

  // Check robust Z threshold (only if MAD is available)
  if (robustZ !== null && robustZ < ROBUST_Z_THRESHOLD) {
    return {
      qualifies: false,
      reason: 'below_robust_z_threshold',
      ratio,
      robustZ,
      severity,
      effectiveMedian,
    };
  }

  return {
    qualifies: true,
    ratio,
    robustZ,
    severity,
    effectiveMedian,
  };
}

/**
 * Constant-time string comparison to prevent timing attacks
 * Returns true if strings are equal
 */
export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do the comparison to maintain constant time
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ (b.charCodeAt(i % b.length) || 0);
    }
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
