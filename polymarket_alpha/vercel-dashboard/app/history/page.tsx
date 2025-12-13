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
}

interface HistoryStats {
  totalTrades: number
  uniqueWallets: number
  totalValue: number
  resolvedCount: number
  wonCount: number
  winRate: string | null
}

interface HistoryData {
  trades: HistoricalTrade[]
  stats: HistoryStats
  timestamp: string
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
  const [data, setData] = useState<HistoryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchHistory() {
      try {
        const res = await fetch('/api/longshot-history', { cache: 'no-store' })
        if (!res.ok) throw new Error('Failed to fetch history')
        const json = await res.json()
        setData(json)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }
    fetchHistory()
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-poly-dark flex items-center justify-center">
        <div className="text-white text-xl">Loading history...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-poly-dark flex items-center justify-center">
        <div className="text-red-500 text-xl">Error: {error}</div>
      </div>
    )
  }

  if (!data) return null

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
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
          <div className="bg-poly-card rounded-xl p-4 border border-poly-border">
            <div className="text-poly-gray text-sm">Total Trades</div>
            <div className="text-2xl font-bold text-white">{data.stats.totalTrades}</div>
          </div>
          <div className="bg-poly-card rounded-xl p-4 border border-poly-border">
            <div className="text-poly-gray text-sm">Unique Wallets</div>
            <div className="text-2xl font-bold text-white">{data.stats.uniqueWallets}</div>
          </div>
          <div className="bg-poly-card rounded-xl p-4 border border-poly-border">
            <div className="text-poly-gray text-sm">Total Value</div>
            <div className="text-2xl font-bold text-poly-green">{formatMoney(data.stats.totalValue)}</div>
          </div>
          <div className="bg-poly-card rounded-xl p-4 border border-poly-border">
            <div className="text-poly-gray text-sm">Resolved</div>
            <div className="text-2xl font-bold text-white">{data.stats.resolvedCount}</div>
          </div>
          <div className="bg-poly-card rounded-xl p-4 border border-poly-border">
            <div className="text-poly-gray text-sm">Win Rate</div>
            <div className="text-2xl font-bold text-poly-blue">
              {data.stats.winRate ? `${data.stats.winRate}%` : 'N/A'}
            </div>
          </div>
        </div>

        {/* Trades Table */}
        <div className="bg-poly-card rounded-xl border border-poly-border overflow-hidden">
          <div className="p-4 border-b border-poly-border">
            <h2 className="text-xl font-semibold">All Historical Longshots</h2>
          </div>

          {data.trades.length === 0 ? (
            <div className="p-8 text-center text-poly-gray">
              No trades yet. History will build up as new $5K+ longshots are detected.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-poly-dark/50">
                  <tr className="text-poly-gray text-xs uppercase tracking-wider">
                    <th className="p-3 text-left">Date</th>
                    <th className="p-3 text-left">Market</th>
                    <th className="p-3 text-left">Trader</th>
                    <th className="p-3 text-right">Odds</th>
                    <th className="p-3 text-right">Value</th>
                    <th className="p-3 text-center">Status</th>
                    <th className="p-3 text-right">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-poly-border">
                  {data.trades.map((trade) => (
                    <tr key={trade.id} className="hover:bg-poly-dark/30">
                      <td className="p-3 text-poly-gray text-sm">
                        {formatDate(trade.timestamp)}
                      </td>
                      <td className="p-3">
                        <a
                          href={`https://polymarket.com/event/${trade.eventSlug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-white hover:text-poly-blue transition-colors"
                        >
                          {trade.title?.slice(0, 40) || 'Unknown'}
                          {trade.title && trade.title.length > 40 ? '...' : ''}
                        </a>
                        <div className="text-poly-gray text-xs">{trade.outcome}</div>
                      </td>
                      <td className="p-3">
                        <a
                          href={`https://polymarket.com/profile/${trade.wallet}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-poly-blue hover:underline"
                        >
                          {trade.name || trade.wallet.slice(0, 10) + '...'}
                        </a>
                      </td>
                      <td className="p-3 text-right text-amber-400">
                        {(trade.price * 100).toFixed(1)}%
                      </td>
                      <td className="p-3 text-right text-poly-green font-medium">
                        {formatMoney(trade.value)}
                      </td>
                      <td className="p-3 text-center">
                        {trade.resolved ? (
                          <span className="text-poly-gray">Settled</span>
                        ) : (
                          <span className="text-amber-400">Pending</span>
                        )}
                      </td>
                      <td className="p-3 text-right">
                        {trade.resolved ? (
                          trade.won ? (
                            <span className="text-poly-green font-medium">
                              Won {trade.pnl ? formatMoney(trade.pnl) : ''}
                            </span>
                          ) : (
                            <span className="text-red-500">Lost</span>
                          )
                        ) : (
                          <span className="text-poly-gray">-</span>
                        )}
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
          Tracking started {new Date().toLocaleDateString()}. Historical data builds up over time.
        </p>
      </div>
    </main>
  )
}
