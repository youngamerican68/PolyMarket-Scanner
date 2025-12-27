// /lib/cronAuth.ts
// Shared authentication helper for cron job endpoints
// Validates Authorization: Bearer <CRON_SECRET> or x-cron-secret header (legacy)
// Uses crypto.timingSafeEqual to prevent timing attacks
//
// Security properties:
// - Never throws on malformed/missing headers (always returns boolean)
// - Length-checks before timingSafeEqual to avoid throwing
// - Dev bypass only in true local development (not Vercel preview/prod)
// - CRON_SECRET is compared exactly as configured (no trimming)
// - Incoming tokens are trimmed to tolerate whitespace in headers

import { timingSafeEqual } from 'crypto';

// =============================================================================
// Log rate-limiting: prevent spam when CRON_SECRET is missing
// =============================================================================
let hasLoggedMissingSecret = false;

/**
 * Constant-time string comparison using Node.js crypto.timingSafeEqual
 *
 * Security: timingSafeEqual throws if buffers differ in length, so we
 * pre-check length and return false on mismatch (no timing leak for length).
 *
 * @param a - First string to compare (incoming token, already trimmed by caller)
 * @param b - Second string to compare (expected secret, exact match required)
 * @returns true if strings match, false otherwise (never throws)
 */
function safeCompare(a: string, b: string): boolean {
  // Guard: empty strings should never match
  if (!a || !b) {
    return false;
  }

  // Guard: length mismatch - return false without calling timingSafeEqual
  // (timingSafeEqual throws on length mismatch)
  if (a.length !== b.length) {
    return false;
  }

  // Both strings are non-empty and same length - safe to compare
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    // Defensive: should not reach here given guards above, but fail closed
    return false;
  }
}

/**
 * Check if we're in true local development (not Vercel preview/prod)
 *
 * Returns true only when:
 * - NODE_ENV === 'development'
 * - VERCEL_ENV is undefined OR 'development'
 *
 * This ensures dev bypass doesn't accidentally apply on Vercel preview deployments
 * where NODE_ENV might be 'development' but VERCEL_ENV is 'preview'.
 */
function isLocalDevelopment(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  const vercelEnv = process.env.VERCEL_ENV;

  // Must be NODE_ENV=development
  if (nodeEnv !== 'development') {
    return false;
  }

  // VERCEL_ENV must be undefined (local) or 'development'
  // If VERCEL_ENV is 'preview' or 'production', we're on Vercel - not local
  if (vercelEnv && vercelEnv !== 'development') {
    return false;
  }

  return true;
}

/**
 * Extract Bearer token from Authorization header (case-insensitive)
 *
 * Accepts: "Bearer <token>", "bearer <token>", "BEARER <token>", etc.
 * Returns null if header is missing, malformed, or not Bearer auth.
 *
 * @param authHeader - The Authorization header value
 * @returns The token (trimmed) or null if not a valid Bearer header
 */
function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }

  // Case-insensitive check for "Bearer " prefix
  const lowerHeader = authHeader.toLowerCase();
  if (!lowerHeader.startsWith('bearer ')) {
    return null;
  }

  // Extract token after "Bearer " (7 characters), trim whitespace
  const token = authHeader.slice(7).trim();
  return token || null; // Return null if token is empty after trim
}

/**
 * Verify cron authentication from request headers
 *
 * Accepts:
 * - Authorization: Bearer <CRON_SECRET> (preferred, case-insensitive "Bearer")
 * - x-cron-secret: <CRON_SECRET> (legacy, for backward compatibility)
 *
 * Security:
 * - Never throws (always returns boolean)
 * - Fails closed if CRON_SECRET not configured (except true local dev)
 * - Uses constant-time comparison to prevent timing attacks
 * - CRON_SECRET must match exactly (no trimming of configured value)
 * - Incoming tokens are trimmed to tolerate whitespace
 *
 * @param request - The incoming request
 * @returns true if authenticated, false otherwise
 */
