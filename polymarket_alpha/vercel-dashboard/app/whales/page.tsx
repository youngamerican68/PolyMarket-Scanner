'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

interface WhaleTrade {
  id: string
  wallet: string
  traderName: string
  tier: string | null
  category: string | null
  whaleLabel: string | null
  conditionId: string
  eventSlug: string | null
  title: string
  outcome: string
  fillTimestamp: string
  fillPrice: number
  fillPriceFormatted: string
  fillSize: number
  fillValueUsd: number
  fillValueFormatted: string
  positionSize: number | null
  positionAvgPrice: number | null
  positionAvgPriceFormatted: string
  positionCurrentValue: number | null
  positionCurrentValueFormatted: string
  positionInitialValue: number | null
  positionInitialValueFormatted: string
  positionCashPnl: number | null
  positionCashPnlFormatted: string
  positionSnapshotAt: string | null
  potentialWin: number | null
  potentialWinFormatted: string
}

interface WhaleData {
  trades: WhaleTrade[]
  stats: {
    totalTrades: number
    uniqueWhales: number
    totalValue: number
    totalValueFormatted: string
    whaleTierCount: number
    sharkTierCount: number
    dolphinTierCount: number
  }
  watchlist: {
    total: number
    withWallet: number
    pendingWallet: number
    whales: number
    sharks: number
    dolphins: number
  }
  filters: {
    tier: string | null
    category: string | null
  }
  timestamp: string
}

function formatTimeAgo(timestamp: string): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))

  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) {
    const mins = diffMins % 60
    return mins > 0 ? `${diffHours}h ${mins}m ago` : `${diffHours}h ago`
  }
  const days = Math.floor(diffHours / 24)
  const hours = diffHours % 24
  return hours > 0 ? `${days}d ${hours}h ago` : `${days}d ago`
}

function getTierEmoji(tier: string | null): string {
  switch (tier?.toLowerCase()) {
    case 'whale': return '🐋'
    case 'shark': return '🦈'
    case 'dolphin': return '🐬'
    default: return '🐟'
  }
}

function getTierColor(tier: string | null): string {
  switch (tier?.toLowerCase()) {
    case 'whale': return 'text-purple-400'
    case 'shark': return 'text-blue-400'
    case 'dolphin': return 'text-cyan-400'
    default: return 'text-gray-400'
  }
}

