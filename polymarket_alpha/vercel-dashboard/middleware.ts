import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Simple password protection for the dashboard
// Set DASHBOARD_PASSWORD in Vercel Environment Variables
const PROTECTED = process.env.DASHBOARD_PASSWORD

// Basic Auth credentials for admin routes
const ADMIN_USER = process.env.ADMIN_BASIC_USER
const ADMIN_PASS = process.env.ADMIN_BASIC_PASS

// Cron secret for job endpoints (Bearer token)
const CRON_SECRET = process.env.CRON_SECRET

// Constant-time string comparison to prevent timing attacks
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do comparison to maintain timing consistency
    let result = 0
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ (b.charCodeAt(i % b.length) || 0)
    }
    return false
  }

  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

// Check if this is an admin/jobs path requiring Basic Auth
function isAdminPath(pathname: string): boolean {
  return (
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname.startsWith('/api/admin/') ||
    pathname.startsWith('/api/jobs/')
  )
}

// Verify Basic Auth header (uses constant-time comparison)
function verifyBasicAuth(request: NextRequest): boolean {
  if (!ADMIN_USER || !ADMIN_PASS) {
    // If credentials not configured, warn in dev and deny in production
    if (process.env.NODE_ENV === 'development') {
      console.warn('[middleware] ADMIN_BASIC_USER/ADMIN_BASIC_PASS not set - allowing in dev mode')
      return true
    }
    return false
  }

  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Basic ')) {
    return false
  }

  const base64Credentials = authHeader.slice(6)
  try {
    const credentials = atob(base64Credentials)
    const [user, pass] = credentials.split(':')
    // Use constant-time comparison for both user and password
    const userMatch = constantTimeCompare(user || '', ADMIN_USER)
    const passMatch = constantTimeCompare(pass || '', ADMIN_PASS)
    return userMatch && passMatch
  } catch {
    return false
  }
}

// Verify cron auth - Bearer token, x-cron-secret header, or query param (for jobs only)
// Uses constant-time comparison to prevent timing attacks
function verifyCronAuth(request: NextRequest, allowQueryParam: boolean = false): boolean {
  if (!CRON_SECRET) {
    // In production without CRON_SECRET, deny cron auth
    if (process.env.NODE_ENV !== 'development') {
      return false
    }
    console.warn('[middleware] CRON_SECRET not set')
    return false
  }

  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    if (constantTimeCompare(token, CRON_SECRET)) {
      return true
    }
  }

  // Check x-cron-secret header (alternative)
  const cronSecretHeader = request.headers.get('x-cron-secret')
  if (cronSecretHeader && constantTimeCompare(cronSecretHeader, CRON_SECRET)) {
    return true
  }

  // Check query param fallback (only for /api/jobs/* endpoints)
  if (allowQueryParam) {
    const url = new URL(request.url)
    const cronSecretParam = url.searchParams.get('cronSecret')
    if (cronSecretParam && constantTimeCompare(cronSecretParam, CRON_SECRET)) {
      return true
    }
  }

  return false
}

// Return Basic Auth challenge response
function unauthorizedResponse(): NextResponse {
  return new NextResponse('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Admin"',
    },
  })
}

export function middleware(request: NextRequest) {
  const url = new URL(request.url)
  const pathname = url.pathname

  // =========================================================================
  // Handle Admin/Jobs paths - require Basic Auth or Bearer/cron token
  // =========================================================================
  if (isAdminPath(pathname)) {
    // For job endpoints, allow cron auth (Bearer/header/query param) or Basic Auth
    if (pathname.startsWith('/api/jobs/')) {
      // Allow query param for jobs endpoints only
      if (verifyCronAuth(request, true) || verifyBasicAuth(request)) {
        // Add header to indicate auth passed (for route handler to check)
        const response = NextResponse.next()
        response.headers.set('x-middleware-auth', 'passed')
        return response
      }
      return unauthorizedResponse()
    }

    // For admin pages/APIs, require Basic Auth only
    if (!verifyBasicAuth(request)) {
      return unauthorizedResponse()
    }

    const response = NextResponse.next()
    response.headers.set('x-middleware-auth', 'passed')
    return response
  }

  // =========================================================================
  // Handle cron job endpoint (existing behavior for collect-trades)
  // =========================================================================
  if (pathname === '/api/collect-trades') {
    // Verify it's from Vercel cron (has the special header) or has cron auth
    const cronHeader = request.headers.get('x-vercel-cron')
    if (cronHeader) {
      return NextResponse.next()
    }
    // Also allow cron auth (Bearer or x-cron-secret header)
    if (verifyCronAuth(request, false)) {
      return NextResponse.next()
    }
  }

  // =========================================================================
  // Handle regular dashboard pages - cookie-based auth
  // =========================================================================

  // Skip auth if no password is configured
  if (!PROTECTED) {
    return NextResponse.next()
  }

  // Check for auth cookie
  const authCookie = request.cookies.get('dashboard_auth')
  if (authCookie?.value === PROTECTED) {
    return NextResponse.next()
  }

  // Check for password in query param (for initial login)
  const password = url.searchParams.get('password')

  if (password === PROTECTED) {
    // Set auth cookie and redirect to clean URL
    const response = NextResponse.redirect(new URL(pathname, request.url))
    response.cookies.set('dashboard_auth', PROTECTED, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    })
    return response
  }

  // Show login page
  return new NextResponse(
    `<!DOCTYPE html>
    <html>
    <head>
      <title>Login - Polymarket Tracker</title>
      <style>
        body {
          font-family: system-ui;
          background: #0a0a0a;
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100vh;
          margin: 0;
        }
        .login {
          background: #1a1a1a;
          padding: 2rem;
          border-radius: 8px;
          border: 1px solid #333;
          text-align: center;
        }
        input {
          padding: 0.75rem 1rem;
          border-radius: 4px;
          border: 1px solid #333;
          background: #0a0a0a;
          color: white;
          margin: 1rem 0;
          width: 200px;
        }
        button {
          padding: 0.75rem 1.5rem;
          border-radius: 4px;
          border: none;
          background: #22c55e;
          color: black;
          font-weight: bold;
          cursor: pointer;
        }
        button:hover { background: #16a34a; }
      </style>
    </head>
    <body>
      <div class="login">
        <h2>Polymarket Tracker</h2>
        <p style="color: #888;">Enter password to access</p>
        <form method="GET">
          <input type="password" name="password" placeholder="Password" autofocus />
          <br/>
          <button type="submit">Login</button>
        </form>
      </div>
    </body>
    </html>`,
    {
      status: 401,
      headers: { 'Content-Type': 'text/html' },
    }
  )
}

export const config = {
  // Protect all pages and APIs
  matcher: [
    '/',
    '/report',
    '/history',
    '/admin',
    '/admin/:path*',
    '/api/daily-report',
    '/api/longshot-history',
    '/api/suspicious',
    '/api/admin/:path*',
    '/api/jobs/:path*',
  ],
}