export function isCronAuthed(request: Request): boolean {
  // Get configured secret - do NOT trim (must match exactly as configured)
  const expectedSecret = process.env.CRON_SECRET;

  // If CRON_SECRET is not set or empty string
  if (!expectedSecret) {
    // Allow bypass ONLY in true local development
    if (isLocalDevelopment()) {
      console.warn('[cronAuth] CRON_SECRET not set - allowing in local dev mode');
      return true;
    }
    // Fail closed in all other environments (preview, production, etc.)
    // Rate-limit this log to once per cold start to prevent spam from probes
    if (!hasLoggedMissingSecret) {
      console.error('[cronAuth] CRON_SECRET not configured - denying requests (fail closed)');
      hasLoggedMissingSecret = true;
    }
    return false;
  }

  // Check Authorization: Bearer header (preferred, case-insensitive)
  const authHeader = request.headers.get('authorization');
  const bearerToken = extractBearerToken(authHeader);
  if (bearerToken && safeCompare(bearerToken, expectedSecret)) {
    return true;
  }

  // Check x-cron-secret header (legacy, for backward compatibility)
  const cronSecretHeader = request.headers.get('x-cron-secret');
  if (cronSecretHeader) {
    const trimmedSecret = cronSecretHeader.trim();
    if (trimmedSecret && safeCompare(trimmedSecret, expectedSecret)) {
      return true;
    }
  }

  return false;
}

/**
 * Return a 401 Unauthorized JSON response
 */
export function cronUnauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

// =============================================================================
// Manual Verification Checklist
// =============================================================================
//
// 1. Local dev (no secret) => bypass works
//    - Set NODE_ENV=development, unset VERCEL_ENV and CRON_SECRET
//    - Call cron endpoint without auth header
//    - Expected: 200 OK (bypass)
//
// 2. Preview/prod (no secret) => 401
//    - Set VERCEL_ENV=preview (or production), unset CRON_SECRET
//    - Call cron endpoint without auth header
//    - Expected: 401 Unauthorized
//    - Logs: "[cronAuth] CRON_SECRET not configured" (once per cold start)
//
// 3. Correct Authorization Bearer succeeds
//    - Set CRON_SECRET=mysecret123
//    - Call with header: Authorization: Bearer mysecret123
//    - Expected: 200 OK
//    - Also works: authorization: bearer mysecret123 (case-insensitive)
//
// 4. Correct x-cron-secret header succeeds
//    - Set CRON_SECRET=mysecret123
//    - Call with header: x-cron-secret: mysecret123
//    - Expected: 200 OK
//
// 5. Wrong/missing token => 401
//    - Set CRON_SECRET=mysecret123
//    - Call with header: Authorization: Bearer wrongtoken
//    - Expected: 401 Unauthorized
//
// =============================================================================
// Unit Test Reference (safeCompare)
// =============================================================================
//
//   safeCompare('', '')           → false (empty strings never match)
//   safeCompare('abc', '')        → false (one empty)
//   safeCompare('', 'abc')        → false (one empty)
//   safeCompare('abc', 'ab')      → false (length mismatch, no throw)
//   safeCompare('abc', 'abd')     → false (content mismatch)
//   safeCompare('abc', 'abc')     → true  (exact match)
//   safeCompare(' abc', 'abc')    → false (whitespace matters - caller trims)
//
// =============================================================================
// Unit Test Reference (isLocalDevelopment)
// =============================================================================
//
//   NODE_ENV=development, VERCEL_ENV=undefined    → true  (local dev)
//   NODE_ENV=development, VERCEL_ENV=development  → true  (allowed)
//   NODE_ENV=development, VERCEL_ENV=preview      → false (Vercel preview)
//   NODE_ENV=development, VERCEL_ENV=production   → false (misconfigured)
//   NODE_ENV=production,  VERCEL_ENV=undefined    → false (prod build local)
//   NODE_ENV=production,  VERCEL_ENV=production   → false (prod on Vercel)
//
// =============================================================================
// Unit Test Reference (extractBearerToken)
// =============================================================================
//
//   extractBearerToken(null)                    → null
//   extractBearerToken('')                      → null
//   extractBearerToken('Basic abc123')          → null (not Bearer)
//   extractBearerToken('Bearer ')               → null (empty token)
//   extractBearerToken('Bearer abc')            → 'abc'
//   extractBearerToken('bearer abc')            → 'abc' (case-insensitive)
//   extractBearerToken('BEARER abc')            → 'abc' (case-insensitive)
//   extractBearerToken('Bearer  abc ')          → 'abc' (trimmed)
//   extractBearerToken('Bearer abc def')        → 'abc def' (preserves spaces in token)