export default function WhalesPage() {
  const [data, setData] = useState<WhaleData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tierFilter, setTierFilter] = useState<string>('')
  const [categoryFilter, setCategoryFilter] = useState<string>('')

  useEffect(() => {
    async function fetchData() {
      setLoading(true)
      try {
        const params = new URLSearchParams()
        if (tierFilter) params.set('tier', tierFilter)
        if (categoryFilter) params.set('category', categoryFilter)
        params.set('_t', Date.now().toString())

        const url = `/api/whale-trades?${params.toString()}`
        const res = await fetch(url, { cache: 'no-store' })

        if (!res.ok) {
          const errData = await res.json()
          throw new Error(errData.error || 'Failed to fetch whale data')
        }

        const json = await res.json()
        setData(json)
        setError(null)
      } catch (err) {
        setError(String(err))
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [tierFilter, categoryFilter])

  if (loading) {
    return (
      <div className="min-h-screen bg-poly-bg flex items-center justify-center">
        <div className="text-poly-muted">Loading whale data...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-poly-bg p-8">
        <div className="max-w-7xl mx-auto">
          <div className="bg-red-900/20 border border-red-500/50 rounded-lg p-4 text-red-400">
            Error: {error}
          </div>
          <Link href="/report" className="text-poly-blue hover:underline mt-4 inline-block">
            ← Back to Report
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-poly-bg text-poly-text p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              🐋 Whale Watchlist
            </h1>
            <p className="text-poly-muted text-sm mt-1">
              Tracking longshot trades from whale watchlist
            </p>
          </div>
          <Link
            href="/report"
            className="text-poly-blue hover:underline text-sm"
          >
            ← Back to Report
          </Link>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-poly-card border border-poly-border rounded-lg p-4">
            <div className="text-poly-muted text-xs uppercase tracking-wider mb-1">Whales Tracked</div>
            <div className="text-2xl font-bold">{data?.watchlist.total || 0}</div>
            <div className="text-poly-muted text-xs mt-1">
              {data?.watchlist.withWallet || 0} linked / {data?.watchlist.pendingWallet || 0} pending
            </div>
          </div>
          <div className="bg-poly-card border border-poly-border rounded-lg p-4">
            <div className="text-poly-muted text-xs uppercase tracking-wider mb-1">Total Trades</div>
            <div className="text-2xl font-bold">{data?.stats.totalTrades || 0}</div>
            <div className="text-poly-muted text-xs mt-1">
              from {data?.stats.uniqueWhales || 0} unique whales
            </div>
          </div>
          <div className="bg-poly-card border border-poly-border rounded-lg p-4">
            <div className="text-poly-muted text-xs uppercase tracking-wider mb-1">Total Volume</div>
            <div className="text-2xl font-bold text-poly-green">
              {data?.stats.totalValueFormatted || 'N/A'}
            </div>
          </div>
          <div className="bg-poly-card border border-poly-border rounded-lg p-4">
            <div className="text-poly-muted text-xs uppercase tracking-wider mb-1">By Tier</div>
            <div className="flex items-center gap-3 text-sm">
              <span className="text-purple-400">🐋 {data?.stats.whaleTierCount || 0}</span>
              <span className="text-blue-400">🦈 {data?.stats.sharkTierCount || 0}</span>
              <span className="text-cyan-400">🐬 {data?.stats.dolphinTierCount || 0}</span>
            </div>
          </div>
        </div>

        {/* Watchlist Breakdown */}
        <div className="bg-poly-card border border-poly-border rounded-lg p-4 mb-8">
          <h2 className="text-lg font-semibold mb-3">Watchlist Breakdown</h2>
          <div className="flex flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <span className="text-purple-400 text-xl">🐋</span>
              <span className="text-poly-muted">Whales:</span>
              <span className="font-bold">{data?.watchlist.whales || 0}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-blue-400 text-xl">🦈</span>
              <span className="text-poly-muted">Sharks:</span>
              <span className="font-bold">{data?.watchlist.sharks || 0}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-cyan-400 text-xl">🐬</span>
              <span className="text-poly-muted">Dolphins:</span>
              <span className="font-bold">{data?.watchlist.dolphins || 0}</span>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-4 mb-6">
          <div>
            <label className="text-poly-muted text-xs uppercase tracking-wider block mb-1">
              Tier
            </label>
            <select
              value={tierFilter}
              onChange={(e) => setTierFilter(e.target.value)}
              className="bg-poly-dark border border-poly-border rounded px-3 py-2 text-sm"
            >
              <option value="">All Tiers</option>
              <option value="whale">🐋 Whale</option>
              <option value="shark">🦈 Shark</option>
              <option value="dolphin">🐬 Dolphin</option>
            </select>
          </div>
          <div>
            <label className="text-poly-muted text-xs uppercase tracking-wider block mb-1">
              Category
            </label>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="bg-poly-dark border border-poly-border rounded px-3 py-2 text-sm"
            >
              <option value="">All Categories</option>
              <option value="sports">Sports</option>
              <option value="crypto">Crypto</option>
              <option value="politics">Politics</option>
              <option value="culture">Culture</option>
              <option value="tech">Tech</option>
              <option value="economics">Economics</option>
            </select>
          </div>
        </div>

        {/* Trades Table */}
        <div className="bg-poly-card border border-poly-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-poly-dark/50">
                <tr className="text-poly-muted text-xs uppercase tracking-wider">
                  <th className="p-3 text-left">Time</th>
                  <th className="p-3 text-left">Market</th>
                  <th className="p-3 text-left">Trader</th>
                  <th className="p-3 text-center">Tier</th>
                  <th className="p-3 text-right">Fill Price</th>
                  <th className="p-3 text-right">Fill Value</th>
                  <th className="p-3 text-right">Pos Value</th>
                  <th className="p-3 text-right">Pos Avg Entry</th>
                  <th className="p-3 text-right">Potential Win</th>
                </tr>
              </thead>
              <tbody>
                {data?.trades && data.trades.length > 0 ? (
                  data.trades.map((trade) => (
                    <tr
                      key={trade.id}
                      className="border-t border-poly-border hover:bg-poly-dark/30 transition-colors"
                    >
                      <td className="p-3 text-poly-muted text-sm whitespace-nowrap">
                        {formatTimeAgo(trade.fillTimestamp)}
                      </td>
                      <td className="p-3 max-w-xs">
                        <a
                          href={`https://polymarket.com/event/${trade.eventSlug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-poly-blue hover:underline text-sm block truncate"
                          title={trade.title}
                        >
                          {trade.title?.slice(0, 50)}{trade.title?.length > 50 ? '...' : ''}
                        </a>
                        <span className="text-poly-muted text-xs">{trade.outcome}</span>
                      </td>
                      <td className="p-3">
                        <a
                          href={`https://polymarket.com/profile/${trade.wallet}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-poly-green hover:underline text-sm block truncate"
                        >
                          {trade.whaleLabel || trade.traderName}
                        </a>
                      </td>
                      <td className="p-3 text-center">
                        <span className={`${getTierColor(trade.tier)} text-lg`}>
                          {getTierEmoji(trade.tier)}
                        </span>
                        <span className="text-poly-muted text-xs block capitalize">
                          {trade.tier || '—'}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <span className="text-poly-yellow font-mono text-sm">
                          {trade.fillPriceFormatted}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <span className="text-poly-green font-mono text-sm">
                          {trade.fillValueFormatted}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <span className="text-white font-mono text-sm font-medium">
                          {trade.positionCurrentValueFormatted}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <span className="text-poly-muted font-mono text-sm">
                          {trade.positionAvgPriceFormatted}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <span className="text-amber-400 font-mono text-sm font-medium">
                          {trade.potentialWinFormatted}
                        </span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={9} className="p-8 text-center text-poly-muted">
                      No whale trades found. Add wallets to the watchlist to start tracking.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center text-poly-muted text-xs mt-8">
          <p>Phase 1: High-accuracy data from alert_events</p>
          <p className="mt-1">
            Last updated: {data?.timestamp ? new Date(data.timestamp).toLocaleString() : 'N/A'}
          </p>
        </div>
      </div>
    </div>
  )
}
