'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'

// Price status type
type PriceStatus = 'fresh' | 'stale' | 'missing'

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
  positionAvgPrice: number | null
  positionAvgPriceFormatted: string
  positionCurrentValue: number | null
  positionCurrentValueFormatted: string
  // Potential win (profit if position wins)
  potentialWin: number | null
  potentialWinFormatted: string
  // Whale metadata
  isWhale: boolean
  whaleLabel: string | null
  whaleTier: string | null
  whaleCategory: string | null
  // Cached price fields (Phase 3)
  currentPrice: number | null
  currentPriceFormatted: string
  priceStatus: PriceStatus
  priceFetchedAt: string | null
  // Phase 6: Market resolution fields
  marketResolved: boolean
  marketClosed: boolean
  winningOutcome: string | null
}

interface ConvergenceWallet {
  wallet: string
  traderName: string
  whaleLabel: string | null
  positionValue: number | null
  positionValueFormatted: string
  fillPrice: number | null
  fillPriceFormatted: string
  positionAvgPrice: number | null
  positionAvgPriceFormatted: string
  potentialWin: number | null
  potentialWinFormatted: string
  latestTimestamp: string
  isWhale: boolean
}

interface ConvergenceGroup {
  conditionId: string
  outcome: string
  title: string
  slug: string | null
  eventSlug: string | null
  distinctWallets: number
  totalPositionValue: number
  totalPositionValueFormatted: string
  minOdds: number | null
  maxOdds: number | null
  oddsRangeFormatted: string
  qualifies: boolean
  wallets: ConvergenceWallet[]
}

interface ReportMeta {
  alertWindowHours: number
  convergenceWindowHours: number
  whalesOnly: boolean
  category: string | null
  minPosition: number
  maxOdds: number
  totalAlerts: number
  whaleAlerts: number
  uniqueWallets: number
  page: number
  pageSize: number
  totalPages: number
}

// Phase 5 (Hardened): Conviction Anomaly types
interface ConvictionAnomaly {
  id: string
  created_at: string
  wallet: string
  trader_name: string | null
  fill_timestamp: string
  trade_notional: number
  baseline_median: number
  baseline_mad: number
  baseline_trade_count: number
  ratio_to_median: number
  robust_z: number | null
  severity: number
  last_seen_at: string | null
  condition_id: string
  outcome: string
  title: string | null
  slug: string | null
  side: string
  fill_price: number
  is_whale: boolean
}

