// tests/heartbeat.test.ts
// Run with: npx tsx tests/heartbeat.test.ts

import {
  isJobStale,
  generateHealthMessage,
  buildJobHealthCheck,
  buildHeartbeatResponse,
  verifyOpsSecret,
  MONITORED_JOBS,
} from '../lib/heartbeat';

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

console.log('\n=== Testing heartbeat ===\n');

// =========================================================================
// Test isJobStale
// =========================================================================

test('isJobStale: null lastSuccessAt => stale true', () => {
  const result = isJobStale(null, 360);
  assertTrue(result, 'null lastSuccessAt should be stale');
});

test('isJobStale: lastSuccessAt older than 2*schedule => stale true', () => {
  const now = new Date('2024-01-15T12:00:00Z');
  const scheduleMinutes = 360; // 6 hours
  // Last success was 13 hours ago (> 12 hours = 2 * 6 hours)
  const lastSuccess = new Date('2024-01-14T23:00:00Z');

  const result = isJobStale(lastSuccess, scheduleMinutes, now);
  assertTrue(result, 'lastSuccessAt older than 2x schedule should be stale');
});

test('isJobStale: lastSuccessAt exactly at 2*schedule boundary => stale false', () => {
  const now = new Date('2024-01-15T12:00:00Z');
  const scheduleMinutes = 360; // 6 hours
  // Last success was exactly 12 hours ago (= 2 * 6 hours)
  const lastSuccess = new Date('2024-01-15T00:00:00Z');

  const result = isJobStale(lastSuccess, scheduleMinutes, now);
  // At exactly the boundary, timeSinceSuccess === threshold, which is NOT > threshold
  assertFalse(result, 'lastSuccessAt at exactly 2x schedule should not be stale');
});

test('isJobStale: recent lastSuccessAt => stale false', () => {
  const now = new Date('2024-01-15T12:00:00Z');
  const scheduleMinutes = 360; // 6 hours
  // Last success was 2 hours ago (well within 12 hour threshold)
  const lastSuccess = new Date('2024-01-15T10:00:00Z');

  const result = isJobStale(lastSuccess, scheduleMinutes, now);
  assertFalse(result, 'recent lastSuccessAt should not be stale');
});

test('isJobStale: lastSuccessAt 1 minute ago => stale false', () => {
  const now = new Date('2024-01-15T12:00:00Z');
  const scheduleMinutes = 360;
  const lastSuccess = new Date('2024-01-15T11:59:00Z');

  const result = isJobStale(lastSuccess, scheduleMinutes, now);
  assertFalse(result, 'very recent lastSuccessAt should not be stale');
});

test('isJobStale: daily job (1440 min) stale after 48h', () => {
  const now = new Date('2024-01-15T12:00:00Z');
  const scheduleMinutes = 1440; // 24 hours (daily)
  // Last success was 49 hours ago (> 48 hours = 2 * 24 hours)
  const lastSuccess = new Date('2024-01-13T11:00:00Z');

  const result = isJobStale(lastSuccess, scheduleMinutes, now);
  assertTrue(result, 'daily job should be stale after 48h');
});

test('isJobStale: daily job (1440 min) not stale within 48h', () => {
  const now = new Date('2024-01-15T12:00:00Z');
  const scheduleMinutes = 1440; // 24 hours (daily)
  // Last success was 36 hours ago (< 48 hours)
  const lastSuccess = new Date('2024-01-14T00:00:00Z');

  const result = isJobStale(lastSuccess, scheduleMinutes, now);
  assertFalse(result, 'daily job should not be stale within 48h');
});

// =========================================================================
// Test generateHealthMessage
// =========================================================================

test('generateHealthMessage: null lastSuccessAt => STALE message', () => {
  const message = generateHealthMessage(null, true, 360);
  assertTrue(message.startsWith('STALE'), 'message should start with STALE');
  assertTrue(message.includes('no successful run'), 'message should mention no successful run');
});

test('generateHealthMessage: stale with time ago', () => {
  const now = new Date('2024-01-15T12:00:00Z');
  const lastSuccess = new Date('2024-01-14T23:00:00Z'); // 13h ago
  const message = generateHealthMessage(lastSuccess, true, 360, now);

  assertTrue(message.startsWith('STALE'), 'message should start with STALE');
  assertTrue(message.includes('13h ago'), 'message should include time ago');
});

test('generateHealthMessage: OK with hours ago', () => {
  const now = new Date('2024-01-15T12:00:00Z');
  const lastSuccess = new Date('2024-01-15T09:00:00Z'); // 3h ago
  const message = generateHealthMessage(lastSuccess, false, 360, now);

  assertTrue(message.startsWith('OK'), 'message should start with OK');
  assertTrue(message.includes('3h ago'), 'message should include time ago');
});

test('generateHealthMessage: OK with minutes ago', () => {
  const now = new Date('2024-01-15T12:00:00Z');
  const lastSuccess = new Date('2024-01-15T11:45:00Z'); // 15m ago
  const message = generateHealthMessage(lastSuccess, false, 360, now);

  assertTrue(message.startsWith('OK'), 'message should start with OK');
  assertTrue(message.includes('15m ago'), 'message should include minutes ago');
});

// =========================================================================
// Test buildJobHealthCheck
// =========================================================================

