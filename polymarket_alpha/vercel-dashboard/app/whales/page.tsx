'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

interface WhaleTrade {
  id: string
  wallet: string
  name: string
  tier: string
  category: string
  profit: string
  livePnL: number | null  // Live P/L from Polymarket profile
  marketId: string
  eventSlug: string
  title: string
  outcome: string
  timestamp: number
  entryPrice: number
  curPrice: number
  size: number
  value: number
  position: number
  potential: number
  plPercent: number
  inferredStatus: 'likely_won' | 'likely_lost' | 'holding'
  createdAt: string
}

interface WhaleData {
  trades: WhaleTrade[]
  stats: {
    totalTrades: number
    uniqueWhales: number
    totalValue: number
    whaleTrades: number
    sharkTrades: number
    dolphinTrades: number
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
    minValue: number | null
    maxValue: number | null
  }
  timestamp: string
}

function formatTimeAgo(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - timestamp

  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) {
    const hours = Math.floor(diff / 3600)
    const mins = Math.floor((diff % 3600) / 60)
    return mins > 0 ? `${hours}h ${mins}m ago` : `${hours}h ago`
  }
  const days = Math.floor(diff / 86400)
  const hours = Math.floor((diff % 86400) / 3600)
  return hours > 0 ? `${days}d ${hours}h ago` : `${days}d ago`
}

