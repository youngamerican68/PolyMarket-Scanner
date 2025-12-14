'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

interface HistoricalTrade {
  id: string
  wallet: string
  name: string
  marketId: string
  eventSlug: string
  title: string
  outcome: string
  timestamp: number
  price: number
  size: number
  value: number
  resolved: boolean
  won: boolean | null
  pnl: number | null
  curPrice: number
  position: number
  potential: number
  inferredStatus: 'pending' | 'likely_lost' | 'likely_won'
}

interface HistoryStats {
  totalTrades: number
  uniqueWallets: number
  totalValue: number
  resolvedCount: number
  wonCount: number
  winRate: string | null
}

function formatMoney(value: number): string {
  if (value >= 1000000) return `$${(value / 1000000).toFixed(1)}M`
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}K`
  return `$${value.toFixed(0)}`
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function HistoryPage() {
  const [trades, setTrades] = useState<HistoricalTrade[]>([])
  const [stats, setStats] = useState<HistoryStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch('/api/longshot-history')
        if (!res.ok) throw new Error('Failed to fetch history')
        const data = await res.json()
        setTrades(data.trades || [])
        setStats(data.stats || null)
      } catch (err) {
        setError(String(err))
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [])

  if (loading) {
    return (
      <main className="min-h-screen bg-poly-dark text-white p-8 flex items-center justify-center">
        <div className="text-xl">Loading history...</div>
      </main>
    )
  }

  if (error) {
    return (
      <main className="min-h-screen bg-poly-dark text-white p-8 flex items-center justify-center">
        <div className="text-red-500">Error: {error}</div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-poly-dark text-white p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold">Longshot History</h1>
            <p className="text-poly-gray mt-1">
              All $5K+ longshot trades (never pruned)
            </p>
          </div>
          <Link
            href="/report"
            className="bg-poly-card border border-poly-border px-4 py-2 rounded-lg hover:bg-poly-border transition-colors"
          >
            Back to Daily Report
          </Link>
        </div>

        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
            <div className="bg-poly-card rounded-xl p-4 border border-poly-border">
              <div className="text-poly-gray text-sm">Total Trades</div>
              <div className="text-2xl font-bold text-white">{stats.totalTrades}</div>
            </div>
            <div className="bg-poly-card rounded-xl p-4 border border-poly-border">
              <div className="text-poly-gray text-sm">Unique Wallets</div>
              <div className="text-2xl font-bold text-white">{stats.uniqueWallets}</div>
            </div>
            <div className="bg-poly-card rounded-xl p-4 border border-poly-border">
              <div className="text-poly-gray text-sm">Total Value</div>
              <div className="text-2xl font-bold text-poly-green">{formatMoney(stats.totalValue)}</div>
            </div>
            <div className="bg-poly-card rounded-xl p-4 border border-poly-border">
              <div className="text-poly-gray text-sm">Resolved</div>
              <div className="text-2xl font-bold text-white">{stats.resolvedCount}</div>
            </div>
            <div className="bg-poly-card rounded-xl p-4 border border-poly-border">
              <div className="text-poly-gray text-sm">Win Rate</div>
              <div className="text-2xl font-bold text-poly-blue">
                {stats.winRate ? `${stats.winRate}%` : 'N/A'}
              </div>
            </div>
          </div>
        )}

        {/* Trades Table */}
        <div className="bg-poly-card rounded-xl border border-poly-border overflow-hidden">
          <div className="p-4 border-b border-poly-border">
            <h2 className="text-xl font-semibold">All Historical Longshots</h2>
          </div>

          {trades.length === 0 ? (
            <div className="p-8 text-center text-poly-gray">
              No trades yet. History will build up as new $5K+ longshots are detected.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full table-fixed">
                <thead className="bg-poly-dark/50">
                  <tr className="text-poly-gray text-xs uppercase tracking-wider">
                    <th className="p-2 text-left w-[100px]">Date</th>
                    <th className="p-2 text-left">Market</th>
                    <th className="p-2 text-left w-[120px]">Trader</th>
                    <th className="p-2 text-center w-[80px]">Status</th>
                    <th className="p-2 text-right w-[60px]">Odds</th>
                    <th className="p-2 text-right w-[70px]">Bet</th>
                    <th className="p-2 text-right w-[80px]">Position</th>
                    <th className="p-2 text-right w-[80px]">Potential</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-poly-border">
                  {trades.map((trade) => (
                    <tr key={trade.id} className="hover:bg-poly-dark/30">
                      <td className="p-2 text-poly-gray text-sm">
                        {formatDate(trade.timestamp)}
                      </td>
                      <td className="p-2">
                        <a
                          href={`https://polymarket.com/event/${trade.eventSlug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-white hover:text-poly-blue transition-colors block truncate"
                        >
                          {trade.title || 'Unknown'}
                        </a>
                        <div className="text-poly-gray text-xs truncate">{trade.outcome}</div>
                      </td>
                      <td className="p-2">
                        <a
                          href={`https://polymarket.com/profile/${trade.wallet}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-poly-blue hover:underline block truncate"
                        >
                          {trade.name || trade.wallet.slice(0, 10) + '...'}
                        </a>
                      </td>
                      <td className="p-2 text-center">
                        {trade.inferredStatus === 'likely_lost' && (
                          <span className="text-red-400" title="Position value crashed - likely lost">📉 Lost</span>
                        )}
                        {trade.inferredStatus === 'likely_won' && (
                          <span className="text-emerald-400" title="Position value surged - likely won">📈 Won</span>
                        )}
                        {trade.inferredStatus === 'pending' && (
                          <span className="text-poly-green">Holding</span>
                        )}
                      </td>
                      <td className="p-2 text-right text-amber-400">
                        {(trade.price * 100).toFixed(1)}%
                      </td>
                      <td className="p-2 text-right text-poly-green font-medium">
                        {formatMoney(trade.value)}
                      </td>
                      <td className="p-2 text-right text-white font-medium">
                        {formatMoney(trade.position)}
                      </td>
                      <td className="p-2 text-right text-poly-blue">
                        {formatMoney(trade.potential)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer note */}
        <p className="text-center text-poly-gray text-sm mt-6">
          Position and Potential values are calculated from current market prices.
        </p>
      </div>
    </main>
  )
}
