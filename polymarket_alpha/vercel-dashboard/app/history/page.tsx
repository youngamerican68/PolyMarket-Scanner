'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

interface Alert {
  id: string
  wallet: string
  traderName: string
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
  positionSizeFormatted: string
  positionAvgPrice: number | null
  positionAvgPriceFormatted: string
  positionCurrentValue: number | null
  positionCurrentValueFormatted: string
  positionInitialValue: number | null
  positionInitialValueFormatted: string
  positionCashPnl: number | null
  positionCashPnlFormatted: string
  positionSnapshotAt: string | null
  thresholdValueUsed: number | null
  thresholdSource: string | null
  isWhale: boolean
  whaleLabel: string | null
  whaleTier: string | null
  whaleCategory: string | null
  createdAt: string
}

interface HistoryStats {
  totalAlerts: number
  uniqueWallets: number
  totalValue: number
  totalValueFormatted: string
  whaleAlerts: number
}

function formatDate(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function getWhaleTierEmoji(tier: string | null): string | null {
  switch (tier?.toLowerCase()) {
    case 'whale': return '🐋'
    case 'shark': return '🦈'
    case 'dolphin': return '🐬'
    default: return null
  }
}

export default function HistoryPage() {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [stats, setStats] = useState<HistoryStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)

  const fetchData = async (pageOffset: number = 0) => {
    try {
      setLoading(true)
      const res = await fetch(`/api/longshot-history?limit=500&offset=${pageOffset}`)
      if (!res.ok) throw new Error('Failed to fetch history')
      const data = await res.json()
      setAlerts(data.alerts || [])
      setStats(data.stats || null)
      setHasMore(data.pagination?.hasMore || false)
      setOffset(pageOffset)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData(0)
  }, [])

  if (loading && alerts.length === 0) {
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
              All $2.5K+ longshot alerts (position snapshots from ingestion time)
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <div className="bg-poly-card rounded-xl p-4 border border-poly-border">
              <div className="text-poly-gray text-sm">Total Alerts</div>
              <div className="text-2xl font-bold text-white">{stats.totalAlerts}</div>
            </div>
            <div className="bg-poly-card rounded-xl p-4 border border-poly-border">
              <div className="text-poly-gray text-sm">Unique Wallets</div>
              <div className="text-2xl font-bold text-white">{stats.uniqueWallets}</div>
            </div>
            <div className="bg-poly-card rounded-xl p-4 border border-poly-border">
              <div className="text-poly-gray text-sm">Total Fill Value</div>
              <div className="text-2xl font-bold text-poly-green">{stats.totalValueFormatted}</div>
            </div>
            <div className="bg-poly-card rounded-xl p-4 border border-poly-border">
              <div className="text-poly-gray text-sm">Whale Alerts</div>
              <div className="text-2xl font-bold text-purple-400">{stats.whaleAlerts}</div>
            </div>
          </div>
        )}

        {/* Trades Table */}
        <div className="bg-poly-card rounded-xl border border-poly-border overflow-hidden">
          <div className="p-4 border-b border-poly-border">
            <h2 className="text-xl font-semibold">All Historical Longshots</h2>
          </div>

          {alerts.length === 0 ? (
            <div className="p-8 text-center text-poly-gray">
              No alerts yet. History will build up as new longshots are detected.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-poly-dark/50">
                  <tr className="text-poly-gray text-xs uppercase tracking-wider">
                    <th className="p-2 text-left">Date</th>
                    <th className="p-2 text-left">Market</th>
                    <th className="p-2 text-left">Trader</th>
                    <th className="p-2 text-right">Fill Price</th>
                    <th className="p-2 text-right">Fill Value</th>
                    <th className="p-2 text-right">Pos Value</th>
                    <th className="p-2 text-right">Pos Avg Entry</th>
                    <th className="p-2 text-right">Pos Size</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-poly-border">
                  {alerts.map((alert) => (
                    <tr key={alert.id} className="hover:bg-poly-dark/30">
                      <td className="p-2 text-poly-gray text-sm whitespace-nowrap">
                        {formatDate(alert.fillTimestamp)}
                      </td>
                      <td className="p-2 max-w-xs">
                        <a
                          href={`https://polymarket.com/event/${alert.eventSlug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-white hover:text-poly-blue transition-colors block truncate"
                        >
                          {alert.title || 'Unknown'}
                        </a>
                        <div className="text-poly-gray text-xs truncate">{alert.outcome}</div>
                      </td>
                      <td className="p-2">
                        <div className="flex items-center gap-1">
                          {alert.whaleTier && (
                            <span title={`Watchlist: ${alert.whaleTier}`}>
                              {getWhaleTierEmoji(alert.whaleTier)}
                            </span>
                          )}
                          <a
                            href={`https://polymarket.com/profile/${alert.wallet}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-poly-blue hover:underline truncate"
                          >
                            {alert.traderName}
                          </a>
                        </div>
                      </td>
                      <td className="p-2 text-right text-amber-400">
                        {alert.fillPriceFormatted}
                      </td>
                      <td className="p-2 text-right text-poly-green font-medium">
                        {alert.fillValueFormatted}
                      </td>
                      <td className="p-2 text-right text-white font-medium">
                        {alert.positionCurrentValueFormatted}
                      </td>
                      <td className="p-2 text-right text-poly-muted">
                        {alert.positionAvgPriceFormatted}
                      </td>
                      <td className="p-2 text-right text-poly-muted">
                        {alert.positionSizeFormatted}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {(offset > 0 || hasMore) && (
            <div className="p-4 border-t border-poly-border flex justify-between items-center">
              <button
                onClick={() => fetchData(Math.max(0, offset - 500))}
                disabled={offset === 0 || loading}
                className="px-4 py-2 bg-poly-border rounded disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-poly-gray">
                Showing {offset + 1} - {offset + alerts.length}
              </span>
              <button
                onClick={() => fetchData(offset + 500)}
                disabled={!hasMore || loading}
                className="px-4 py-2 bg-poly-border rounded disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          )}
        </div>

        {/* Footer note */}
        <div className="text-center text-poly-gray text-sm mt-6 space-y-1">
          <p>Phase 1: High-accuracy data from alert_events</p>
          <p className="text-xs">
            Position values are snapshots from ingestion time (not live)
          </p>
        </div>
      </div>
    </main>
  )
}
