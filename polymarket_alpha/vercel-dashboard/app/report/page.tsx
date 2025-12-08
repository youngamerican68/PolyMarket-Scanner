'use client'

import { useState, useEffect } from 'react'

interface TopTrade {
  title: string
  outcome: string
  price: number
  oddsFormatted: string
  size: number
  value: number
  valueFormatted: string
}

interface AnomalousWallet {
  wallet: string
  name: string
  anomalyScore: number
  level: 'low' | 'medium' | 'high' | 'watch'
  levelReason: string
  longshotCount: number
  expectedWins: number
  actualWins: number
  zScore: number | null
  totalStake: number
  totalValue: number
  totalValueFormatted: string
  totalStakeFormatted: string
  // Historical context
  historicalPnl?: number
  historicalPnlFormatted?: string
  historicalLongshotWins?: number
  historicalLongshotLosses?: number
  historicalLongshotPnl?: number
  historicalLongshotPnlFormatted?: string
  totalPositions?: number
  topTrades: TopTrade[]
}

interface ReportData {
  window: {
    from: string
    to: string
  }
  summary: {
    totalTrades: number
    totalWallets: number
    totalVolume: number
    totalPotential: number
    totalVolumeFormatted: string
    totalPotentialFormatted: string
  }
  anomalousWallets: AnomalousWallet[]
  topLongshots: Array<{
    id: string
    wallet: string
    name: string
    marketId: string
    title: string
    outcome: string
    price: number
    size: number
    value: number
    potential: number
    oddsFormatted: string
    valueFormatted: string
    potentialFormatted: string
    longshotRecord: string | null
  }>
}

