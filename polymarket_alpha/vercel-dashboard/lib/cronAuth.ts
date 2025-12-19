// /lib/cronAuth.ts
// Shared authentication helper for cron job endpoints
// Validates Authorization: Bearer <CRON_SECRET> or x-cron-secret header (legacy)
// Uses crypto.timingSafeEqual to prevent timing attacks

import { timingSafeEqual } from 'crypto';

/**
 * Constant-time string comparison using Node.js crypto
 */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Verify cron authentication from request headers
 * Accepts:
 * - Authorization: Bearer <CRON_SECRET> (preferred)
 * - x-cron-secret: <CRON_SECRET> (legacy, for backward compatibility)
 *
 * @param request - The incoming request
 * @returns true if authenticated, false otherwise
 */
export function isCronAuthed(request: Request): boolean {
  const expectedSecret = process.env.CRON_SECRET;

  // If CRON_SECRET is not set, allow only in dev mode
  if (!expectedSecret) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[cronAuth] CRON_SECRET not set - allowing in dev mode');
      return true;
    }
    console.error('[cronAuth] CRON_SECRET not set - denying in production');
    return false;
  }

  // Check Authorization: Bearer header (preferred)
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (safeCompare(token, expectedSecret)) {
      return true;
    }
  }

  // Check x-cron-secret header (legacy, for backward compatibility)
  const cronSecretHeader = request.headers.get('x-cron-secret');
  if (cronSecretHeader && safeCompare(cronSecretHeader, expectedSecret)) {
    return true;
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
