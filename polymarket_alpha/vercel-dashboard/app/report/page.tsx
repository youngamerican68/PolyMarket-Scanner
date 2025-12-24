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
  // Total payout if outcome wins = positionSize (each share pays $1)
  totalPayoutIfWins: number | null
  totalPayoutIfWinsFormatted: string
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
  marketFinalizedAt: string | null // When P&L finalization ran for this market
  // Phase 8: Final P&L from market_final_pnl (when resolved)
  finalPnl: number | null
  finalPositionFound: boolean | null
  // Phase 9: Estimate metadata
  finalPnlIsEstimated: boolean | null
  finalPnlEstimateSource: string | null
  finalPnlEstimateAsOf: string | null
}

interface ConvergenceWallet {
  wallet: string
  traderName: string
  whaleLabel: string | null
  positionSize: number | null
  // Cost basis = positionSize × positionAvgPrice
  positionCost: number | null
  positionCostFormatted: string
  // Mark-to-market value = positionSize × currentPrice
  positionValue: number | null
  positionValueFormatted: string
  fillPrice: number | null
  fillPriceFormatted: string
  positionAvgPrice: number | null
  positionAvgPriceFormatted: string
  // Total payout if outcome wins = positionSize (each share pays $1)
  totalPayoutIfWins: number | null
  totalPayoutIfWinsFormatted: string
  latestTimestamp: string
  isWhale: boolean
  // Cached current price
  currentPrice: number | null
  // Phase 8: Final P&L
  finalPnl: number | null
  finalPositionFound: boolean | null
  // Phase 9: Estimate metadata
  finalPnlIsEstimated: boolean | null
  finalPnlEstimateSource: string | null
  finalPnlEstimateAsOf: string | null
  // Phase 10: Position sync overlay (when ENABLE_POSITION_SYNC=true)
  syncedPositionSize: number | null
  syncedAvgPrice: number | null
  syncedCurrentValue: number | null
  syncedPayoutIfWins: number | null
  syncedPositionCost: number | null
  syncedPositionCostFormatted: string
  syncedCurrentValueFormatted: string
  syncedPayoutIfWinsFormatted: string
  syncedAt: string | null
  syncStatus: string | null // 'synced' | 'not_found' | null
}

interface ConvergenceGroup {
  conditionId: string
  outcome: string
  title: string
  slug: string | null
  eventSlug: string | null
  distinctWallets: number
  // Cost = sum(positionSize × positionAvgPrice) across wallets
  totalCost: number
  totalCostFormatted: string
  // Value = sum(positionSize × currentPrice) across wallets; null if any wallet missing price
  totalValue: number | null
  totalValueFormatted: string
  // Payout if outcome wins = sum(positionSize) across wallets; null if any wallet missing size
  totalPayoutIfWins: number | null
  totalPayoutIfWinsFormatted: string
  minOdds: number | null
  maxOdds: number | null
  oddsRangeFormatted: string
  qualifies: boolean
  wallets: ConvergenceWallet[]
  // Phase 6: Market resolution fields
  marketResolved: boolean
  winningOutcome: string | null
  marketFinalizedAt: string | null
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
  // Phase 10: Position sync feature flag
  positionSyncEnabled?: boolean
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
  // Market resolution fields (from market_status JOIN)
  market_resolved: boolean
  winning_outcome: string | null
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
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (isNaN(num)) return 'N/A'
  if (Math.abs(num) >= 1000) {
    return `$${(num / 1000).toFixed(1)}K`
  }
  return `$${num.toFixed(0)}`
}

function formatOdds(price: number | null): string {
  if (price === null || price === undefined) return 'N/A'
  const num = typeof price === 'string' ? parseFloat(price) : price
  if (isNaN(num)) return 'N/A'
  return `${(num * 100).toFixed(1)}%`
}

// Normalize probability: handle both 0-1 and 0-100 formats
// Returns null for invalid values (<=0 or >=1 after normalization)
function normalizeProb(x: number | null | undefined): number | null {
  if (x === null || x === undefined) return null
  const v = x > 1 && x <= 100 ? x / 100 : x
  if (v <= 0 || v >= 1) return null
  return v
}

