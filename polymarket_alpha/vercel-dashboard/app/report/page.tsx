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

interface SharpConvergence {
  marketId: string
  eventSlug: string
  title: string
  outcome: string
  avgPrice: number
  oddsFormatted: string
  totalValue: number
  totalValueFormatted: string
  sharpCount: number
  sharpWallets: Array<{
    wallet: string
    name: string
    historicalPnl: number
    historicalPnlFormatted: string
    size: number
    value: number
    valueFormatted: string
  }>
}

interface DormantSharp {
  wallet: string
  name: string
  historicalPnl: number
  historicalPnlFormatted: string
  longshotWinRate: number
  winRateFormatted: string
  longshotRecord: string
  totalPositions: number
  daysSinceLastTrade: number
  currentTrades: Array<{
    title: string
    outcome: string
    price: number
    oddsFormatted: string
    size: number
    value: number
    valueFormatted: string
  }>
  totalCurrentValue: number
  totalCurrentValueFormatted: string
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
    eventSlug: string
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
    positionStatus: 'holding' | 'sold' | 'unknown'
  }>
  sharpConvergences: SharpConvergence[]
  dormantSharps: DormantSharp[]
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
  { label: 'All (<25%)', min: 0, max: 0.25 },
  { label: '20-25%', min: 0.20, max: 0.25 },
  { label: '15-20%', min: 0.15, max: 0.20 },
  { label: '10-15%', min: 0.10, max: 0.15 },
  { label: '5-10%', min: 0.05, max: 0.10 },
  { label: '<5%', min: 0, max: 0.05 },
]

type SortField = 'odds' | 'value' | 'potential'
type SortDirection = 'asc' | 'desc'

