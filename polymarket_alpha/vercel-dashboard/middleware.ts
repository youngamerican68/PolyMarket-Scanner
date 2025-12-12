import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Simple password protection for the dashboard
// Set DASHBOARD_PASSWORD in Vercel Environment Variables
const PROTECTED = process.env.DASHBOARD_PASSWORD

export function middleware(request: NextRequest) {
  // Skip auth if no password is configured
  if (!PROTECTED) {
    return NextResponse.next()
  }

  // Skip auth for cron job endpoint (Vercel cron can't provide auth)
  const url = new URL(request.url)
  if (url.pathname === '/api/collect-trades') {
    // Verify it's from Vercel cron (has the special header)
    const cronSecret = request.headers.get('x-vercel-cron')
    if (cronSecret) {
      return NextResponse.next()
    }
  }

  // Check for auth cookie
  const authCookie = request.cookies.get('dashboard_auth')
  if (authCookie?.value === PROTECTED) {
    return NextResponse.next()
  }

  // Check for password in query param (for initial login)
  const url = new URL(request.url)
  const password = url.searchParams.get('password')

  if (password === PROTECTED) {
    // Set auth cookie and redirect to clean URL
    const response = NextResponse.redirect(new URL(url.pathname, request.url))
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
  // Exclude /api/collect-trades from middleware (needs to be accessible by Vercel cron)
  matcher: ['/', '/report', '/api/daily-report', '/api/suspicious'],
}