// Compute potential win (max upside) from snapshot-derived position
// Preferred: shares × (1 - avgEntry)
// Fallback: costBasis × (1/avgEntry - 1) when shares unavailable
function calcPotentialWinUsd(opts: {
  shares?: number | null
  costBasis?: number | null
  avgEntry: number | null | undefined
}): number | null {
  const avg = normalizeProb(opts.avgEntry)
  if (avg === null) return null

  const shares = opts.shares ?? null
  if (shares !== null && shares !== undefined && shares > 0) {
    return Math.max(0, shares * (1 - avg))
  }

  const cost = opts.costBasis ?? null
  if (cost !== null && cost !== undefined && cost > 0) {
    return Math.max(0, cost * (1 / avg - 1))
  }

  return null
}

// Format potential win as USD string
function formatPotentialWin(value: number | null): string {
  if (value === null || value === undefined) return '—'
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (isNaN(num)) return '—'
  if (num >= 1000) {
    return `$${(num / 1000).toFixed(1)}K`
  }
  return `$${num.toFixed(0)}`
}

// Format USD value compactly (same as formatPotentialWin but for general use)
function formatUsd(value: number | null): string {
  if (value === null || value === undefined) return '—'
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (isNaN(num)) return '—'
  if (num >= 1000) {
    return `$${(num / 1000).toFixed(1)}K`
  }
  return `$${num.toFixed(0)}`
}


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
  if (!alert.marketResolved || !alert.winningOutcome) {
    return null
  }
  const won = alert.outcome === alert.winningOutcome
  return (
    <span className={`ml-2 px-2 py-0.5 rounded text-xs font-bold ${won ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
      {won ? 'WON' : 'LOST'}
    </span>
  )
}

// Convergence group badge (shows if the group's outcome won or lost)
function ConvergenceBadge({ group }: { group: ConvergenceGroup }) {
  if (!group.marketResolved || !group.winningOutcome) {
    return null
  }
  const won = group.outcome === group.winningOutcome
  return (
    <span className={`ml-2 px-2 py-0.5 rounded text-xs font-bold ${won ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
      {won ? 'WON' : 'LOST'}
    </span>
  )
}

// Badge for conviction anomaly resolution
function ConvictionBadge({ anomaly }: { anomaly: ConvictionAnomaly }) {
  if (!anomaly.market_resolved || !anomaly.winning_outcome) {
    return null
  }
  const won = anomaly.outcome === anomaly.winning_outcome
  return (
    <span className={`ml-2 px-2 py-0.5 rounded text-xs font-bold ${won ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
      {won ? 'WON' : 'LOST'}
    </span>
  )
}

// Payout if Wins display - uses backend-computed totalPayoutIfWins (= positionSize)
// Each share pays $1 if the outcome wins
function PayoutIfWinsCell({ alert }: { alert: AlertRow }) {
  if (alert.totalPayoutIfWins === null) {
    return <span className="text-gray-500">—</span>
  }
  return <span className="text-amber-400">{alert.totalPayoutIfWinsFormatted}</span>
}

// Payout if Wins for convergence wallet rows - uses backend-computed totalPayoutIfWins
function ConvergenceWalletPayoutIfWins({ wallet }: { wallet: ConvergenceWallet }) {
  if (wallet.totalPayoutIfWins === null) {
    return <span className="text-gray-500">—</span>
  }
  return <span className="text-cyan-400">{wallet.totalPayoutIfWinsFormatted}</span>
}

// Phase 10: Synced payout display with "synced X ago" indicator
// Shows synced data when available, falls back to snapshot data
function SyncedPayoutDisplay({ wallet }: { wallet: ConvergenceWallet }) {
  // If we have synced data, show it with indicator
  if (wallet.syncedPayoutIfWins !== null && wallet.syncedAt) {
    const syncAge = formatTimeAgo(wallet.syncedAt)
    const isClosed = wallet.syncStatus === 'not_found'

    if (isClosed) {
      return (
        <span className="text-gray-500" title="Position closed (not found in API)">
          $0 <span className="text-xs text-gray-600">(closed)</span>
        </span>
      )
    }

    return (
      <span className="whitespace-nowrap" title={`Synced ${syncAge}`}>
        <span className="text-emerald-400 font-medium">{wallet.syncedPayoutIfWinsFormatted}</span>
        <span className="ml-1 text-xs text-emerald-500/60">⟳ {syncAge}</span>
      </span>
    )
  }

  // Fall back to snapshot data
  if (wallet.totalPayoutIfWins === null) {
    return <span className="text-gray-500">—</span>
  }
  return <span className="text-cyan-400">{wallet.totalPayoutIfWinsFormatted}</span>
}

// Position Cost / Value for convergence tables
// Uses backend-computed values: positionCost = shares × avgEntry, positionValue = shares × currentPrice
function ConvergencePositionCostValue({ wallet }: { wallet: ConvergenceWallet }) {
  // Use the correctly computed values from the backend
  const costStr = wallet.positionCostFormatted
  const valueStr = wallet.positionValueFormatted

  if (wallet.positionCost === null) {
    return <span className="text-gray-500">—</span>
  }

  return (
    <span className="whitespace-nowrap">
      <span className="text-poly-green">{costStr}</span>
      <span className="text-poly-muted/50"> / </span>
      <span className={wallet.positionValue !== null ? 'text-white font-medium' : 'text-gray-500'}>{valueStr}</span>
    </span>
  )
}

// Phase 10: Synced Position Cost / Value display with "synced X ago" indicator
// Shows synced data when available, falls back to snapshot data
function SyncedPositionCostValue({ wallet }: { wallet: ConvergenceWallet }) {
  // If we have synced data, show it with indicator
  if (wallet.syncedPositionCost !== null && wallet.syncedAt) {
    const syncAge = formatTimeAgo(wallet.syncedAt)
    const isClosed = wallet.syncStatus === 'not_found'

    if (isClosed) {
      return (
        <span className="text-gray-500" title="Position closed (not found in API)">
          $0 / $0 <span className="text-xs text-gray-600">(closed)</span>
        </span>
      )
    }

    return (
      <span className="whitespace-nowrap" title={`Synced ${syncAge}`}>
        <span className="text-emerald-400">{wallet.syncedPositionCostFormatted}</span>
        <span className="text-poly-muted/50"> / </span>
        <span className="text-emerald-300 font-medium">{wallet.syncedCurrentValueFormatted}</span>
        <span className="ml-1 text-xs text-emerald-500/60">⟳ {syncAge}</span>
      </span>
    )
  }

  // Fall back to snapshot data
  return <ConvergencePositionCostValue wallet={wallet} />
}

// Position Cost / Value display for All Longshot Trades table
// Computes cost and value from shares and normalized prices to ensure consistency
// Format: "$COST / $VALUE" or "$COST / —" if no current price
function PositionCostValue({ alert }: { alert: AlertRow }) {
  const shares = alert.positionSize
  const avgEntry = normalizeProb(alert.positionAvgPrice)
  const currentPrice = normalizeProb(alert.currentPrice)

  // Compute position cost = shares × avgEntry
  const positionCost = (shares !== null && avgEntry !== null && shares > 0)
    ? shares * avgEntry
    : null

  // Compute position value = shares × currentPrice (only if current price available)
  const positionValue = (shares !== null && currentPrice !== null && shares > 0)
    ? shares * currentPrice
    : null

  const costStr = formatUsd(positionCost)
  const valueStr = positionValue !== null ? formatUsd(positionValue) : '—'

  if (positionCost === null) {
    return <span className="text-gray-500">—</span>
  }

  return (
    <span className="whitespace-nowrap">
      <span className="text-poly-muted">{costStr}</span>
      <span className="text-poly-muted/50"> / </span>
      <span className={positionValue !== null ? 'text-white font-medium' : 'text-gray-500'}>{valueStr}</span>
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

  // Phase 10: Position sync state
  const [positionSyncLoading, setPositionSyncLoading] = useState(false)
  const [positionSyncResult, setPositionSyncResult] = useState<{
    walletsSynced: number
    walletsSkippedTtl: number
    walletsFailed: number
    rowsUpdated: number
    durationMs: number
  } | null>(null)

  // Filters
  const [windowHours, setWindowHours] = useState<WindowHours>(24)
  const [whalesOnly, setWhalesOnly] = useState(false)
  const [hideCrypto, setHideCrypto] = useState(false)
  const [includeResolved, setIncludeResolved] = useState(false)
  const [ultraLongshots, setUltraLongshots] = useState(false) // ≤10% odds filter

  // Pagination
  const [currentPage, setCurrentPage] = useState(1)

  // Convergence expanded state
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // Phase 10: Refresh positions on-demand
  const refreshPositions = useCallback(async () => {
    if (!report?.meta.positionSyncEnabled) return
    setPositionSyncLoading(true)
    setPositionSyncResult(null)
    try {
      const res = await fetch('/api/positions/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'filter',
          alertWindowHours: windowHours,
          whalesOnly,
          includeResolved,
          excludeCategory: hideCrypto ? 'crypto' : undefined,
          maxOdds: ultraLongshots ? 0.10 : 0.25,
          minPosition: 2500,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.success && data.result) {
          setPositionSyncResult(data.result)
          // Refetch report to get updated overlay data
          await fetchReport()
        }
      }
    } catch (err) {
      console.warn('[report] Position sync failed:', err)
    } finally {
      setPositionSyncLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.meta.positionSyncEnabled, windowHours, whalesOnly, includeResolved, hideCrypto, ultraLongshots])

  // Phase 5: Fetch conviction anomalies
  const fetchAnomalies = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        window: `${windowHours}h`,
        limit: '50',
        _t: Date.now().toString(),
      })
      // Pass resolved filter to match main dashboard filter
      // includeResolved=true means show ONLY resolved
      // includeResolved=false means EXCLUDE resolved (show active only)
      params.set('resolved', includeResolved ? 'only' : 'exclude')
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
  }, [windowHours, includeResolved])

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
      if (hideCrypto) params.set('excludeCategory', 'crypto')
      if (includeResolved) params.set('includeResolved', 'true')
      if (ultraLongshots) params.set('maxOdds', '0.10')

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
  }, [windowHours, whalesOnly, hideCrypto, includeResolved, ultraLongshots, currentPage, fetchAnomalies])

  useEffect(() => {
    fetchReport(1) // Reset to page 1 when filters change
    const interval = setInterval(() => fetchReport(currentPage), 10 * 60 * 1000)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowHours, whalesOnly, hideCrypto, includeResolved, ultraLongshots])

  // Dev-only warning for potential column cross-wiring detection
  // Flags rows where currentPrice is tiny but positionValue is large
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return
    const alerts = report?.alertsPage
    if (!Array.isArray(alerts)) return

    for (const alert of alerts) {
      // Normalize currentPrice to handle both 0-1 and 0-100 formats
      const currentPrice = normalizeProb(alert.currentPrice)
      const positionValue = alert.positionCurrentValue

      // Warn if current price is extremely small but position value is large
      // This MIGHT indicate cross-wiring but could also be legitimate (longshot with big position)
      if (
        currentPrice !== null &&
        positionValue !== null &&
        currentPrice <= 0.005 &&
        positionValue >= 1000
      ) {
        console.warn(
          `[DEV Sanity Check] Alert ${alert.id}: currentPrice=${(currentPrice * 100).toFixed(2)}% with positionValue=$${positionValue.toFixed(0)}. ` +
          `Market: "${alert.title}", Outcome: "${alert.outcome}". ` +
          `Verify: (1) Current Price corresponds to same outcome as position, (2) Position Value is truly current value (not cost basis).`
        )
      }
    }
  }, [report?.alertsPage])

  const goToPage = (page: number) => {
    if (report && page >= 1 && page <= report.meta.totalPages) {
      fetchReport(page)
    }
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
  const whaleAlerts = alertsPage.filter(a => a.isWhale)
  const regularAlerts = alertsPage.filter(a => !a.isWhale)

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="space-y-4">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold">Longshot Alpha Report</h1>
            <p className="text-poly-muted text-sm">
              Longshot bets ({ultraLongshots ? '≤10%' : '<25%'} odds) with $2.5K+ position value
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
            {/* Phase 10: Position sync refresh button */}
            {report?.meta.positionSyncEnabled && (
              <button
                onClick={refreshPositions}
                disabled={positionSyncLoading}
                className="px-4 py-2 bg-blue-600 text-white font-medium rounded hover:bg-blue-500 disabled:opacity-50 flex items-center gap-2"
                title="Fetch latest positions from Polymarket API (2min cache)"
              >
                {positionSyncLoading ? (
                  <>
                    <span className="animate-spin">⟳</span>
                    Syncing...
                  </>
                ) : (
                  <>
                    <span>⟳</span>
                    Sync Positions
                  </>
                )}
              </button>
            )}
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
            <label className="text-poly-muted text-sm">
              <input
                type="checkbox"
                checked={ultraLongshots}
                onChange={(e) => setUltraLongshots(e.target.checked)}
                className="mr-2"
              />
              ≤10% Only
            </label>
          </div>

          <button
            onClick={() => setHideCrypto(!hideCrypto)}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              hideCrypto
                ? 'bg-orange-500/20 text-orange-400 border border-orange-500/50'
                : 'bg-poly-border text-poly-muted border border-poly-border hover:border-orange-500/30'
            }`}
          >
            {hideCrypto ? '🚫 Crypto Hidden' : 'Hide Crypto'}
          </button>

          <div className="text-xs text-poly-muted ml-auto">
            {meta.whalesOnly && <span className="mr-2">🐋 whales only</span>}
            {hideCrypto && <span className="mr-2">🚫 no crypto</span>}
          </div>
        </div>

        {lastUpdate && (
          <p className="text-xs text-poly-muted">
            Last refresh: {lastUpdate.toLocaleTimeString()} • Window: {meta.alertWindowHours}h alerts, {meta.convergenceWindowHours}h convergence
          </p>
        )}
        {/* Phase 10: Position sync result */}
        {positionSyncResult && (
          <p className="text-xs text-emerald-400">
            Position sync: {positionSyncResult.walletsSynced} wallets synced
            {positionSyncResult.walletsSkippedTtl > 0 && <>, {positionSyncResult.walletsSkippedTtl} cached</>}
            {positionSyncResult.walletsFailed > 0 && <>, {positionSyncResult.walletsFailed} failed</>}
            <span className="text-poly-muted ml-2">({positionSyncResult.durationMs}ms)</span>
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
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border border-red-500/50">
          <p className="text-poly-muted text-sm">Conviction Anomalies</p>
          <p className="text-2xl font-bold text-red-400">{anomalies?.meta.count || 0} 🎯</p>
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
                        <ConvergenceBadge group={group} />
                      </div>
                    </div>
                    <div className="flex items-center gap-6 text-sm">
                      <div className="text-right">
                        <span className="text-poly-muted">Wallets: </span>
                        <span className="font-bold text-amber-400">{group.distinctWallets}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-poly-muted">Fill Odds: </span>
                        <span className="font-bold text-yellow-400">{group.oddsRangeFormatted}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-poly-muted">Total Cost / Value: </span>
                        <span className="whitespace-nowrap">
                          <span className="font-bold text-poly-green">{group.totalCostFormatted}</span>
                          <span className="text-poly-muted/50"> / </span>
                          <span className={group.totalValue !== null ? 'font-bold text-white' : 'text-gray-500'}>{group.totalValueFormatted}</span>
                        </span>
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
                            <th className="text-right p-3 text-poly-muted font-medium" title="Price of this specific trade (not total position)">Last Fill Price</th>
                            <th className="text-right p-3 text-poly-muted font-medium" title="Average entry price of full position">Pos Avg Entry</th>
                            <th className="text-right p-3 text-poly-muted font-medium" title="Cost basis / Current value (no live price available)">Position Cost / Value</th>
                            <th className="text-right p-3 text-poly-muted font-medium" title="Total payout if outcome wins ($1 per share)">Payout if Wins</th>
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
                              <td className="p-3 text-right"><SyncedPositionCostValue wallet={w} /></td>
                              <td className="p-3 text-right font-medium"><SyncedPayoutDisplay wallet={w} /></td>
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
                        <ConvergenceBadge group={group} />
                      </div>
                    </div>
                    <div className="flex items-center gap-6 text-sm">
                      <div className="text-right">
                        <span className="text-poly-muted">Wallets: </span>
                        <span className="font-bold text-cyan-400">{group.distinctWallets}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-poly-muted">Fill Odds: </span>
                        <span className="font-bold text-yellow-400">{group.oddsRangeFormatted}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-poly-muted">Total Cost / Value: </span>
                        <span className="whitespace-nowrap">
                          <span className="font-bold text-poly-green">{group.totalCostFormatted}</span>
                          <span className="text-poly-muted/50"> / </span>
                          <span className={group.totalValue !== null ? 'font-bold text-white' : 'text-gray-500'}>{group.totalValueFormatted}</span>
                        </span>
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
                            <th className="text-right p-3 text-poly-muted font-medium" title="Price of this specific trade (not total position)">Last Fill Price</th>
                            <th className="text-right p-3 text-poly-muted font-medium" title="Average entry price of full position">Pos Avg Entry</th>
                            <th className="text-right p-3 text-poly-muted font-medium" title="Cost basis / Current value (no live price available)">Position Cost / Value</th>
                            <th className="text-right p-3 text-poly-muted font-medium" title="Total payout if outcome wins ($1 per share)">Payout if Wins</th>
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
                              <td className="p-3 text-right"><SyncedPositionCostValue wallet={w} /></td>
                              <td className="p-3 text-right font-medium"><SyncedPayoutDisplay wallet={w} /></td>
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
      {anomalies && anomalies.anomalies.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-xl font-bold flex items-center">
            <span className="w-3 h-3 bg-red-500 rounded-full mr-3"></span>
            Conviction Anomalies
            <span className="text-sm font-normal text-poly-muted ml-2">
              ({anomalies.meta.count} unusually large trades)
            </span>
          </h2>
          <p className="text-xs text-poly-muted">
            Sorted by severity (ln(1+notional) × ln(1+ratio)) • Max severity: {anomalies.meta.stats.maxSeverity != null ? Number(anomalies.meta.stats.maxSeverity).toFixed(1) : 'N/A'} • Max ratio: {anomalies.meta.stats.maxRatio != null ? Number(anomalies.meta.stats.maxRatio).toFixed(1) : 'N/A'}x
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
                        <ConvictionBadge anomaly={anomaly} />
                      </td>
                      <td className="p-3 text-right text-red-400 font-bold">{formatMoney(anomaly.trade_notional)}</td>
                      <td className="p-3 text-right text-poly-muted">{formatMoney(anomaly.baseline_median)}</td>
                      <td className="p-3 text-right">
                        <span className={`font-bold ${Number(anomaly.ratio_to_median) >= 5 ? 'text-red-400' : Number(anomaly.ratio_to_median) >= 3 ? 'text-orange-400' : 'text-yellow-400'}`}>
                          {Number(anomaly.ratio_to_median).toFixed(1)}x
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <span className={`font-mono ${Number(anomaly.severity) >= 50 ? 'text-red-400' : Number(anomaly.severity) >= 30 ? 'text-orange-400' : 'text-yellow-400'}`}>
                          {Number(anomaly.severity || 0).toFixed(1)}
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
                  <th className="text-right p-3 text-poly-muted font-medium" title="Price of this specific trade (not total position)">
                    Last Fill Price
                  </th>
                  <th className="text-right p-3 text-poly-muted font-medium" title="Current market price (cached, refreshes every 10min)">
                    Current Price
                  </th>
                  <th className="text-right p-3 text-poly-muted font-medium" title="USD value of this specific trade (not total position)">
                    Last Fill Value
                  </th>
                  <th className="text-right p-3 text-poly-muted font-medium" title="Cost basis (shares × avg entry) / Current value (shares × current price)">
                    Position Cost / Value
                  </th>
                  <th className="text-right p-3 text-poly-muted font-medium" title="Average entry price of position">
                    Pos Avg Entry
                  </th>
                  <th className="text-right p-3 text-poly-muted font-medium" title="Total payout if outcome wins ($1 per share)">
                    Payout if Wins
                  </th>
                  <th className="text-right p-3 text-poly-muted font-medium">
                    Time
                  </th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const displayAlerts = whalesOnly ? alertsPage : regularAlerts.length > 0 ? regularAlerts : alertsPage
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
                    <tr key={alert.id} className="border-t border-poly-border hover:bg-poly-border/30">
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span className="truncate max-w-xs">
                            <a
                              href={`https://polymarket.com/event/${alert.eventSlug}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-poly-blue hover:underline"
                            >
                              {(alert.title || 'Unknown Market').slice(0, 40)}
                            </a>
                            <span className="text-poly-muted ml-2">({alert.outcome})</span>
                          </span>
                          <ResolvedBadge alert={alert} />
                        </div>
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
                      <td className="p-3 text-right"><PositionCostValue alert={alert} /></td>
                      <td className="p-3 text-right text-poly-muted">{alert.positionAvgPriceFormatted}</td>
                      <td className="p-3 text-right font-medium"><PayoutIfWinsCell alert={alert} /></td>
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
              Showing {alertsPage.length} of {meta.totalAlerts} alerts
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
        {report?.meta.positionSyncEnabled && (
          <p className="mt-1 text-xs text-emerald-400/80">
            ⟳ Position sync enabled • Click &quot;Sync Positions&quot; for live position data (2min cache)
          </p>
        )}
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