test('buildJobHealthCheck: builds correct structure', () => {
  const now = new Date('2024-01-15T12:00:00Z');
  const config = { jobName: 'test-job', scheduleMinutes: 360 };
  const lastSuccess = new Date('2024-01-15T10:00:00Z');
  const lastError = new Date('2024-01-15T08:00:00Z');

  const check = buildJobHealthCheck(config, lastSuccess, lastError, now);

  assertEqual(check.jobName, 'test-job');
  assertEqual(check.scheduleMinutes, 360);
  assertEqual(check.lastSuccessAt, '2024-01-15T10:00:00.000Z');
  assertEqual(check.lastErrorAt, '2024-01-15T08:00:00.000Z');
  assertFalse(check.stale);
  assertTrue(check.message.startsWith('OK'));
});

test('buildJobHealthCheck: handles null dates', () => {
  const now = new Date('2024-01-15T12:00:00Z');
  const config = { jobName: 'test-job', scheduleMinutes: 360 };

  const check = buildJobHealthCheck(config, null, null, now);

  assertEqual(check.lastSuccessAt, null);
  assertEqual(check.lastErrorAt, null);
  assertTrue(check.stale);
});

// =========================================================================
// Test buildHeartbeatResponse
// =========================================================================

test('buildHeartbeatResponse: ok=true when no stale jobs', () => {
  const checks = [
    { jobName: 'job1', scheduleMinutes: 360, lastSuccessAt: '2024-01-15T10:00:00Z', lastErrorAt: null, stale: false, message: 'OK' },
    { jobName: 'job2', scheduleMinutes: 1440, lastSuccessAt: '2024-01-15T08:00:00Z', lastErrorAt: null, stale: false, message: 'OK' },
  ];

  const response = buildHeartbeatResponse(checks);
  assertTrue(response.ok, 'ok should be true when no stale jobs');
  assertEqual(response.checks.length, 2);
});

test('buildHeartbeatResponse: ok=false when any job is stale', () => {
  const checks = [
    { jobName: 'job1', scheduleMinutes: 360, lastSuccessAt: '2024-01-15T10:00:00Z', lastErrorAt: null, stale: false, message: 'OK' },
    { jobName: 'job2', scheduleMinutes: 1440, lastSuccessAt: null, lastErrorAt: null, stale: true, message: 'STALE' },
  ];

  const response = buildHeartbeatResponse(checks);
  assertFalse(response.ok, 'ok should be false when any job is stale');
});

test('buildHeartbeatResponse: ok=true with empty checks', () => {
  const response = buildHeartbeatResponse([]);
  assertTrue(response.ok, 'ok should be true with empty checks array');
});

// =========================================================================
// Test verifyOpsSecret (auth)
// =========================================================================

// Note: These tests manipulate process.env temporarily

test('verifyOpsSecret: missing OPS_SECRET env var => false', () => {
  const originalSecret = process.env.OPS_SECRET;
  delete process.env.OPS_SECRET;

  try {
    const result = verifyOpsSecret('Bearer some-token');
    assertFalse(result, 'should return false when OPS_SECRET not configured');
  } finally {
    if (originalSecret) process.env.OPS_SECRET = originalSecret;
  }
});

test('verifyOpsSecret: null auth header => false', () => {
  const originalSecret = process.env.OPS_SECRET;
  process.env.OPS_SECRET = 'test-secret';

  try {
    const result = verifyOpsSecret(null);
    assertFalse(result, 'should return false for null auth header');
  } finally {
    if (originalSecret) {
      process.env.OPS_SECRET = originalSecret;
    } else {
      delete process.env.OPS_SECRET;
    }
  }
});

test('verifyOpsSecret: missing Bearer prefix => false', () => {
  const originalSecret = process.env.OPS_SECRET;
  process.env.OPS_SECRET = 'test-secret';

  try {
    const result = verifyOpsSecret('test-secret');
    assertFalse(result, 'should return false without Bearer prefix');
  } finally {
    if (originalSecret) {
      process.env.OPS_SECRET = originalSecret;
    } else {
      delete process.env.OPS_SECRET;
    }
  }
});

test('verifyOpsSecret: wrong token => false', () => {
  const originalSecret = process.env.OPS_SECRET;
  process.env.OPS_SECRET = 'correct-secret';

  try {
    const result = verifyOpsSecret('Bearer wrong-secret');
    assertFalse(result, 'should return false for wrong token');
  } finally {
    if (originalSecret) {
      process.env.OPS_SECRET = originalSecret;
    } else {
      delete process.env.OPS_SECRET;
    }
  }
});

test('verifyOpsSecret: correct token => true', () => {
  const originalSecret = process.env.OPS_SECRET;
  process.env.OPS_SECRET = 'correct-secret';

  try {
    const result = verifyOpsSecret('Bearer correct-secret');
    assertTrue(result, 'should return true for correct token');
  } finally {
    if (originalSecret) {
      process.env.OPS_SECRET = originalSecret;
    } else {
      delete process.env.OPS_SECRET;
    }
  }
});

// =========================================================================
// Test MONITORED_JOBS config
// =========================================================================

test('MONITORED_JOBS: contains refresh-baselines', () => {
  const job = MONITORED_JOBS.find(j => j.jobName === 'refresh-baselines');
  assertTrue(!!job, 'should include refresh-baselines');
  assertEqual(job!.scheduleMinutes, 360, 'refresh-baselines should have 360 minute schedule');
});

// Print summary
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

if (failed > 0) {
  process.exit(1);
}
