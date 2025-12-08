'use client'

import { useEffect, useState } from 'react'

interface Trade {
  wallet: string
  name: string
  title: string
  outcome: string
  price: number
  size: number
  value: number
  potential: number
  timestamp: number
  oddsFormatted?: string
  valueFormatted?: string
  potentialFormatted?: string
}

interface Trader {
  wallet: string
  name: string
  suspicionScore: number
  level: 'low' | 'medium' | 'high' | 'watch'
  levelReason?: string
  longshotWins: number
  longshotLosses: number
  totalProfit: number
  winRate: number
  longshotCount: number
  expectedWins: number
  actualWins: number
  zScore: number | null
  historicalPnl?: number
  historicalPnlFormatted?: string
  topWins: { title: string; outcome: string; entryPrice: number; profit: number }[]
  recentTrades: any[]
}

interface Data {
  timestamp: string
  window?: {
    from: string
    to: string
    minutes: number
  }
  suspiciousTraders: Trader[]
  recentLongshots: Trade[]
  stats: {
    totalTrades: number
    longshotTrades: number
    uniqueWallets: number
  }
}

function formatMoney(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}K`
  return `$${value.toFixed(0)}`
}

function formatTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString()
}

function getLevelInfo(level: string): { color: string; bg: string; label: string } {
  if (level === 'high') return { color: 'text-red-400', bg: 'bg-red-500/80', label: 'High settlement' }
  if (level === 'medium') return { color: 'text-amber-400', bg: 'bg-amber-500/70', label: 'Moderate' }
  if (level === 'watch') return { color: 'text-slate-300', bg: 'bg-slate-600/70', label: 'Watch' }
  return { color: 'text-slate-400', bg: 'bg-slate-700/60', label: 'Mild' }
}

export default function Home() {
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<string>('')

  const fetchData = async () => {
    try {
      setLoading(true)
      const res = await fetch('/api/suspicious')
      if (!res.ok) throw new Error('Failed to fetch')
      const json = await res.json()
      setData(json)
      setLastUpdate(new Date().toLocaleTimeString())
      setError(null)
    } catch (e) {
      setError('Failed to fetch data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    // Refresh every 2 minutes
    const interval = setInterval(fetchData, 120000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="space-y-8">
      {/* Disclaimer */}
      <div className="text-xs text-poly-muted bg-poly-card border border-poly-border rounded p-2 space-y-1">
        <p>
          <strong>Note:</strong> This uses settlement-time windows. Win clusters can appear anomalous
          even for wallets that are long-term losers. Always check historical PnL.
        </p>
        <p>Statistical outliers are not proof of misconduct.</p>
      </div>

      {/* Header Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-poly-card border border-poly-border rounded-lg p-4">
          <p className="text-poly-muted text-sm">Total Trades Analyzed</p>
          <p className="text-2xl font-bold">{data?.stats.totalTrades || '-'}</p>
        </div>
        <div className="bg-poly-card border border-poly-border rounded-lg p-4">
          <p className="text-poly-muted text-sm">Longshot Trades</p>
          <p className="text-2xl font-bold text-poly-yellow">{data?.stats.longshotTrades || '-'}</p>
        </div>
        <div className="bg-poly-card border border-poly-border rounded-lg p-4">
          <p className="text-poly-muted text-sm">Unique Wallets</p>
          <p className="text-2xl font-bold">{data?.stats.uniqueWallets || '-'}</p>
        </div>
        <div className="bg-poly-card border border-poly-border rounded-lg p-4">
          <p className="text-poly-muted text-sm">Last Updated</p>
          <p className="text-2xl font-bold text-poly-green">{lastUpdate || '-'}</p>
          <button
            onClick={fetchData}
            disabled={loading}
            className="mt-2 text-sm text-poly-blue hover:underline disabled:opacity-50"
          >
            {loading ? 'Refreshing...' : 'Refresh Now'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/20 border border-red-500 rounded-lg p-4 text-red-400">
          {error}
        </div>
      )}

      {/* Anomalous Traders */}
      <div>
        <h2 className="text-2xl font-bold mb-4 flex items-center">
          <span className="w-3 h-3 bg-poly-yellow rounded-full mr-3 alert-pulse"></span>
          Settlement Anomalies
          <span className="text-sm font-normal text-poly-muted ml-2">(Last Hour - check PnL)</span>
        </h2>

        {data?.suspiciousTraders.length === 0 && !loading && (
          <div className="bg-poly-card border border-poly-border rounded-lg p-8 text-center text-poly-muted">
            No notable anomalies detected in recent trades
          </div>
        )}

        <div className="space-y-4">
          {data?.suspiciousTraders.map((trader, i) => {
            const levelInfo = getLevelInfo(trader.level)
            return (
              <div key={trader.wallet} className="bg-poly-card border border-poly-border rounded-lg p-6 hover-card">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <span className={`${levelInfo.bg} text-white text-xs px-2 py-1 rounded font-bold`}>
                        {levelInfo.label}
                      </span>
                      <span className="text-poly-muted text-sm">
                        Score: <span className={levelInfo.color}>{trader.suspicionScore.toFixed(2)}</span>
                      </span>
                      {trader.zScore != null && (
                        <span className="text-poly-muted text-sm">
                          z: <span className={levelInfo.color}>{trader.zScore.toFixed(2)}</span>
                        </span>
                      )}
                    </div>

                    <h3 className="text-lg font-bold mb-1">{trader.name}</h3>
                    <p className="text-poly-muted text-sm font-mono">{trader.wallet.slice(0, 20)}...</p>
                    {trader.levelReason && (
                      <p className="text-poly-muted text-xs mt-1 italic">{trader.levelReason}</p>
                    )}

                    <div className="grid grid-cols-4 gap-4 mt-4">
                      <div>
                        <p className="text-poly-muted text-xs">Longshot Trades</p>
                        <p className="text-xl font-bold">{trader.longshotCount}</p>
                      </div>
                      <div>
                        <p className="text-poly-muted text-xs">Expected Wins</p>
                        <p className="text-xl font-bold">{trader.expectedWins.toFixed(2)}</p>
                      </div>
                      <div>
                        <p className="text-poly-muted text-xs">Actual Wins</p>
                        <p className="text-xl font-bold text-poly-green">{trader.actualWins}</p>
                      </div>
                      <div>
                        <p className="text-poly-muted text-xs">Historical W/L</p>
                        <p className="text-xl font-bold">{trader.longshotWins}/{trader.longshotLosses}</p>
                      </div>
                    </div>

                    {trader.topWins.length > 0 && (
                      <div className="mt-4">
                        <p className="text-poly-muted text-xs mb-2">Recent Longshot Trades:</p>
                        {trader.topWins.slice(0, 3).map((win, j) => (
                          <div key={j} className="text-sm mb-1">
                            <span className="text-poly-yellow">{win.outcome}</span>
                            <span className="text-poly-muted"> @ {(win.entryPrice * 100).toFixed(0)}%</span>
                            <span className="text-poly-muted ml-2">- {win.title.slice(0, 40)}...</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <a
                    href={`https://polymarket.com/profile/${trader.wallet}`}
                    target="_blank"
                    className="bg-poly-border hover:bg-poly-muted/30 px-4 py-2 rounded-lg text-sm"
                  >
                    View Profile
                  </a>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Recent Longshot Trades Feed */}
      <div>
        <h2 className="text-2xl font-bold mb-4">Recent Longshot Trades</h2>
        <p className="text-poly-muted mb-4">Trades at &lt;25% odds with &gt;$500 value</p>

        {data?.recentLongshots.length === 0 && !loading && (
          <div className="bg-poly-card border border-poly-border rounded-lg p-8 text-center text-poly-muted">
            No recent longshot trades found
          </div>
        )}

        <div className="space-y-2">
          {data?.recentLongshots.map((trade, i) => (
            <div key={i} className="bg-poly-card border border-poly-border rounded-lg p-4 hover-card">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="bg-poly-yellow/20 text-poly-yellow text-xs px-2 py-0.5 rounded">
                      {trade.oddsFormatted || `${(trade.price * 100).toFixed(1)}%`}
                    </span>
                    <span className="font-medium">{trade.title.slice(0, 50)}{trade.title.length > 50 ? '...' : ''}</span>
                  </div>
                  <div className="flex items-center gap-4 mt-1 text-sm text-poly-muted">
                    <span className="text-poly-green font-medium">{trade.outcome}</span>
                    <span>Bet: {trade.valueFormatted || formatMoney(trade.value)}</span>
                    <span>Potential: <span className="text-poly-green">{trade.potentialFormatted || formatMoney(trade.potential)}</span></span>
                    <span>+{(((1 - trade.price) / trade.price) * 100).toFixed(0)}%</span>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm">{trade.name}</p>
                  <p className="text-xs text-poly-muted">{formatTime(trade.timestamp)}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
