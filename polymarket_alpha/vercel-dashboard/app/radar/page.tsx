'use client'

import React, { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'

// Types for radar signals
interface RadarSignal {
  id: string
  fillTimestamp: string
  wallet: string
  traderName: string | null
  conditionId: string
  title: string | null
  outcome: string
  eventSlug: string | null
  slug: string | null
  fillPrice: number
  fillPriceFormatted: string
  positionSize: number | null
  positionCost: number | null
  positionCostFormatted: string
  positionValueUsd: number | null
  positionValueFormatted: string
  potentialPayout: number | null
  potentialPayoutFormatted: string
  walletFirstSeen: string
  walletDaysOld: number
  walletTradeCount: number
  walletTradeCountAtLimit: boolean
  scores: {
    freshness: number
    activity: number
    odds: number
    betSize: number
    payout: number
    total: number
  }
  marketResolved: boolean
  winningOutcome: string | null
  isWhale: boolean
  whaleLabel: string | null
  hasSyncedData: boolean
  syncedAt: string | null
  isHedger: boolean
  isSports: boolean
  isSold: boolean
}

interface RadarMetadata {
  maxOdds: number
  minPosition: number
  sinceDays: number
  minScore: number
  limit: number
  includeResolved: boolean
  sortBy: 'score' | 'time' | 'return'
  hideSports: boolean
  totalCandidates: number
  filteredCount: number
  returnedCount: number
  scoringModel: {
    freshness: string
    activity: string
    odds: string
    betSize: string
    payout: string
    maxScore: number
  }
}

interface RadarResponse {
  metadata: RadarMetadata
  signals: RadarSignal[]
  generatedAt: string
}

// Score color helper
function getScoreColor(score: number, max: number = 125): string {
  const pct = score / max
  if (pct >= 0.8) return 'text-red-400'
  if (pct >= 0.6) return 'text-orange-400'
  if (pct >= 0.4) return 'text-yellow-400'
  return 'text-gray-400'
}

function getScoreBgColor(score: number, max: number = 125): string {
  const pct = score / max
  if (pct >= 0.8) return 'bg-red-500/20'
  if (pct >= 0.6) return 'bg-orange-500/20'
  if (pct >= 0.4) return 'bg-yellow-500/20'
  return 'bg-gray-500/20'
}

// Score bar component
function ScoreBar({ score, max, label }: { score: number; max: number; label: string }) {
  const pct = (score / max) * 100
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 text-gray-500">{label}</span>
      <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full ${score >= max * 0.8 ? 'bg-red-500' : score >= max * 0.6 ? 'bg-orange-500' : score >= max * 0.4 ? 'bg-yellow-500' : 'bg-gray-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-6 text-right text-gray-400">{score}</span>
    </div>
  )
}

export default function RadarPage() {
  const [signals, setSignals] = useState<RadarSignal[]>([])
  const [metadata, setMetadata] = useState<RadarMetadata | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Sync state
  const [syncLoading, setSyncLoading] = useState(false)
  const [syncResult, setSyncResult] = useState<{ walletsSynced: number } | null>(null)

  // Watchlist state
  const [savedItems, setSavedItems] = useState<Set<string>>(new Set())
  const [savingItems, setSavingItems] = useState<Set<string>>(new Set())

  // Filters (defaults match main report)
  const [maxOdds, setMaxOdds] = useState(0.25)
  const [minPosition, setMinPosition] = useState(2500)
  const [sinceDays, setSinceDays] = useState(7)
  const [minScore, setMinScore] = useState(50)
  const [includeResolved, setIncludeResolved] = useState(false)
  const [sortBy, setSortBy] = useState<'score' | 'time' | 'return'>('time')
  const [hideSports, setHideSports] = useState(true)  // default: hide sports

  const fetchSignals = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        maxOdds: maxOdds.toString(),
        minPosition: minPosition.toString(),
        sinceDays: sinceDays.toString(),
        minScore: minScore.toString(),
        includeResolved: includeResolved.toString(),
        sortBy,
        hideSports: hideSports.toString(),
        limit: '100',
      })
      const res = await fetch(`/api/radar?${params}`)
      if (!res.ok) throw new Error('Failed to fetch radar signals')
      const data: RadarResponse = await res.json()
      setSignals(data.signals)
      setMetadata(data.metadata)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [maxOdds, minPosition, sinceDays, minScore, includeResolved, sortBy, hideSports])

  useEffect(() => {
    fetchSignals()
  }, [fetchSignals])

  // Fetch saved watchlist items on mount
  useEffect(() => {
    const fetchWatchlist = async () => {
      try {
        const res = await fetch('/api/watchlist')
        if (res.ok) {
          const data = await res.json()
          const keys = new Set<string>(
            data.items.map((item: { wallet: string; conditionId: string; outcome: string }) =>
              `${item.wallet.toLowerCase()}|${item.conditionId}|${item.outcome}`
            )
          )
          setSavedItems(keys)
        }
      } catch (err) {
        console.warn('[radar] Failed to fetch watchlist:', err)
      }
    }
    fetchWatchlist()
  }, [])

  // Save/unsave a signal to watchlist
  const toggleSave = async (signal: RadarSignal) => {
    const key = `${signal.wallet.toLowerCase()}|${signal.conditionId}|${signal.outcome}`
    const isSaved = savedItems.has(key)

    setSavingItems(prev => new Set(prev).add(key))

    try {
      if (isSaved) {
        // Remove from watchlist
        const params = new URLSearchParams({
          wallet: signal.wallet,
          conditionId: signal.conditionId,
          outcome: signal.outcome,
        })
        const res = await fetch(`/api/watchlist?${params}`, { method: 'DELETE' })
        if (res.ok) {
          setSavedItems(prev => {
            const next = new Set(prev)
            next.delete(key)
            return next
          })
        }
      } else {
        // Add to watchlist
        const res = await fetch('/api/watchlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            wallet: signal.wallet,
            conditionId: signal.conditionId,
            outcome: signal.outcome,
            title: signal.title,
            fillPrice: signal.fillPrice,
            positionCost: signal.positionCost,
            potentialPayout: signal.potentialPayout,
            insiderScore: signal.scores.total,
          }),
        })
        if (res.ok) {
          setSavedItems(prev => new Set(prev).add(key))
        }
      }
    } catch (err) {
      console.error('[radar] Failed to toggle save:', err)
    } finally {
      setSavingItems(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  // Sync positions from Polymarket API
  const syncPositions = useCallback(async () => {
    setSyncLoading(true)
    setSyncResult(null)
    try {
      const res = await fetch('/api/positions/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'filter',
          alertWindowHours: sinceDays * 24,
          whalesOnly: false,
          includeResolved,
          maxOdds,
          minPosition,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.success && data.result) {
          setSyncResult({ walletsSynced: data.result.walletsSynced || 0 })
          // Refetch radar to get updated data
          await fetchSignals()
        }
      }
    } catch (err) {
      console.warn('[radar] Position sync failed:', err)
    } finally {
      setSyncLoading(false)
    }
  }, [sinceDays, includeResolved, maxOdds, minPosition, fetchSignals])

  const formatTimeAgo = (timestamp: string): string => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    const diffDays = Math.floor(diffHours / 24)

    if (diffDays > 0) return `${diffDays}d ago`
    if (diffHours > 0) return `${diffHours}h ago`
    const diffMins = Math.floor(diffMs / (1000 * 60))
    return `${diffMins}m ago`
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/50">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                <span className="text-red-500">*</span>
                Long-Shot Radar
              </h1>
              <p className="text-sm text-gray-400 mt-1">
                Detecting high-conviction bets on extreme long-shots
              </p>
            </div>
            <div className="flex items-center gap-4">
              <Link
                href="/watchlist"
                className="text-sm text-yellow-400 hover:text-yellow-300"
              >
                Watchlist {savedItems.size > 0 && `(${savedItems.size})`}
              </Link>
              <Link
                href="/report"
                className="text-sm text-blue-400 hover:text-blue-300"
              >
                Back to Report
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Filters */}
      <div className="border-b border-gray-800 bg-gray-900/30">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-400">Max Odds:</label>
              <select
                value={maxOdds}
                onChange={(e) => setMaxOdds(parseFloat(e.target.value))}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm"
              >
                <option value={0.10}>10%</option>
                <option value={0.15}>15%</option>
                <option value={0.20}>20%</option>
                <option value={0.25}>25%</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-400">Min Position:</label>
              <select
                value={minPosition}
                onChange={(e) => setMinPosition(parseFloat(e.target.value))}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm"
              >
                <option value={500}>$500</option>
                <option value={1000}>$1,000</option>
                <option value={2500}>$2,500</option>
                <option value={5000}>$5,000</option>
                <option value={10000}>$10,000</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-400">Since:</label>
              <select
                value={sinceDays}
                onChange={(e) => setSinceDays(parseInt(e.target.value))}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm"
              >
                <option value={1}>24h</option>
                <option value={3}>3 days</option>
                <option value={7}>7 days</option>
                <option value={14}>14 days</option>
                <option value={30}>30 days</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-400">Min Score:</label>
              <select
                value={minScore}
                onChange={(e) => setMinScore(parseInt(e.target.value))}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm"
              >
                <option value={30}>30+</option>
                <option value={50}>50+</option>
                <option value={70}>70+</option>
                <option value={90}>90+</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-400">Sort:</label>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'score' | 'time' | 'return')}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm"
              >
                <option value="time">Newest</option>
                <option value="score">Score</option>
                <option value="return">Return</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-400">
                <input
                  type="checkbox"
                  checked={hideSports}
                  onChange={(e) => setHideSports(e.target.checked)}
                  className="mr-2"
                />
                Hide Sports
              </label>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-400">
                <input
                  type="checkbox"
                  checked={includeResolved}
                  onChange={(e) => setIncludeResolved(e.target.checked)}
                  className="mr-2"
                />
                Include Resolved
              </label>
            </div>

            <button
              onClick={syncPositions}
              disabled={syncLoading}
              className="ml-auto bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-700 px-4 py-1 rounded text-sm font-medium flex items-center gap-1"
              title="Fetch live positions from Polymarket API"
            >
              {syncLoading ? (
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
            <button
              onClick={fetchSignals}
              disabled={loading}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 px-4 py-1 rounded text-sm font-medium"
            >
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
        </div>
      </div>

      {/* Stats bar */}
      {metadata && (
        <div className="border-b border-gray-800 bg-gray-900/20">
          <div className="max-w-7xl mx-auto px-4 py-2">
            <div className="flex items-center gap-6 text-sm text-gray-400">
              <span>
                <span className="text-white font-medium">{metadata.returnedCount}</span> signals
              </span>
              <span>
                from <span className="text-white">{metadata.totalCandidates}</span> candidates
              </span>
              <span className="text-gray-600">|</span>
              <span>
                Score range: <span className="text-yellow-400">0</span> - <span className="text-red-400">{metadata.scoringModel.maxScore}</span>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        {error && (
          <div className="bg-red-900/50 border border-red-700 rounded-lg p-4 mb-6">
            <p className="text-red-400">{error}</p>
          </div>
        )}

        {loading && !signals.length ? (
          <div className="text-center py-12 text-gray-500">
            Loading radar signals...
          </div>
        ) : signals.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            No signals found matching your criteria
          </div>
        ) : (
          <div className="space-y-4">
            {signals.map((signal) => (
              <div
                key={signal.id}
                className={`border rounded-lg p-4 ${
                  signal.marketResolved
                    ? signal.winningOutcome === signal.outcome
                      ? 'border-green-700 bg-green-900/10'
                      : 'border-red-700 bg-red-900/10'
                    : signal.isSold
                      ? 'border-gray-600 bg-gray-800/30 opacity-75'
                      : 'border-gray-700 bg-gray-900/50'
                }`}
              >
                <div className="flex items-start gap-4">
                  {/* Score badge */}
                  <div className={`flex-shrink-0 w-16 h-16 rounded-lg flex flex-col items-center justify-center ${getScoreBgColor(signal.scores.total)}`}>
                    <span className={`text-2xl font-bold ${getScoreColor(signal.scores.total)}`}>
                      {signal.scores.total}
                    </span>
                    <span className="text-xs text-gray-500">/ 125</span>
                  </div>

                  {/* Main content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="font-medium text-white truncate">
                          {signal.title || 'Unknown Market'}
                        </h3>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            signal.outcome === 'Yes' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                          }`}>
                            {signal.outcome}
                          </span>
                          <span className="text-sm text-gray-400">
                            @ {signal.fillPriceFormatted}
                          </span>
                          {signal.marketResolved && (
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                              signal.winningOutcome === signal.outcome
                                ? 'bg-green-500/20 text-green-400'
                                : 'bg-red-500/20 text-red-400'
                            }`}>
                              {signal.winningOutcome === signal.outcome ? 'WON' : 'LOST'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-right text-sm">
                        <div className="text-gray-400">{formatTimeAgo(signal.fillTimestamp)}</div>
                      </div>
                    </div>

                    {/* Trade details */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
                      <div>
                        <div className="text-xs text-gray-500 flex items-center gap-1">
                          Position Cost
                          {signal.hasSyncedData && (
                            <span className="text-emerald-400" title={`Synced ${signal.syncedAt ? new Date(signal.syncedAt).toLocaleString() : ''}`}>⟳</span>
                          )}
                        </div>
                        <div className="text-sm font-medium text-white">{signal.positionCostFormatted}</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500">Current Value</div>
                        <div className="text-sm font-medium text-white">{signal.positionValueFormatted}</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500">Potential Payout</div>
                        <div className="text-sm font-medium text-green-400">{signal.potentialPayoutFormatted}</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500">Potential Return</div>
                        <div className="text-sm font-medium text-green-400">
                          {signal.potentialPayout && signal.positionCost
                            ? `${(((signal.potentialPayout / signal.positionCost) - 1) * 100).toFixed(0)}%`
                            : '-'}
                        </div>
                      </div>
                    </div>

                    {/* Wallet info */}
                    <div className="flex items-center gap-4 mt-4 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="text-gray-500">Wallet:</span>
                        <a
                          href={`https://polymarket.com/profile/${signal.wallet}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300 font-mono text-xs"
                          title={signal.wallet}
                        >
                          {`${signal.wallet.slice(0, 6)}...${signal.wallet.slice(-4)}`}
                        </a>
                        {signal.isWhale && (
                          <span className="px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded text-xs">
                            {signal.whaleLabel || 'Whale'}
                          </span>
                        )}
                        {signal.isHedger && (
                          <span className="px-1.5 py-0.5 bg-amber-500/20 text-amber-400 rounded text-xs" title="Wallet has positions on multiple outcomes of this market">
                            Hedged
                          </span>
                        )}
                        {signal.isSold && (
                          <span className="px-1.5 py-0.5 bg-gray-500/20 text-gray-400 rounded text-xs" title="Position was sold - trader exited">
                            Sold
                          </span>
                        )}
                      </div>
                      <span className="text-gray-600">|</span>
                      <span className="text-gray-400">
                        <span className="text-yellow-400">{signal.walletDaysOld}</span> days old
                      </span>
                      <span className="text-gray-600">|</span>
                      <span className="text-gray-400">
                        <span className="text-yellow-400">{signal.walletTradeCount}{signal.walletTradeCountAtLimit ? '+' : ''}</span> total trades
                      </span>
                    </div>

                    {/* Score breakdown */}
                    <div className="mt-4 p-3 bg-gray-800/50 rounded-lg">
                      <div className="text-xs text-gray-500 mb-2">Score Breakdown</div>
                      <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
                        <ScoreBar score={signal.scores.freshness} max={25} label="Fresh" />
                        <ScoreBar score={signal.scores.activity} max={25} label="Activity" />
                        <ScoreBar score={signal.scores.odds} max={25} label="Odds" />
                        <ScoreBar score={signal.scores.betSize} max={25} label="Position" />
                        <ScoreBar score={signal.scores.payout} max={25} label="Payout" />
                      </div>
                    </div>

                    {/* Links */}
                    <div className="flex items-center gap-4 mt-3 text-xs">
                      {signal.slug && (
                        <a
                          href={`https://polymarket.com/event/${signal.eventSlug || signal.slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300"
                        >
                          View Market
                        </a>
                      )}
                      <a
                        href={`https://polymarket.com/profile/${signal.wallet}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300"
                      >
                        View Profile
                      </a>
                      <button
                        onClick={() => toggleSave(signal)}
                        disabled={savingItems.has(`${signal.wallet.toLowerCase()}|${signal.conditionId}|${signal.outcome}`)}
                        className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                          savedItems.has(`${signal.wallet.toLowerCase()}|${signal.conditionId}|${signal.outcome}`)
                            ? 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30'
                            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        }`}
                      >
                        {savingItems.has(`${signal.wallet.toLowerCase()}|${signal.conditionId}|${signal.outcome}`)
                          ? '...'
                          : savedItems.has(`${signal.wallet.toLowerCase()}|${signal.conditionId}|${signal.outcome}`)
                            ? 'Saved'
                            : 'Save'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-800 mt-12">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <p className="text-center text-xs text-gray-600">
            Long-Shot Radar - Surfaces trades that look like &quot;insider&quot; activity based on wallet freshness, trade history, odds extremity, and bet conviction.
          </p>
        </div>
      </footer>
    </div>
  )
}