function formatCurrency(value: number): string {
  if (value >= 1000000) return `$${(value / 1000000).toFixed(1)}M`
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}K`
  return `$${value.toFixed(0)}`
}

function getTierEmoji(tier: string): string {
  switch (tier?.toLowerCase()) {
    case 'whale': return '🐋'
    case 'shark': return '🦈'
    case 'dolphin': return '🐬'
    default: return '🐟'
  }
}

function getTierColor(tier: string): string {
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
  const [sizeFilter, setSizeFilter] = useState<string>('') // Trade size filter

  useEffect(() => {
    async function fetchData() {
      setLoading(true)
      try {
        const params = new URLSearchParams()
        if (tierFilter) params.set('tier', tierFilter)
        if (categoryFilter) params.set('category', categoryFilter)
        // Parse size filter into minValue/maxValue
        if (sizeFilter) {
          const [min, max] = sizeFilter.split('-')
          if (min) params.set('minValue', min)
          if (max) params.set('maxValue', max)
        }
        params.set('_t', Date.now().toString()) // Cache buster

        const url = `/api/whale-trades?${params.toString()}`
        const res = await fetch(url, { cache: 'no-store' })

        if (!res.ok) {
          const errData = await res.json()
          throw new Error(errData.error || 'Failed to fetch whale data')
        }

        const json = await res.json()
        // Debug: log raw response
        console.log("WHALE API RESPONSE:", JSON.stringify({
          _apiVersion: json._apiVersion,
          _rawTotal: json._rawTotal,
          watchlistTotal: json.watchlist?.total,
          fullWatchlist: json.watchlist
        }))
        setData(json)
        setError(null)
      } catch (err) {
        setError(String(err))
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [tierFilter, categoryFilter, sizeFilter])

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
              Tracking longshot trades from top Polymarket traders
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
              {formatCurrency(data?.stats.totalValue || 0)}
            </div>
          </div>
          <div className="bg-poly-card border border-poly-border rounded-lg p-4">
            <div className="text-poly-muted text-xs uppercase tracking-wider mb-1">By Tier</div>
            <div className="flex items-center gap-3 text-sm">
              <span className="text-purple-400">🐋 {data?.stats.whaleTrades || 0}</span>
              <span className="text-blue-400">🦈 {data?.stats.sharkTrades || 0}</span>
              <span className="text-cyan-400">🐬 {data?.stats.dolphinTrades || 0}</span>
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
          <div>
            <label className="text-poly-muted text-xs uppercase tracking-wider block mb-1">
              Trade Size
            </label>
            <select
              value={sizeFilter}
              onChange={(e) => setSizeFilter(e.target.value)}
              className="bg-poly-dark border border-poly-border rounded px-3 py-2 text-sm"
            >
              <option value="">All Sizes</option>
              <option value="100-">$100+</option>
              <option value="500-">$500+</option>
              <option value="1000-">$1K+</option>
              <option value="1000-5000">$1K - $5K</option>
              <option value="5000-">$5K+</option>
            </select>
          </div>
        </div>

        {/* Trades Table */}
        <div className="bg-poly-card border border-poly-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full table-fixed">
              <thead className="bg-poly-dark/50">
                <tr className="text-poly-muted text-xs uppercase tracking-wider">
                  <th className="p-3 text-left w-[100px]">Time</th>
                  <th className="p-3 text-left">Market</th>
                  <th className="p-3 text-left w-[140px]">Trader</th>
                  <th className="p-3 text-center w-[80px]">Tier</th>
                  <th className="p-3 text-right w-[60px]">Odds</th>
                  <th className="p-3 text-right w-[80px]">Bet</th>
                  <th className="p-3 text-right w-[80px]">Position</th>
                  <th className="p-3 text-right w-[80px]">Potential</th>
                  <th className="p-3 text-center w-[80px]">Status</th>
                </tr>
              </thead>
              <tbody>
                {data?.trades && data.trades.length > 0 ? (
                  data.trades.map((trade) => (
                    <tr
                      key={trade.id}
                      className="border-t border-poly-border hover:bg-poly-dark/30 transition-colors"
                    >
                      <td className="p-3 text-poly-muted text-sm">
                        {formatTimeAgo(trade.timestamp)}
                      </td>
                      <td className="p-3">
                        <a
                          href={`https://polymarket.com/event/${trade.eventSlug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-poly-blue hover:underline text-sm truncate block"
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
                          className="text-poly-green hover:underline text-sm truncate block"
                        >
                          {trade.name || trade.wallet.slice(0, 10) + '...'}
                        </a>
                        <span className={`text-xs ${trade.livePnL !== null ? (trade.livePnL >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-poly-muted'}`}>
                          {trade.livePnL !== null
                            ? `${trade.livePnL >= 0 ? '+' : ''}$${Math.abs(trade.livePnL).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                            : trade.profit}
                        </span>
                      </td>
                      <td className="p-3 text-center">
                        <span className={`${getTierColor(trade.tier)} text-lg`}>
                          {getTierEmoji(trade.tier)}
                        </span>
                        <span className="text-poly-muted text-xs block capitalize">
                          {trade.tier}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <span className="text-poly-yellow font-mono text-sm">
                          {(trade.entryPrice * 100).toFixed(0)}%
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <span className="text-poly-text font-mono text-sm">
                          {formatCurrency(trade.value)}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <span className="text-poly-muted font-mono text-sm">
                          {formatCurrency(trade.position)}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <span className="text-poly-blue font-mono text-sm">
                          {formatCurrency(trade.potential)}
                        </span>
                      </td>
                      <td className="p-3 text-center text-xs">
                        {trade.inferredStatus === 'likely_lost' && (
                          <span className="text-red-400" title="Price near zero - likely lost">📉 Likely Lost</span>
                        )}
                        {trade.inferredStatus === 'likely_won' && (
                          <span className="text-emerald-400" title="Price near 100% - likely won">📈 Likely Won</span>
                        )}
                        {trade.inferredStatus === 'holding' && (
                          <span className="text-poly-muted">⏳ Holding</span>
                        )}
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
          Last updated: {data?.timestamp ? new Date(data.timestamp).toLocaleString() : 'N/A'}
          {' | '}API: {(data as any)?._apiVersion || 'unknown'}
          {' | '}Raw: {String((data as any)?._rawTotal || 'N/A')}
        </div>
      </div>
    </div>
  )
}
