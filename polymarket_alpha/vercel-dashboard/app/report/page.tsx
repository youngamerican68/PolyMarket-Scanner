'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'

// Types matching the API response
interface AlertRow {
  id: string
  fillTimestamp: string
  wallet: string
  traderName: string | null
  traderPseudonym: string | null
  title: string | null
  outcome: string
  eventSlug: string | null
  conditionId: string
  // Fill data (null-safe)
  fillPrice: number | null
  fillPriceFormatted: string
  fillValueUsd: number | null
  fillValueFormatted: string
  // Position snapshot
  positionSize: number | null
  positionSizeFormatted: string
  positionAvgPrice: number | null
  positionAvgPriceFormatted: string
  positionCurrentValue: number | null
  positionCurrentValueFormatted: string
  positionInitialValue: number | null
  positionInitialValueFormatted: string
  positionCashPnl: number | null
  positionCashPnlFormatted: string
  // Whale metadata
  isWhale: boolean
  whaleLabel: string | null
  whaleTier: string | null
  whaleCategory: string | null
}

interface ConvergenceWallet {
  wallet: string
  traderName: string | null
  whaleLabel: string | null
  positionCurrentValue: number | null
  fillPrice: number | null
  fillTimestamp: string
}

interface ConvergenceGroup {
  conditionId: string
  outcome: string
  title: string | null
  eventSlug: string | null
  walletCount: number
  totalPositionValue: number | null
  avgFillPrice: number | null
  wallets: ConvergenceWallet[]
}

interface ReportMeta {
  totalAlerts: number
  totalFiltered: number
  uniqueWallets: number
  whaleAlerts: number
  windowHours: number
  cutoffTime: string
  filtersApplied: {
    whalesOnly: boolean
    category: string | null
  }
}

interface ReportData {
  serverNow: string
  meta: ReportMeta
  alertsPage: AlertRow[]
  convergence: {
    totalGroups: number
    groups: ConvergenceGroup[]
  }
}

type WindowHours = 6 | 24 | 72

function formatTimeAgo(timestamp: string): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))

  if (diffMins < 60) {
    return `${diffMins}m ago`
  } else if (diffHours < 24) {
    const mins = diffMins % 60
    return mins > 0 ? `${diffHours}h ${mins}m ago` : `${diffHours}h ago`
  } else {
    const days = Math.floor(diffHours / 24)
    const hours = diffHours % 24
    return hours > 0 ? `${days}d ${hours}h ago` : `${days}d ago`
  }
}