interface ConvictionAnomalyResponse {
  anomalies: ConvictionAnomaly[]
  meta: {
    count: number
    window: string
    windowHours: number
    cutoff: string
    limit: number
    sortBy: string
    stats: {
      total: number
      whaleCount: number
      avgRatio: number
      maxRatio: number
      avgSeverity: number
      maxSeverity: number
    }
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
  largeSingleBets: {
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

type SortField = 'fillPrice' | 'fillValue' | 'positionValue' | 'time' | 'currentPrice'
type SortDirection = 'asc' | 'desc'

// Price status indicator component with age display
function PriceStatusBadge({ status, fetchedAt }: { status: PriceStatus; fetchedAt?: string | null }) {
  if (status === 'fresh') return null
  if (status === 'stale' && fetchedAt) {
    const ageMinutes = Math.max(0, Math.floor((Date.now() - new Date(fetchedAt).getTime()) / 60000))
    const ageDisplay = ageMinutes > 1440 ? '>24h' : `${ageMinutes}m`
    return (
      <span
        className="ml-1 text-xs text-yellow-500"
        title={`Last updated ${ageMinutes} min ago`}
        suppressHydrationWarning
      >
        ⚠ {ageDisplay} ago
      </span>
    )
  }
  if (status === 'stale') {
    return <span className="ml-1 text-xs text-yellow-500">⚠ stale</span>
  }
  return null
}

// Price display component with status handling
// Suppresses stale warning for resolved markets (stale price is irrelevant once settled)
function PriceDisplay({ alert }: { alert: AlertRow }) {
  if (alert.priceStatus === 'missing' || alert.currentPrice === null) {
    return <span className="text-poly-muted text-xs italic">No price yet</span>
  }
  // Don't show stale warning for resolved markets - price staleness is irrelevant
  const showStaleWarning = alert.priceStatus === 'stale' && !alert.marketResolved
  return (
    <>
      <span className={showStaleWarning ? 'text-yellow-400' : 'text-cyan-400'}>
        {alert.currentPriceFormatted}
      </span>
      {showStaleWarning && <PriceStatusBadge status={alert.priceStatus} fetchedAt={alert.priceFetchedAt} />}
    </>
  )
}

// Phase 6: Resolved market badge with win/loss indicator
function ResolvedBadge({ alert }: { alert: AlertRow }) {
  if (!alert.marketResolved || !alert.winningOutcome) return null

  const traderWon = alert.outcome === alert.winningOutcome

  return (
    <span
      className={`ml-2 px-1.5 py-0.5 text-xs rounded font-medium ${
        traderWon ? 'bg-green-700 text-green-100' : 'bg-red-700 text-red-100'
      }`}
      title={`Winner: ${alert.winningOutcome}`}
    >
      {traderWon ? 'WON' : 'LOST'}
    </span>
  )
}

export default function ReportPage() {
  const [report, setReport] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)

  // Phase 5: Conviction anomalies state
  const [anomalies, setAnomalies] = useState<ConvictionAnomalyResponse | null>(null)
  const [anomaliesExpanded, setAnomaliesExpanded] = useState(false)

  // Filters
  const [windowHours, setWindowHours] = useState<WindowHours>(24)
  const [whalesOnly, setWhalesOnly] = useState(false)
  const [category, setCategory] = useState<string>('')
  const [includeResolved, setIncludeResolved] = useState(false)

  // Pagination
  const [currentPage, setCurrentPage] = useState(1)

  // Sorting
  const [sortField, setSortField] = useState<SortField>('time')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  // Convergence expanded state
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // Phase 5: Fetch conviction anomalies
  const fetchAnomalies = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        window: `${windowHours}h`,
        limit: '50',
        _t: Date.now().toString(),
      })
      const res = await fetch(`/api/anomalies/conviction?${params}`, {
        cache: 'no-store',
      })
      if (res.ok) {
        const data: ConvictionAnomalyResponse = await res.json()
        setAnomalies(data)
      }
    } catch (err) {
      // Non-fatal, just log
      console.warn('[report] Failed to fetch anomalies:', err)
    }
  }, [windowHours])

  const fetchReport = useCallback(async (page = currentPage) => {
    try {
      setLoading(true)
      const params = new URLSearchParams({
        alertWindowHours: windowHours.toString(),
        convergenceWindowHours: windowHours.toString(),
        page: page.toString(),
        pageSize: '50',
        _t: Date.now().toString(),
      })
      if (whalesOnly) params.set('whalesOnly', 'true')
      if (category.trim()) params.set('category', category.trim())
      if (includeResolved) params.set('includeResolved', 'true')

      const res = await fetch(`/api/report?${params}`, {
        cache: 'no-store',
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.error || `HTTP ${res.status}`)
      }
      const data: ReportData = await res.json()
      setReport(data)
      setCurrentPage(page)
      setLastUpdate(new Date())
      setError(null)

      // Also fetch anomalies
      fetchAnomalies()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [windowHours, whalesOnly, category, includeResolved, currentPage, fetchAnomalies])

  useEffect(() => {
    fetchReport(1) // Reset to page 1 when filters change
    const interval = setInterval(() => fetchReport(currentPage), 10 * 60 * 1000)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowHours, whalesOnly, category, includeResolved])

  const goToPage = (page: number) => {
    if (report && page >= 1 && page <= report.meta.totalPages) {
      fetchReport(page)
    }
  }

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
      // For null values, sort them to the end regardless of direction
      let aVal: number | null, bVal: number | null
      switch (sortField) {
        case 'fillPrice':
          aVal = a.fillPrice
          bVal = b.fillPrice
          break
        case 'fillValue':
          aVal = a.fillValueUsd
          bVal = b.fillValueUsd
          break
        case 'positionValue':
          aVal = a.positionCurrentValue
          bVal = b.positionCurrentValue
          break
        case 'currentPrice':
          aVal = a.currentPrice
          bVal = b.currentPrice
          break
        case 'time':
          aVal = new Date(a.fillTimestamp).getTime()
          bVal = new Date(b.fillTimestamp).getTime()
          break
      }
      // Handle nulls - sort them to the end
      if (aVal === null && bVal === null) return 0
      if (aVal === null) return 1
      if (bVal === null) return -1
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
        <h1 className="text-2xl font-bold">Longshot Alpha Report</h1>
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
        <h1 className="text-2xl font-bold">Longshot Alpha Report</h1>
        <div className="bg-red-900/30 border border-red-500 rounded-lg p-4">
          <p className="text-red-400">Error: {error}</p>
          <button
            onClick={() => fetchReport()}
            className="mt-4 px-4 py-2 bg-red-600 hover:bg-red-700 rounded"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!report) return null

  const { meta, alertsPage, convergence, largeSingleBets } = report
  const sortedAlerts = getSortedAlerts(alertsPage)
  const whaleAlerts = sortedAlerts.filter(a => a.isWhale)
  const regularAlerts = sortedAlerts.filter(a => !a.isWhale)

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="space-y-4">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold">Longshot Alpha Report</h1>
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
              onClick={() => fetchReport()}
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
            <label className="text-poly-muted text-sm">
              <input
                type="checkbox"
                checked={includeResolved}
                onChange={(e) => setIncludeResolved(e.target.checked)}
                className="mr-2"
              />
              Resolved Only
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
            {meta.whalesOnly && <span className="mr-2">🐋 whales only</span>}
            {meta.category && <span className="mr-2">📁 {meta.category}</span>}
          </div>
        </div>

        {lastUpdate && (
          <p className="text-xs text-poly-muted">
            Last refresh: {lastUpdate.toLocaleTimeString()} • Window: {meta.alertWindowHours}h alerts, {meta.convergenceWindowHours}h convergence
          </p>
        )}
      </header>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
          <p className="text-poly-muted text-sm">Total Alerts</p>
          <p className="text-2xl font-bold">{meta.totalAlerts.toLocaleString()}</p>
        </div>
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
          <p className="text-poly-muted text-sm">Page</p>
          <p className="text-2xl font-bold">{meta.page}/{meta.totalPages}</p>
        </div>
        <button
          onClick={() => setWhalesOnly(!whalesOnly)}
          className={`bg-poly-card rounded-lg p-4 border text-left transition-colors ${whalesOnly ? 'border-purple-500 bg-purple-500/10' : 'border-poly-border hover:border-purple-500/50'}`}
          title={whalesOnly ? 'Click to show all alerts' : 'Click to show only whale alerts'}
        >
          <p className="text-poly-muted text-sm">Whale Alerts {whalesOnly && '✓'}</p>
          <p className="text-2xl font-bold text-purple-400">{meta.whaleAlerts} 🐋</p>
        </button>
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
          <p className="text-poly-muted text-sm">Unique Wallets</p>
          <p className="text-2xl font-bold">{meta.uniqueWallets}</p>
        </div>
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border border-amber-500/50">
          <p className="text-poly-muted text-sm">Convergence (2+ wallets)</p>
          <p className="text-2xl font-bold text-amber-400">{convergence.totalGroups}</p>
        </div>
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border border-cyan-500/50">
          <p className="text-poly-muted text-sm">Large Single Bets</p>
          <p className="text-2xl font-bold text-cyan-400">{largeSingleBets.totalGroups}</p>
        </div>
        <button
          onClick={() => setAnomaliesExpanded(!anomaliesExpanded)}
          className={`bg-poly-card rounded-lg p-4 border text-left transition-colors ${anomaliesExpanded ? 'border-red-500 bg-red-500/10' : 'border-poly-border hover:border-red-500/50'}`}
          title={anomaliesExpanded ? 'Click to collapse anomalies section' : 'Click to expand anomalies section'}
        >
          <p className="text-poly-muted text-sm">Conviction Anomalies {anomaliesExpanded && '✓'}</p>
          <p className="text-2xl font-bold text-red-400">{anomalies?.meta.stats.total || 0} 🎯</p>
        </button>
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
            Qualification: 2+ distinct wallets betting on the same outcome
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
                        <span className="font-bold text-amber-400">{group.distinctWallets}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-poly-muted">Odds: </span>
                        <span className="font-bold text-yellow-400">{group.oddsRangeFormatted}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-poly-muted">Total Value: </span>
                        <span className="font-bold text-poly-green">{group.totalPositionValueFormatted}</span>
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
                            <th className="text-right p-3 text-poly-muted font-medium" title="Price of this specific trade">Fill Price</th>
                            <th className="text-right p-3 text-poly-muted font-medium" title="Average entry price of full position">Pos Avg Entry</th>
                            <th className="text-right p-3 text-poly-muted font-medium">Position Value</th>
                            <th className="text-right p-3 text-poly-muted font-medium" title="Profit if position wins (based on avg entry)">Potential Win</th>
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
                                {w.isWhale && <span className="ml-1 text-purple-400">🐋</span>}
                              </td>
                              <td className="p-3 text-right text-yellow-400">{w.fillPriceFormatted}</td>
                              <td className="p-3 text-right text-poly-muted">{w.positionAvgPriceFormatted}</td>
                              <td className="p-3 text-right text-poly-green">{w.positionValueFormatted}</td>
                              <td className="p-3 text-right text-cyan-400">{w.potentialWinFormatted}</td>
                              <td className="p-3 text-right text-poly-muted text-xs">{formatTimeAgo(w.latestTimestamp)}</td>
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

      {/* Large Single Bets Section */}
      {largeSingleBets && largeSingleBets.groups && largeSingleBets.groups.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-xl font-bold flex items-center">
            <span className="w-3 h-3 bg-cyan-500 rounded-full mr-3"></span>
            Large Single Bets
            <span className="text-sm font-normal text-poly-muted ml-2">
              ({largeSingleBets.totalGroups} market{largeSingleBets.totalGroups !== 1 ? 's' : ''} with $10K+ single wallet positions)
            </span>
          </h2>
          <p className="text-xs text-poly-muted">
            Single wallet positions exceeding $10K on longshot outcomes
          </p>

          <div className="space-y-3">
            {largeSingleBets.groups.map((group) => {
              const groupKey = `single-${group.conditionId}-${group.outcome}`
              const isExpanded = expandedGroups.has(groupKey)

              return (
                <div
                  key={groupKey}
                  className="bg-poly-card rounded-lg border border-cyan-500/30 overflow-hidden"
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
                        <span className="text-cyan-400 ml-2 font-medium">→ {group.outcome}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-6 text-sm">
                      <div className="text-right">
                        <span className="text-poly-muted">Wallets: </span>
                        <span className="font-bold text-cyan-400">{group.distinctWallets}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-poly-muted">Odds: </span>
                        <span className="font-bold text-yellow-400">{group.oddsRangeFormatted}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-poly-muted">Total Value: </span>
                        <span className="font-bold text-poly-green">{group.totalPositionValueFormatted}</span>
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
                            <th className="text-right p-3 text-poly-muted font-medium" title="Price of this specific trade">Fill Price</th>
                            <th className="text-right p-3 text-poly-muted font-medium" title="Average entry price of full position">Pos Avg Entry</th>
                            <th className="text-right p-3 text-poly-muted font-medium">Position Value</th>
                            <th className="text-right p-3 text-poly-muted font-medium" title="Profit if position wins (based on avg entry)">Potential Win</th>
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
                                {w.isWhale && <span className="ml-1 text-purple-400">🐋</span>}
                              </td>
                              <td className="p-3 text-right text-yellow-400">{w.fillPriceFormatted}</td>
                              <td className="p-3 text-right text-poly-muted">{w.positionAvgPriceFormatted}</td>
                              <td className="p-3 text-right text-poly-green">{w.positionValueFormatted}</td>
                              <td className="p-3 text-right text-cyan-400">{w.potentialWinFormatted}</td>
                              <td className="p-3 text-right text-poly-muted text-xs">{formatTimeAgo(w.latestTimestamp)}</td>
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

      {/* Conviction Anomalies Section */}
      {anomaliesExpanded && anomalies && anomalies.anomalies.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-xl font-bold flex items-center">
            <span className="w-3 h-3 bg-red-500 rounded-full mr-3"></span>
            Conviction Anomalies
            <span className="text-sm font-normal text-poly-muted ml-2">
              ({anomalies.meta.stats.total} unusually large trades)
            </span>
          </h2>
          <p className="text-xs text-poly-muted">
            Sorted by severity (ln(1+notional) × ln(1+ratio)) • Max severity: {anomalies.meta.stats.maxSeverity?.toFixed(1) || 'N/A'} • Max ratio: {anomalies.meta.stats.maxRatio}x
          </p>

          <div className="bg-poly-card rounded-lg border border-red-500/30 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-poly-border">
                  <tr>
                    <th className="text-left p-3 text-poly-muted font-medium">Trader</th>
                    <th className="text-left p-3 text-poly-muted font-medium">Market</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Trade Size</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Median</th>
                    <th className="text-right p-3 text-poly-muted font-medium" title="How many times larger than median">Ratio</th>
                    <th className="text-right p-3 text-poly-muted font-medium" title="Severity score: ln(1+notional) × ln(1+ratio)">Severity</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {anomalies.anomalies.slice(0, 20).map((anomaly) => (
                    <tr key={anomaly.id} className="border-t border-poly-border hover:bg-poly-border/30">
                      <td className="p-3">
                        <a
                          href={`https://polymarket.com/profile/${anomaly.wallet}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-poly-blue hover:underline"
                        >
                          {anomaly.trader_name || `${anomaly.wallet.slice(0, 8)}...`}
                        </a>
                        {anomaly.is_whale && <span className="ml-1 text-purple-400">🐋</span>}
                        {anomaly.last_seen_at && <span className="ml-1 text-xs text-orange-400" title="Multiple trades merged">⚡</span>}
                      </td>
                      <td className="p-3 max-w-xs truncate">
                        <a
                          href={`https://polymarket.com/market/${anomaly.slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-poly-blue hover:underline"
                        >
                          {(anomaly.title || 'Unknown Market').slice(0, 35)}
                        </a>
                        <span className="text-poly-muted ml-2">({anomaly.outcome})</span>
                      </td>
                      <td className="p-3 text-right text-red-400 font-bold">{formatMoney(anomaly.trade_notional)}</td>
                      <td className="p-3 text-right text-poly-muted">{formatMoney(anomaly.baseline_median)}</td>
                      <td className="p-3 text-right">
                        <span className={`font-bold ${anomaly.ratio_to_median >= 5 ? 'text-red-400' : anomaly.ratio_to_median >= 3 ? 'text-orange-400' : 'text-yellow-400'}`}>
                          {anomaly.ratio_to_median.toFixed(1)}x
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <span className={`font-mono ${anomaly.severity >= 50 ? 'text-red-400' : anomaly.severity >= 30 ? 'text-orange-400' : 'text-yellow-400'}`}>
                          {(anomaly.severity || 0).toFixed(1)}
                        </span>
                      </td>
                      <td className="p-3 text-right text-poly-muted text-xs">{formatTimeAgo(anomaly.fill_timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {anomalies.anomalies.length > 20 && (
              <div className="px-3 py-2 border-t border-poly-border text-xs text-poly-muted">
                Showing 20 of {anomalies.anomalies.length} anomalies (sorted by severity)
              </div>
            )}
          </div>
        </section>
      )}

      {/* Whale Trades Section - only show when NOT filtering to whales (otherwise redundant with main table) */}
      {whaleAlerts.length > 0 && !whalesOnly && (
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
                    <th className="text-right p-3 text-poly-muted font-medium" title="Current market price (cached)">Current Price</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Position Value</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Pos Avg Entry</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Potential Win</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {whaleAlerts.slice(0, 20).map((alert) => (
                    <tr key={alert.id} className={`border-t border-poly-border hover:bg-poly-border/30 ${alert.marketResolved ? 'opacity-50' : ''}`}>
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
                        <ResolvedBadge alert={alert} />
                      </td>
                      <td className="p-3 text-right text-poly-yellow">{alert.fillPriceFormatted}</td>
                      <td className="p-3 text-right"><PriceDisplay alert={alert} /></td>
                      <td className="p-3 text-right text-white font-medium">{alert.positionCurrentValueFormatted}</td>
                      <td className="p-3 text-right text-poly-muted">{alert.positionAvgPriceFormatted}</td>
                      <td className="p-3 text-right text-amber-400 font-medium">{alert.potentialWinFormatted}</td>
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
                    onClick={() => handleSort('currentPrice')}
                    title="Current market price (cached, refreshes every 10min)"
                  >
                    Current Price<SortIcon field="currentPrice" />
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
                  <th className="text-right p-3 text-poly-muted font-medium" title="Potential profit if position wins">
                    Potential Win
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
                        <td className="p-4 text-center text-poly-muted" colSpan={9}>
                          No alerts found matching filters.
                        </td>
                      </tr>
                    )
                  }
                  return displayAlerts.slice(0, 50).map((alert) => (
                    <tr key={alert.id} className={`border-t border-poly-border hover:bg-poly-border/30 ${alert.marketResolved ? 'opacity-50' : ''}`}>
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
                        <ResolvedBadge alert={alert} />
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
                      <td className="p-3 text-right"><PriceDisplay alert={alert} /></td>
                      <td className="p-3 text-right text-poly-green">{alert.fillValueFormatted}</td>
                      <td className="p-3 text-right text-white font-medium">{alert.positionCurrentValueFormatted}</td>
                      <td className="p-3 text-right text-poly-muted">{alert.positionAvgPriceFormatted}</td>
                      <td className="p-3 text-right text-amber-400 font-medium">{alert.potentialWinFormatted}</td>
                      <td className="p-3 text-right text-poly-muted text-xs whitespace-nowrap">
                        {formatTimeAgo(alert.fillTimestamp)}
                      </td>
                    </tr>
                  ))
                })()}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2 border-t border-poly-border flex items-center justify-between">
            <span className="text-xs text-poly-muted">
              Showing {sortedAlerts.length} of {meta.totalAlerts} alerts
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => goToPage(1)}
                disabled={meta.page <= 1}
                className="px-2 py-1 text-xs bg-poly-card border border-poly-border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-poly-border"
              >
                ««
              </button>
              <button
                onClick={() => goToPage(meta.page - 1)}
                disabled={meta.page <= 1}
                className="px-2 py-1 text-xs bg-poly-card border border-poly-border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-poly-border"
              >
                ‹ Prev
              </button>
              <span className="text-sm px-2">
                Page <span className="font-bold">{meta.page}</span> of <span className="font-bold">{meta.totalPages}</span>
              </span>
              <button
                onClick={() => goToPage(meta.page + 1)}
                disabled={meta.page >= meta.totalPages}
                className="px-2 py-1 text-xs bg-poly-card border border-poly-border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-poly-border"
              >
                Next ›
              </button>
              <button
                onClick={() => goToPage(meta.totalPages)}
                disabled={meta.page >= meta.totalPages}
                className="px-2 py-1 text-xs bg-poly-card border border-poly-border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-poly-border"
              >
                »»
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="text-center text-poly-muted text-sm py-4 border-t border-poly-border">
        <p>Convergence detection enabled</p>
        <p className="mt-1">Position values are snapshots from ingestion time • Current prices refresh every 10 min</p>
        <p className="mt-1 text-xs">
          Price status: <span className="text-cyan-400">fresh</span> (&le;30min) &bull;
          <span className="text-yellow-400 ml-2">⚠ Xm ago</span> (stale &gt;30min) &bull;
          <span className="text-poly-muted ml-2 italic">No price yet</span> (pending)
        </p>
        <p className="mt-1 text-xs">
          Resolved markets hidden by default &bull;
          <span className="ml-1 px-1.5 py-0.5 bg-gray-600 text-gray-300 rounded text-xs">RESOLVED</span>
          <span className="ml-1">= market has settled</span>
        </p>
      </footer>
    </div>
  )
}
