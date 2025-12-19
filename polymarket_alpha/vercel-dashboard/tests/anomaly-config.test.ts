// tests/anomaly-config.test.ts
// Run with: npx tsx tests/anomaly-config.test.ts

import {
  computeSeverity,
  computeEffectiveMedian,
  computeRobustZ,
  evaluateAnomaly,
  constantTimeCompare,
  MIN_TRADES,
  MIN_ABS_NOTIONAL_USD,
  RATIO_THRESHOLD,
  MIN_MEDIAN_USD,
  DENOMINATOR_FLOOR_USD,
  SMALL_MEDIAN_ABS_THRESHOLD,
  EPS,
} from '../lib/anomaly-config';

// Simple test runner
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`✗ ${name}`);
    console.log(`  Error: ${err instanceof Error ? err.message : err}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(`${message || 'Assertion failed'}: expected ${expected}, got ${actual}`);
  }
}

function assertClose(actual: number, expected: number, tolerance = 0.001, message?: string) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message || 'Assertion failed'}: expected ~${expected}, got ${actual}`);
  }
}

function assertTrue(value: boolean, message?: string) {
  if (!value) {
    throw new Error(message || 'Expected true');
  }
}

function assertFalse(value: boolean, message?: string) {
  if (value) {
    throw new Error(message || 'Expected false');
  }
}

console.log('\n=== Testing anomaly-config ===\n');

// Test computeSeverity
test('computeSeverity: severity = ln(1 + notional) * ln(1 + ratio)', () => {
  const notional = 1000;
  const ratio = 3;
  const expected = Math.log1p(notional) * Math.log1p(ratio);
  const actual = computeSeverity(notional, ratio);
  assertClose(actual, expected);
});

test('computeSeverity: zero inputs give zero severity', () => {
  assertEqual(computeSeverity(0, 0), 0, 'zero notional and ratio');
});

test('computeSeverity: is monotonic in notional', () => {
  const s1 = computeSeverity(500, 3);
  const s2 = computeSeverity(1000, 3);
  const s3 = computeSeverity(2000, 3);
  assertTrue(s1 < s2 && s2 < s3, 'severity should increase with notional');
});

test('computeSeverity: is monotonic in ratio', () => {
  const s1 = computeSeverity(1000, 2);
  const s2 = computeSeverity(1000, 3);
  const s3 = computeSeverity(1000, 5);
  assertTrue(s1 < s2 && s2 < s3, 'severity should increase with ratio');
});

// Test computeEffectiveMedian (denominator floor)
test('computeEffectiveMedian: applies floor when median is small', () => {
  const result = computeEffectiveMedian(10);
  assertEqual(result, DENOMINATOR_FLOOR_USD, 'should use floor when median < floor');
});

test('computeEffectiveMedian: uses actual median when larger than floor', () => {
  const result = computeEffectiveMedian(200);
  assertEqual(result, 200, 'should use actual median when > floor');
});

test('computeEffectiveMedian: edge case at floor boundary', () => {
  const result = computeEffectiveMedian(DENOMINATOR_FLOOR_USD);
  assertEqual(result, DENOMINATOR_FLOOR_USD, 'should equal floor at boundary');
});

// Test computeRobustZ
test('computeRobustZ: returns null when MAD is zero', () => {
  const result = computeRobustZ(1000, 200, 0);
  assertEqual(result, null, 'should return null for MAD=0');
});

test('computeRobustZ: returns null when MAD is negative', () => {
  const result = computeRobustZ(1000, 200, -1);
  assertEqual(result, null, 'should return null for MAD<0');
});

test('computeRobustZ: computes correctly for positive MAD', () => {
  const notional = 1000;
  const median = 200;
  const mad = 100;
  const expected = (notional - median) / (1.4826 * mad);
  const actual = computeRobustZ(notional, median, mad);
  assertClose(actual!, expected);
});

test('computeRobustZ: uses EPS floor for tiny MAD', () => {
  const notional = 1000;
  const median = 200;
  const mad = 1e-15; // Very tiny
  const result = computeRobustZ(notional, median, mad);
  // Should use EPS floor, not divide by near-zero
  assertTrue(Number.isFinite(result!), 'should be finite even with tiny MAD');
});

// Test evaluateAnomaly - insufficient trades
test('evaluateAnomaly: rejects wallets with insufficient trades', () => {
  const result = evaluateAnomaly(1000, 100, 50, MIN_TRADES - 1);
  assertFalse(result.qualifies);
  assertEqual(result.reason, 'insufficient_trades');
});