export default function ReportPage() {
  const [report, setReport] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [oddsFilterIndex, setOddsFilterIndex] = useState(0) // Index into ODDS_FILTERS
  const [sortField, setSortField] = useState<SortField>('odds')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  const currentFilter = ODDS_FILTERS[oddsFilterIndex]

  const fetchReport = async (minOdds: number, maxOdds: number) => {
    try {
      setLoading(true)
      const url = `/api/daily-report?minOdds=${minOdds}&maxOdds=${maxOdds}`
      const res = await fetch(url)
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
    fetchReport(currentFilter.min, currentFilter.max)
    // Refresh every 10 minutes
    const interval = setInterval(() => fetchReport(currentFilter.min, currentFilter.max), 10 * 60 * 1000)
    return () => clearInterval(interval)
  }, [oddsFilterIndex])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection(field === 'odds' ? 'asc' : 'desc') // odds default asc, others desc
    }
  }

  const getSortedTrades = (trades: ReportData['topLongshots']) => {
    // Trades are already filtered by the API, just sort them
    return [...trades].sort((a, b) => {
      let aVal: number, bVal: number
      switch (sortField) {
        case 'odds':
          aVal = a.price
          bVal = b.price
          break
        case 'value':
          aVal = a.value
          bVal = b.value
          break
        case 'potential':
          aVal = a.potential
          bVal = b.potential
          break
      }
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal
    }).slice(0, 50)
  }

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <span className="ml-1 text-poly-muted/50">↕</span>
    return <span className="ml-1">{sortDirection === 'asc' ? '↑' : '↓'}</span>
  }

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
            onClick={() => fetchReport(currentFilter.min, currentFilter.max)}
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
              onClick={() => fetchReport(currentFilter.min, currentFilter.max)}
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

      {/* Sharp Convergence Alerts */}
      {report.sharpConvergences && report.sharpConvergences.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-xl font-bold flex items-center">
            <span className="w-3 h-3 bg-red-500 rounded-full mr-3 animate-pulse"></span>
            Sharp Convergence Alerts
            <span className="text-sm font-normal text-poly-muted ml-2">(3+ sharps on same bet)</span>
          </h2>
          <div className="space-y-3">
            {report.sharpConvergences.map((convergence, i) => (
              <div
                key={`${convergence.marketId}-${convergence.outcome}`}
                className="bg-red-900/20 border border-red-500/40 rounded-lg p-4"
              >
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <a
                      href={`https://polymarket.com/event/${convergence.eventSlug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-lg font-bold text-poly-blue hover:underline"
                    >
                      {convergence.title?.slice(0, 60) || convergence.eventSlug}
                    </a>
                    <p className="text-poly-muted text-sm mt-1">
                      Outcome: <span className="text-white">{convergence.outcome}</span>
                      <span className="mx-2">@</span>
                      <span className="text-poly-yellow">{convergence.oddsFormatted}</span>
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-red-400 font-bold text-lg">{convergence.sharpCount} Sharps</p>
                    <p className="text-poly-muted text-sm">Total: {convergence.totalValueFormatted}</p>
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-poly-muted text-xs font-medium">Sharp wallets betting on this:</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                    {convergence.sharpWallets.map((w) => (
                      <div key={w.wallet} className="bg-black/30 rounded p-2 text-sm">
                        <a
                          href={`https://polymarket.com/@${w.name}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-poly-blue hover:underline font-medium"
                        >
                          {w.name || w.wallet.slice(0, 10) + '...'}
                        </a>
                        <p className="text-poly-muted text-xs">
                          PnL: <span className="text-poly-green">{w.historicalPnlFormatted}</span>
                          <span className="mx-1">|</span>
                          Bet: <span className="text-white">{w.valueFormatted}</span>
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Dormant Sharp Alerts */}
      {report.dormantSharps && report.dormantSharps.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-xl font-bold flex items-center">
            <span className="w-3 h-3 bg-purple-500 rounded-full mr-3"></span>
            Dormant Sharp Alerts
            <span className="text-sm font-normal text-poly-muted ml-2">(inactive 7+ days, now trading)</span>
          </h2>
          <div className="space-y-3">
            {report.dormantSharps.map((sharp) => (
              <div
                key={sharp.wallet}
                className="bg-purple-900/20 border border-purple-500/40 rounded-lg p-4"
              >
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <a
                      href={`https://polymarket.com/@${sharp.name}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-lg font-bold text-poly-blue hover:underline"
                    >
                      {sharp.name || sharp.wallet.slice(0, 12) + '...'}
                    </a>
                    <p className="text-poly-muted font-mono text-xs mt-1">{sharp.wallet}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-purple-400 font-bold">{sharp.daysSinceLastTrade} days dormant</p>
                    <p className="text-poly-muted text-sm">Now betting: {sharp.totalCurrentValueFormatted}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                  <div>
                    <p className="text-poly-muted text-xs">Historical PnL</p>
                    <p className="font-bold text-poly-green">{sharp.historicalPnlFormatted}</p>
                  </div>
                  <div>
                    <p className="text-poly-muted text-xs">Longshot Win Rate</p>
                    <p className="font-bold">{sharp.winRateFormatted}</p>
                  </div>
                  <div>
                    <p className="text-poly-muted text-xs">Longshot Record</p>
                    <p className="font-bold">{sharp.longshotRecord}</p>
                  </div>
                  <div>
                    <p className="text-poly-muted text-xs">Total Positions</p>
                    <p className="font-bold">{sharp.totalPositions}</p>
                  </div>
                </div>
                {sharp.currentTrades.length > 0 && (
                  <div>
                    <p className="text-poly-muted text-xs mb-2">Current longshot trades:</p>
                    <div className="space-y-1">
                      {sharp.currentTrades.map((trade, j) => (
                        <p key={j} className="text-sm">
                          <span className="text-poly-muted">{trade.outcome}</span>
                          <span className="text-poly-muted mx-1">@</span>
                          <span className="text-poly-yellow">{trade.oddsFormatted}</span>
                          <span className="text-poly-muted mx-1">→</span>
                          <span className="text-poly-green">{trade.valueFormatted}</span>
                          <span className="text-poly-muted ml-2 text-xs">({trade.title.slice(0, 35)}...)</span>
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

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
            <span className="text-poly-muted text-sm">Odds Range:</span>
            <select
              value={oddsFilterIndex}
              onChange={(e) => setOddsFilterIndex(Number(e.target.value))}
              className="bg-poly-card border border-poly-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-poly-green"
            >
              {ODDS_FILTERS.map((f, i) => (
                <option key={i} value={i}>{f.label}</option>
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
                  <th className="text-center p-3 text-poly-muted font-medium" title="Current position status">Status</th>
                  <th
                    className="text-right p-3 text-poly-muted font-medium cursor-pointer hover:text-white select-none"
                    onClick={() => handleSort('odds')}
                  >
                    Odds<SortIcon field="odds" />
                  </th>
                  <th
                    className="text-right p-3 text-poly-muted font-medium cursor-pointer hover:text-white select-none"
                    onClick={() => handleSort('value')}
                  >
                    Value<SortIcon field="value" />
                  </th>
                  <th
                    className="text-right p-3 text-poly-muted font-medium cursor-pointer hover:text-white select-none"
                    onClick={() => handleSort('potential')}
                  >
                    Potential<SortIcon field="potential" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const filteredTrades = getSortedTrades(report.topLongshots)
                  if (filteredTrades.length === 0) {
                    return (
                      <tr>
                        <td className="p-4 text-center text-poly-muted" colSpan={7}>
                          No trades found in {currentFilter.label} odds range.
                        </td>
                      </tr>
                    )
                  }
                  return filteredTrades.map((trade, i) => (
                    <tr key={i} className="border-t border-poly-border hover:bg-poly-border/30">
                      <td className="p-3 max-w-xs truncate">
                        <a
                          href={`https://polymarket.com/event/${trade.eventSlug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-poly-blue hover:underline"
                        >
                          {trade.title?.slice(0, 40) || trade.eventSlug}
                        </a>
                      </td>
                      <td className="p-3 text-sm">
                        <a
                          href={`https://polymarket.com/@${trade.name}`}
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
                      <td className="p-3 text-center text-xs">
                        {trade.positionStatus === 'holding' && (
                          <span className="text-poly-green" title="Still holding this position">Holding</span>
                        )}
                        {trade.positionStatus === 'sold' && (
                          <span className="text-poly-red" title="Position has been sold">Sold</span>
                        )}
                        {trade.positionStatus === 'unknown' && (
                          <span className="text-poly-muted">—</span>
                        )}
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
            Showing {report.topLongshots.length} trades in {currentFilter.label} odds range
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