function formatMoney(value: number): string {
  if (Math.abs(value) >= 1000000) {
    return `$${(value / 1000000).toFixed(2)}M`
  } else if (Math.abs(value) >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`
  }
  return `$${value.toFixed(0)}`
}

function getLevelColor(level: string): string {
  if (level === 'high') return 'text-red-400'
  if (level === 'medium') return 'text-amber-400'
  if (level === 'watch') return 'text-slate-400'
  return 'text-slate-500'
}

function getLevelBg(level: string): string {
  if (level === 'high') return 'bg-red-900/20 border-red-500/40'
  if (level === 'medium') return 'bg-amber-900/20 border-amber-500/30'
  if (level === 'watch') return 'bg-slate-800/50 border-slate-600/30'
  return 'bg-slate-800/30 border-slate-700/30'
}

function getLevelLabel(level: string): string {
  if (level === 'high') return 'High settlement anomaly'
  if (level === 'medium') return 'Moderate settlement'
  if (level === 'watch') return 'Watch (negative PnL)'
  return 'Mild settlement'
}

const ODDS_FILTERS = [
  { label: 'All (<25%)', value: 0.25 },
  { label: '<20%', value: 0.20 },
  { label: '<15%', value: 0.15 },
  { label: '<10%', value: 0.10 },
  { label: '<5%', value: 0.05 },
]

export default function ReportPage() {
  const [report, setReport] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [oddsFilter, setOddsFilter] = useState(0.25)

  const fetchReport = async () => {
    try {
      setLoading(true)
      const res = await fetch('/api/daily-report')
      if (!res.ok) throw new Error('Failed to fetch report')
      const data = await res.json()
      setReport(data)
      setLastUpdate(new Date())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchReport()
    // Refresh every 10 minutes
    const interval = setInterval(fetchReport, 10 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  if (loading && !report) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Daily Settlement Anomaly Report</h1>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-poly-green"></div>
          <span className="ml-4 text-poly-muted">Generating report from live data...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Daily Settlement Anomaly Report</h1>
        <div className="bg-red-900/30 border border-red-500 rounded-lg p-4">
          <p className="text-red-400">Error: {error}</p>
          <button
            onClick={fetchReport}
            className="mt-4 px-4 py-2 bg-red-600 hover:bg-red-700 rounded"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!report) return null

  const s = report.summary

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="space-y-2">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold">Daily Settlement Anomaly Report</h1>
            <p className="text-poly-muted text-sm">
              Based on positions that settled in the last 24h (not when bets were placed)
            </p>
            <p className="text-poly-muted text-xs">
              Window: {new Date(report.window.from).toLocaleString()} → {new Date(report.window.to).toLocaleString()}
            </p>
          </div>
          <div className="text-right">
            <button
              onClick={fetchReport}
              disabled={loading}
              className="px-4 py-2 bg-poly-green text-black font-medium rounded hover:bg-poly-green/80 disabled:opacity-50"
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
            {lastUpdate && (
              <p className="text-xs text-poly-muted mt-2">
                Last refresh: {lastUpdate.toLocaleTimeString()}
              </p>
            )}
          </div>
        </div>
        <div className="text-xs text-poly-muted bg-poly-card border border-poly-border rounded p-2 space-y-1">
          <p>
            <strong>Important:</strong> This report uses settlement-time windows. A cluster of wins can appear
            anomalous even for wallets that are long-term losers. Always check historical PnL before interpreting.
          </p>
          <p>
            Statistical outliers are not evidence of insider trading or other misconduct.
          </p>
        </div>
      </header>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
          <p className="text-poly-muted text-sm">Total Trades</p>
          <p className="text-2xl font-bold">{s.totalTrades.toLocaleString()}</p>
        </div>
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
          <p className="text-poly-muted text-sm">Unique Wallets</p>
          <p className="text-2xl font-bold">{s.totalWallets}</p>
        </div>
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
          <p className="text-poly-muted text-sm">Longshot Volume</p>
          <p className="text-2xl font-bold text-poly-green">{s.totalVolumeFormatted}</p>
        </div>
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
          <p className="text-poly-muted text-sm">Potential Payout</p>
          <p className="text-2xl font-bold text-poly-blue">{s.totalPotentialFormatted}</p>
        </div>
      </div>

      {/* Anomalous Wallets */}
      <section className="space-y-4">
        <h2 className="text-xl font-bold flex items-center">
          <span className="w-3 h-3 bg-poly-yellow rounded-full mr-3"></span>
          Settlement Anomalies
          <span className="text-sm font-normal text-poly-muted ml-2">(Statistical Outliers - check PnL)</span>
        </h2>

        {report.anomalousWallets.length === 0 ? (
          <div className="bg-poly-card rounded-lg p-6 border border-poly-border text-center">
            <p className="text-poly-muted">No statistically notable wallets in this window.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {report.anomalousWallets.map((wallet, i) => (
              <div
                key={wallet.wallet}
                className={`rounded-lg p-5 border ${getLevelBg(wallet.level)}`}
              >
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <div className="flex items-center gap-3">
                      <span className="text-lg font-bold text-poly-muted">#{i + 1}</span>
                      <h3 className="text-xl font-bold">{wallet.name || 'Anonymous'}</h3>
                      <span className={`text-sm font-bold px-2 py-1 rounded ${getLevelColor(wallet.level)} bg-black/30`}>
                        {getLevelLabel(wallet.level)}
                      </span>
                    </div>
                    <p className="text-poly-muted font-mono text-sm mt-1">{wallet.wallet}</p>
                    {wallet.levelReason && (
                      <p className="text-poly-muted text-xs mt-1 italic">{wallet.levelReason}</p>
                    )}
                  </div>
                  <a
                    href={`https://polymarket.com/profile/${wallet.wallet}`}
                    target="_blank"
                    className="text-poly-blue hover:underline text-sm"
                  >
                    View Profile →
                  </a>
                </div>

                {/* 24h Window Stats */}
                <div className="mb-4">
                  <p className="text-poly-muted text-xs mb-2 font-medium">24h Window Stats:</p>
                  <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
                    <div>
                      <p className="text-poly-muted text-xs">Anomaly Score</p>
                      <p className={`font-bold text-lg ${getLevelColor(wallet.level)}`}>
                        {wallet.anomalyScore.toFixed(2)}
                      </p>
                    </div>
                    <div>
                      <p className="text-poly-muted text-xs">Longshot Trades</p>
                      <p className="font-bold">{wallet.longshotCount}</p>
                    </div>
                    <div>
                      <p className="text-poly-muted text-xs">Expected Wins</p>
                      <p className="font-bold">{wallet.expectedWins.toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-poly-muted text-xs">Actual Wins</p>
                      <p className="font-bold text-poly-green">{wallet.actualWins}</p>
                    </div>
                    <div>
                      <p className="text-poly-muted text-xs">z-Score</p>
                      <p className="font-bold">
                        {wallet.zScore != null ? wallet.zScore.toFixed(2) : '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-poly-muted text-xs">24h Volume</p>
                      <p className="font-bold text-poly-green">{wallet.totalValueFormatted}</p>
                    </div>
                  </div>
                </div>

                {/* Historical Context */}
                {wallet.historicalPnl != null && (
                  <div className="mb-4 bg-black/20 rounded p-3">
                    <p className="text-poly-muted text-xs mb-2 font-medium">Historical Context (All Time):</p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div>
                        <p className="text-poly-muted text-xs">Total PnL</p>
                        <p className={`font-bold ${wallet.historicalPnl >= 0 ? 'text-poly-green' : 'text-red-400'}`}>
                          {wallet.historicalPnlFormatted}
                        </p>
                      </div>
                      <div>
                        <p className="text-poly-muted text-xs">Lifetime Longshots</p>
                        <p className="font-bold">
                          {(wallet.historicalLongshotWins ?? 0) + (wallet.historicalLongshotLosses ?? 0)} trades
                        </p>
                      </div>
                      <div>
                        <p className="text-poly-muted text-xs">Longshot Record</p>
                        <p className="font-bold">
                          {wallet.historicalLongshotWins ?? 0}W / {wallet.historicalLongshotLosses ?? 0}L
                        </p>
                      </div>
                      <div>
                        <p className="text-poly-muted text-xs">Total Positions</p>
                        <p className="font-bold">{wallet.totalPositions ?? '—'}</p>
                      </div>
                    </div>
                  </div>
                )}

                {wallet.topTrades.length > 0 && (
                  <div>
                    <p className="text-poly-muted text-xs mb-2">Top Trades:</p>
                    <div className="space-y-1">
                      {wallet.topTrades.slice(0, 3).map((trade, j) => (
                        <p key={j} className="text-sm">
                          <span className="text-poly-muted">{trade.outcome}</span>
                          <span className="text-poly-muted mx-1">@</span>
                          <span className="text-poly-yellow">{trade.oddsFormatted}</span>
                          <span className="text-poly-muted mx-1">→</span>
                          <span className="text-poly-green">{trade.valueFormatted}</span>
                          <span className="text-poly-muted ml-2 text-xs">({trade.title.slice(0, 40)}...)</span>
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Top Longshot Trades Table */}
      <section className="space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-bold">Top Longshot Trades</h2>
          <div className="flex items-center gap-2">
            <span className="text-poly-muted text-sm">Max Odds:</span>
            <select
              value={oddsFilter}
              onChange={(e) => setOddsFilter(Number(e.target.value))}
              className="bg-poly-card border border-poly-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-poly-green"
            >
              {ODDS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="bg-poly-card rounded-lg border border-poly-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-poly-border">
                <tr>
                  <th className="text-left p-3 text-poly-muted font-medium">Market</th>
                  <th className="text-left p-3 text-poly-muted font-medium">Trader</th>
                  <th className="text-center p-3 text-poly-muted font-medium" title="Wins/Losses held to settlement (positions sold early)">Settled Record</th>
                  <th className="text-right p-3 text-poly-muted font-medium">Odds</th>
                  <th className="text-right p-3 text-poly-muted font-medium">Value</th>
                  <th className="text-right p-3 text-poly-muted font-medium">Potential</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const filteredTrades = report.topLongshots.filter(t => t.price <= oddsFilter).slice(0, 50)
                  if (filteredTrades.length === 0) {
                    return (
                      <tr>
                        <td className="p-4 text-center text-poly-muted" colSpan={6}>
                          No trades found at {(oddsFilter * 100).toFixed(0)}% odds or below.
                        </td>
                      </tr>
                    )
                  }
                  return filteredTrades.map((trade, i) => (
                    <tr key={i} className="border-t border-poly-border hover:bg-poly-border/30">
                      <td className="p-3 max-w-xs truncate">{trade.title?.slice(0, 40) || trade.marketId}</td>
                      <td className="p-3 text-sm">
                        <a
                          href={`https://polymarket.com/profile/${trade.wallet}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-poly-blue hover:underline"
                        >
                          {trade.name || trade.wallet.slice(0, 10) + '...'}
                        </a>
                      </td>
                      <td className="p-3 text-center text-poly-muted text-xs">
                        {trade.longshotRecord || '—'}
                      </td>
                      <td className="p-3 text-right text-poly-yellow">{trade.oddsFormatted}</td>
                      <td className="p-3 text-right text-poly-green">{trade.valueFormatted}</td>
                      <td className="p-3 text-right text-poly-blue">{trade.potentialFormatted}</td>
                    </tr>
                  ))
                })()}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2 border-t border-poly-border text-xs text-poly-muted">
            Showing {report.topLongshots.filter(t => t.price <= oddsFilter).slice(0, 50).length} trades at {(oddsFilter * 100).toFixed(0)}% odds or below
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="text-center text-poly-muted text-sm py-4 border-t border-poly-border">
        <p>Auto-generated by Polymarket Anomaly Tracker</p>
        <p className="mt-1">Data refreshes every 10 minutes</p>
      </footer>
    </div>
  )
}
