import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Polymarket Insider Tracker',
  description: 'Real-time monitoring of suspicious trading activity on Polymarket',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        {/* Navigation */}
        <nav className="bg-poly-card border-b border-poly-border sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4">
            <div className="flex items-center justify-between h-16">
              <a href="/" className="flex items-center space-x-3">
                <div className="w-8 h-8 bg-poly-green rounded-lg flex items-center justify-center">
                  <span className="text-black font-bold text-lg">P</span>
                </div>
                <span className="font-bold text-xl">Polymarket Insider Tracker</span>
              </a>
              <div className="flex items-center space-x-6">
                <a href="/insiders" className="text-poly-muted hover:text-white transition">
                  Insiders
                </a>
                <a href="/radar" className="text-poly-muted hover:text-white transition">
                  Radar
                </a>
                <a href="https://polymarket.com" target="_blank" className="text-poly-muted hover:text-white transition">
                  Polymarket
                </a>
              </div>
            </div>
          </div>
        </nav>

        {/* Main Content */}
        <main className="max-w-7xl mx-auto px-4 py-6">
          {children}
        </main>

        {/* Footer */}
        <footer className="border-t border-poly-border mt-12 py-6">
          <div className="max-w-7xl mx-auto px-4 text-center text-poly-muted text-sm">
            Polymarket Insider Tracker | Data from Polymarket API
          </div>
        </footer>
      </body>
    </html>
  )
}