function formatMoney(value: number | null): string {
  if (value === null || value === undefined) return 'N/A'
  if (Math.abs(value) >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`
  }
  return `$${value.toFixed(0)}`
}

function formatOdds(price: number | null): string {
  if (price === null || price === undefined) return 'N/A'
  return `${(price * 100).toFixed(1)}%`
}

type SortField = 'fillPrice' | 'fillValue' | 'positionValue' | 'time'
type SortDirection = 'asc' | 'desc'

export default function ReportPage() {
  const [report, setReport] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)

  // Filters
  const [windowHours, setWindowHours] = useState<WindowHours>(24)
  const [whalesOnly, setWhalesOnly] = useState(false)
  const [category, setCategory] = useState<string>('')

  // Sorting
  const [sortField, setSortField] = useState<SortField>('time')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  // Convergence expanded state
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  const fetchReport = useCallback(async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams({
        hours: windowHours.toString(),
        limit: '100',
        _t: Date.now().toString(),
      })
      if (whalesOnly) params.set('whalesOnly', 'true')
      if (category.trim()) params.set('category', category.trim())

      const res = await fetch(`/api/report?${params}`, {
        cache: 'no-store',
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.error || `HTTP ${res.status}`)
      }
      const data: ReportData = await res.json()
      setReport(data)
      setLastUpdate(new Date())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [windowHours, whalesOnly, category])

  useEffect(() => {
    fetchReport()
    const interval = setInterval(fetchReport, 10 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchReport])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection(field === 'fillPrice' ? 'asc' : 'desc')
    }
  }

  const getSortedAlerts = (alerts: AlertRow[]): AlertRow[] => {
    return [...alerts].sort((a, b) => {
      let aVal: number, bVal: number
      switch (sortField) {
        case 'fillPrice':
          aVal = a.fillPrice ?? 0
          bVal = b.fillPrice ?? 0
          break
        case 'fillValue':
          aVal = a.fillValueUsd ?? 0
          bVal = b.fillValueUsd ?? 0
          break
        case 'positionValue':
          aVal = a.positionCurrentValue ?? 0
          bVal = b.positionCurrentValue ?? 0
          break
        case 'time':
          aVal = new Date(a.fillTimestamp).getTime()
          bVal = new Date(b.fillTimestamp).getTime()
          break
      }
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal
    })
  }

  const toggleGroupExpanded = (groupKey: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupKey)) {
        next.delete(groupKey)
      } else {
        next.add(groupKey)
      }
      return next
    })
  }

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <span className="ml-1 text-poly-muted/50">↕</span>
    return <span className="ml-1">{sortDirection === 'asc' ? '↑' : '↓'}</span>
  }

  if (loading && !report) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Phase 2 Report</h1>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-poly-green"></div>
          <span className="ml-4 text-poly-muted">Loading alerts from database...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Phase 2 Report</h1>
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

  const { meta, alertsPage, convergence } = report
  const sortedAlerts = getSortedAlerts(alertsPage)
  const whaleAlerts = sortedAlerts.filter(a => a.isWhale)
  const regularAlerts = sortedAlerts.filter(a => !a.isWhale)

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="space-y-4">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold">Phase 2 Report</h1>
            <p className="text-poly-muted text-sm">
              Longshot bets (&lt;25% odds) with $2.5K+ position value
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/history"
              className="px-4 py-2 bg-poly-card border border-poly-border text-white font-medium rounded hover:bg-poly-border transition-colors"
            >
              History
            </Link>
            <Link
              href="/whales"
              className="px-4 py-2 bg-purple-600 text-white font-medium rounded hover:bg-purple-500 transition-colors flex items-center gap-1"
            >
              <span>🐋</span> Whales
            </Link>
            <button
              onClick={fetchReport}
              disabled={loading}
              className="px-4 py-2 bg-poly-green text-black font-medium rounded hover:bg-poly-green/80 disabled:opacity-50"
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-4 bg-poly-card rounded-lg p-4 border border-poly-border">
          <div className="flex items-center gap-2">
            <label className="text-poly-muted text-sm">Window:</label>
            <select
              value={windowHours}
              onChange={(e) => setWindowHours(Number(e.target.value) as WindowHours)}
              className="bg-poly-border border border-poly-border rounded px-3 py-1.5 text-sm"
            >
              <option value={6}>Last 6h</option>
              <option value={24}>Last 24h</option>
              <option value={72}>Last 72h</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-poly-muted text-sm">
              <input
                type="checkbox"
                checked={whalesOnly}
                onChange={(e) => setWhalesOnly(e.target.checked)}
                className="mr-2"
              />
              Whales Only
            </label>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-poly-muted text-sm">Category:</label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g., Crypto"
              className="bg-poly-border border border-poly-border rounded px-3 py-1.5 text-sm w-32"
            />
          </div>

          <div className="text-xs text-poly-muted ml-auto">
            {meta.filtersApplied.whalesOnly && <span className="mr-2">🐋 whales only</span>}
            {meta.filtersApplied.category && <span className="mr-2">📁 {meta.filtersApplied.category}</span>}
          </div>
        </div>

        {lastUpdate && (
          <p className="text-xs text-poly-muted">
            Last refresh: {lastUpdate.toLocaleTimeString()} • Data since: {new Date(meta.cutoffTime).toLocaleString()}
          </p>
        )}
      </header>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
          <p className="text-poly-muted text-sm">Total Alerts</p>
          <p className="text-2xl font-bold">{meta.totalAlerts.toLocaleString()}</p>
        </div>
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
          <p className="text-poly-muted text-sm">Filtered</p>
          <p className="text-2xl font-bold">{meta.totalFiltered.toLocaleString()}</p>
        </div>
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
          <p className="text-poly-muted text-sm">Whale Alerts</p>
          <p className="text-2xl font-bold text-purple-400">{meta.whaleAlerts}</p>
        </div>
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
          <p className="text-poly-muted text-sm">Unique Wallets</p>
          <p className="text-2xl font-bold">{meta.uniqueWallets}</p>
        </div>
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border border-amber-500/50">
          <p className="text-poly-muted text-sm">Convergence Groups</p>
          <p className="text-2xl font-bold text-amber-400">{convergence.totalGroups}</p>
        </div>
      </div>

      {/* Convergence Section */}
      {convergence.groups.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-xl font-bold flex items-center">
            <span className="w-3 h-3 bg-amber-500 rounded-full mr-3"></span>
            Convergence
            <span className="text-sm font-normal text-poly-muted ml-2">
              ({convergence.totalGroups} market{convergence.totalGroups !== 1 ? 's' : ''} with multiple wallets on same outcome)
            </span>
          </h2>
          <p className="text-xs text-poly-muted">
            {windowHours === 6
              ? 'Qualification: 2+ distinct wallets'
              : 'Qualification: 3+ distinct wallets OR $10K+ combined position value'}
          </p>

          <div className="space-y-3">
            {convergence.groups.map((group) => {
              const groupKey = `${group.conditionId}-${group.outcome}`
              const isExpanded = expandedGroups.has(groupKey)

              return (
                <div
                  key={groupKey}
                  className="bg-poly-card rounded-lg border border-amber-500/30 overflow-hidden"
                >
                  <button
                    onClick={() => toggleGroupExpanded(groupKey)}
                    className="w-full p-4 flex items-center justify-between hover:bg-poly-border/30 transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <div className="text-left">
                        <a
                          href={`https://polymarket.com/event/${group.eventSlug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-poly-blue hover:underline font-medium"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {group.title || 'Unknown Market'}
                        </a>
                        <span className="text-amber-400 ml-2 font-medium">→ {group.outcome}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-6 text-sm">
                      <div className="text-right">
                        <span className="text-poly-muted">Wallets: </span>
                        <span className="font-bold text-amber-400">{group.walletCount}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-poly-muted">Total Value: </span>
                        <span className="font-bold text-poly-green">{formatMoney(group.totalPositionValue)}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-poly-muted">Avg Price: </span>
                        <span className="font-bold text-poly-yellow">{formatOdds(group.avgFillPrice)}</span>
                      </div>
                      <span className="text-poly-muted">{isExpanded ? '▼' : '▶'}</span>
                    </div>
                  </button>

                  {isExpanded && group.wallets.length > 0 && (
                    <div className="border-t border-poly-border">
                      <table className="w-full text-sm">
                        <thead className="bg-poly-border/50">
                          <tr>
                            <th className="text-left p-3 text-poly-muted font-medium">Wallet</th>
                            <th className="text-right p-3 text-poly-muted font-medium">Position Value</th>
                            <th className="text-right p-3 text-poly-muted font-medium">Fill Price</th>
                            <th className="text-right p-3 text-poly-muted font-medium">Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.wallets.map((w, idx) => (
                            <tr key={idx} className="border-t border-poly-border/50">
                              <td className="p-3">
                                <a
                                  href={`https://polymarket.com/profile/${w.wallet}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-poly-blue hover:underline"
                                >
                                  {w.whaleLabel || w.traderName || `${w.wallet.slice(0, 8)}...`}
                                </a>
                                {w.whaleLabel && <span className="ml-1 text-purple-400">🐋</span>}
                              </td>
                              <td className="p-3 text-right text-poly-green">{formatMoney(w.positionCurrentValue)}</td>
                              <td className="p-3 text-right text-poly-yellow">{formatOdds(w.fillPrice)}</td>
                              <td className="p-3 text-right text-poly-muted text-xs">{formatTimeAgo(w.fillTimestamp)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Whale Trades Section */}
      {whaleAlerts.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-xl font-bold flex items-center">
            <span className="w-3 h-3 bg-purple-500 rounded-full mr-3"></span>
            Whale Trades
            <span className="text-sm font-normal text-poly-muted ml-2">({whaleAlerts.length})</span>
          </h2>
          <div className="bg-poly-card rounded-lg border border-poly-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-poly-border">
                  <tr>
                    <th className="text-left p-3 text-poly-muted font-medium">Whale</th>
                    <th className="text-left p-3 text-poly-muted font-medium">Market</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Fill Price</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Position Value</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Pos Avg Entry</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {whaleAlerts.slice(0, 20).map((alert) => (
                    <tr key={alert.id} className="border-t border-poly-border hover:bg-poly-border/30">
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span className="text-purple-400">🐋</span>
                          <a
                            href={`https://polymarket.com/profile/${alert.wallet}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-poly-blue hover:underline"
                          >
                            {alert.whaleLabel || alert.traderName || alert.traderPseudonym || 'Anonymous'}
                          </a>
                          {alert.whaleTier && (
                            <span className="text-xs text-poly-muted">({alert.whaleTier})</span>
                          )}
                        </div>
                      </td>
                      <td className="p-3 max-w-xs truncate">
                        <a
                          href={`https://polymarket.com/event/${alert.eventSlug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-poly-blue hover:underline"
                        >
                          {(alert.title || 'Unknown Market').slice(0, 40)}
                        </a>
                        <span className="text-poly-muted ml-2">({alert.outcome})</span>
                      </td>
                      <td className="p-3 text-right text-poly-yellow">{alert.fillPriceFormatted}</td>
                      <td className="p-3 text-right text-white font-medium">{alert.positionCurrentValueFormatted}</td>
                      <td className="p-3 text-right text-poly-muted">{alert.positionAvgPriceFormatted}</td>
                      <td className="p-3 text-right text-poly-muted text-xs">{formatTimeAgo(alert.fillTimestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* All Trades Table */}
      <section className="space-y-4">
        <h2 className="text-xl font-bold">
          {whalesOnly ? 'All Whale Trades' : 'All Longshot Trades'}
        </h2>
        <div className="bg-poly-card rounded-lg border border-poly-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-poly-border">
                <tr>
                  <th className="text-left p-3 text-poly-muted font-medium">Market</th>
                  <th className="text-left p-3 text-poly-muted font-medium">Trader</th>
                  <th
                    className="text-right p-3 text-poly-muted font-medium cursor-pointer hover:text-white select-none"
                    onClick={() => handleSort('fillPrice')}
                    title="Price at which this trade filled"
                  >
                    Fill Price<SortIcon field="fillPrice" />
                  </th>
                  <th
                    className="text-right p-3 text-poly-muted font-medium cursor-pointer hover:text-white select-none"
                    onClick={() => handleSort('fillValue')}
                    title="USD value of this trade fill"
                  >
                    Fill Value<SortIcon field="fillValue" />
                  </th>
                  <th
                    className="text-right p-3 text-poly-muted font-medium cursor-pointer hover:text-white select-none"
                    onClick={() => handleSort('positionValue')}
                    title="Position value at ingestion time (snapshot)"
                  >
                    Position Value<SortIcon field="positionValue" />
                  </th>
                  <th className="text-right p-3 text-poly-muted font-medium" title="Average entry price of position">
                    Pos Avg Entry
                  </th>
                  <th
                    className="text-right p-3 text-poly-muted font-medium cursor-pointer hover:text-white select-none"
                    onClick={() => handleSort('time')}
                  >
                    Time<SortIcon field="time" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const displayAlerts = whalesOnly ? sortedAlerts : regularAlerts.length > 0 ? regularAlerts : sortedAlerts
                  if (displayAlerts.length === 0) {
                    return (
                      <tr>
                        <td className="p-4 text-center text-poly-muted" colSpan={7}>
                          No alerts found matching filters.
                        </td>
                      </tr>
                    )
                  }
                  return displayAlerts.slice(0, 50).map((alert) => (
                    <tr key={alert.id} className="border-t border-poly-border hover:bg-poly-border/30">
                      <td className="p-3 max-w-xs truncate">
                        <a
                          href={`https://polymarket.com/event/${alert.eventSlug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-poly-blue hover:underline"
                        >
                          {(alert.title || 'Unknown Market').slice(0, 40)}
                        </a>
                        <span className="text-poly-muted ml-2">({alert.outcome})</span>
                      </td>
                      <td className="p-3">
                        <a
                          href={`https://polymarket.com/profile/${alert.wallet}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-poly-blue hover:underline"
                        >
                          {alert.traderName || alert.traderPseudonym || 'Anonymous'}
                        </a>
                        {alert.isWhale && <span className="ml-1 text-purple-400">🐋</span>}
                      </td>
                      <td className="p-3 text-right text-poly-yellow">{alert.fillPriceFormatted}</td>
                      <td className="p-3 text-right text-poly-green">{alert.fillValueFormatted}</td>
                      <td className="p-3 text-right text-white font-medium">{alert.positionCurrentValueFormatted}</td>
                      <td className="p-3 text-right text-poly-muted">{alert.positionAvgPriceFormatted}</td>
                      <td className="p-3 text-right text-poly-muted text-xs whitespace-nowrap">
                        {formatTimeAgo(alert.fillTimestamp)}
                      </td>
                    </tr>
                  ))
                })()}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2 border-t border-poly-border text-xs text-poly-muted">
            Showing {Math.min(sortedAlerts.length, 50)} of {meta.totalFiltered} filtered alerts
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="text-center text-poly-muted text-sm py-4 border-t border-poly-border">
        <p>Phase 2: Convergence detection + DB-only rendering</p>
        <p className="mt-1">Position values are snapshots from ingestion time • All data from alert_events</p>
      </footer>
    </div>
  )
}