// Test evaluateAnomaly - below minimum notional
test('evaluateAnomaly: rejects trades below minimum notional', () => {
  const result = evaluateAnomaly(MIN_ABS_NOTIONAL_USD - 1, 100, 50, MIN_TRADES);
  assertFalse(result.qualifies);
  assertEqual(result.reason, 'below_min_notional');
});

// Test evaluateAnomaly - small median behavior
test('evaluateAnomaly: rejects small median + below abs threshold', () => {
  // Wallet with median < MIN_MEDIAN_USD and trade below SMALL_MEDIAN_ABS_THRESHOLD
  const result = evaluateAnomaly(MIN_ABS_NOTIONAL_USD, MIN_MEDIAN_USD - 10, 10, MIN_TRADES);
  assertFalse(result.qualifies);
  assertEqual(result.reason, 'small_median_below_abs_threshold');
});

test('evaluateAnomaly: allows small median if trade is large enough', () => {
  // Wallet with median < MIN_MEDIAN_USD but trade >= SMALL_MEDIAN_ABS_THRESHOLD
  const largeNotional = SMALL_MEDIAN_ABS_THRESHOLD + 500;
  const result = evaluateAnomaly(largeNotional, MIN_MEDIAN_USD - 10, 10, MIN_TRADES);
  // Should pass the small median check, but may still fail ratio threshold
  assertTrue(result.reason !== 'small_median_below_abs_threshold');
});

// Test evaluateAnomaly - ratio threshold
test('evaluateAnomaly: rejects trades below ratio threshold', () => {
  // Trade is $500, median is $250, ratio is 2.0 (below 2.5 threshold)
  const result = evaluateAnomaly(500, 250, 50, MIN_TRADES);
  assertFalse(result.qualifies);
  assertEqual(result.reason, 'below_ratio_threshold');
});

test('evaluateAnomaly: accepts trades meeting ratio threshold', () => {
  // Trade is $1000, median is $200, ratio is 5.0 (above 2.5 threshold)
  const result = evaluateAnomaly(1000, 200, 50, MIN_TRADES);
  assertTrue(result.qualifies, 'should qualify');
  assertClose(result.ratio, 5.0);
  assertTrue(result.severity > 0);
});

// Test evaluateAnomaly - uses denominator floor
test('evaluateAnomaly: uses denominator floor for tiny median', () => {
  // Median is $10, floor is $50, trade is $500
  // Effective median should be $50, ratio should be $500/$50 = 10
  const result = evaluateAnomaly(2500, 10, 5, MIN_TRADES);
  // Should use floor of 50, not 10
  assertEqual(result.effectiveMedian, DENOMINATOR_FLOOR_USD);
  assertClose(result.ratio, 2500 / DENOMINATOR_FLOOR_USD);
});

// Test evaluateAnomaly - robust Z threshold
test('evaluateAnomaly: robust Z does not block if null (MAD=0)', () => {
  // Even with MAD=0, should qualify if ratio is met
  const result = evaluateAnomaly(1000, 200, 0, MIN_TRADES);
  assertTrue(result.qualifies);
  assertEqual(result.robustZ, null);
});

test('evaluateAnomaly: robust Z blocks if below threshold', () => {
  // Create a case where ratio is high but robust Z is low
  // Trade $500, median $100, MAD very high ($200)
  // Ratio = 5x, but robust Z = (500-100)/(1.4826*200) = 1.35
  const result = evaluateAnomaly(500, 100, 200, MIN_TRADES);
  assertFalse(result.qualifies);
  assertEqual(result.reason, 'below_robust_z_threshold');
});

// Test constantTimeCompare
test('constantTimeCompare: returns true for equal strings', () => {
  assertTrue(constantTimeCompare('secret123', 'secret123'));
});

test('constantTimeCompare: returns false for different strings', () => {
  assertFalse(constantTimeCompare('secret123', 'secret456'));
});

test('constantTimeCompare: returns false for different lengths', () => {
  assertFalse(constantTimeCompare('short', 'muchlongerstring'));
});

test('constantTimeCompare: handles empty strings', () => {
  assertTrue(constantTimeCompare('', ''));
  assertFalse(constantTimeCompare('', 'notempty'));
});

// Print summary
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

if (failed > 0) {
  process.exit(1);
}
