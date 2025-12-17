'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

interface Alert {
  id: string
  fillTimestamp: string
  wallet: string
  traderName: string
  title: string
  outcome: string
  eventSlug: string | null
  // Fill data
  fillPrice: number
  fillPriceFormatted: string
  fillSize: number
  fillValueUsd: number
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
  positionSnapshotAt: string | null
  potentialWin: number | null
  potentialWinFormatted: string
  // Threshold info
  thresholdValueUsed: number | null
  thresholdSource: string | null
  // Whale metadata
  isWhale: boolean
  whaleLabel: string | null
  whaleTier: string | null
  whaleCategory: string | null
}

interface ReportData {
  summary: {
    totalAlerts: number
    whaleAlerts: number
    uniqueWallets: number
    totalValue: number
    totalValueFormatted: string
    totalPotential: number
    totalPotentialFormatted: string
    hoursOfData: number
    dataStartTime: string | null
    dataEndTime: string | null
  }
  topLongshots: Alert[]
  whaleTrades: Alert[]
  allAlerts: Alert[]
}

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

type SortField = 'fillPrice' | 'fillValue' | 'positionValue' | 'time'
type SortDirection = 'asc' | 'desc'

export default function ReportPage() {
  const [report, setReport] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [sortField, setSortField] = useState<SortField>('time')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [hoursFilter, setHoursFilter] = useState(24)

  const fetchReport = async () => {
    try {
      setLoading(true)
      const res = await fetch(`/api/daily-report?hours=${hoursFilter}`)
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
    fetchReport()
    const interval = setInterval(fetchReport, 10 * 60 * 1000)
    return () => clearInterval(interval)
  }, [hoursFilter])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection(field === 'fillPrice' ? 'asc' : 'desc')
    }
  }

  const getSortedAlerts = (alerts: Alert[]) => {
    return [...alerts].sort((a, b) => {
      let aVal: number, bVal: number
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
          aVal = a.positionCurrentValue ?? 0
          bVal = b.positionCurrentValue ?? 0
          break
        case 'time':
          aVal = new Date(a.fillTimestamp).getTime()
          bVal = new Date(b.fillTimestamp).getTime()
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
        <h1 className="text-2xl font-bold">Daily Longshot Report</h1>
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
        <h1 className="text-2xl font-bold">Daily Longshot Report</h1>
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

  const s = report.summary

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="space-y-2">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold">Daily Longshot Report</h1>
            <p className="text-poly-muted text-sm">
              Longshot bets (&lt;25% odds) with $2.5K+ position value
            </p>
            {s.hoursOfData < hoursFilter && (
              <p className="text-amber-400 text-xs mt-1">
                Data coverage: {s.hoursOfData.toFixed(1)}h of {hoursFilter}h
              </p>
            )}
          </div>
          <div className="text-right flex items-center gap-3">
            <select
              value={hoursFilter}
              onChange={(e) => setHoursFilter(Number(e.target.value))}
              className="bg-poly-card border border-poly-border rounded px-3 py-2 text-sm"
            >
              <option value={12}>Last 12h</option>
              <option value={24}>Last 24h</option>
              <option value={48}>Last 48h</option>
              <option value={168}>Last 7d</option>
            </select>
            <Link
              href="/history"
              className="px-4 py-2 bg-poly-card border border-poly-border text-white font-medium rounded hover:bg-poly-border transition-colors"
            >
              View History
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
        {lastUpdate && (
          <p className="text-xs text-poly-muted">
            Last refresh: {lastUpdate.toLocaleTimeString()}
          </p>
        )}
      </header>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
          <p className="text-poly-muted text-sm">Total Alerts</p>
          <p className="text-2xl font-bold">{s.totalAlerts.toLocaleString()}</p>
        </div>
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
          <p className="text-poly-muted text-sm">Whale Alerts</p>
          <p className="text-2xl font-bold text-purple-400">{s.whaleAlerts}</p>
        </div>
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
          <p className="text-poly-muted text-sm">Unique Wallets</p>
          <p className="text-2xl font-bold">{s.uniqueWallets}</p>
        </div>
        <div className="bg-poly-card rounded-lg p-4 border border-poly-border">
          <p className="text-poly-muted text-sm">Total Fill Value</p>
          <p className="text-2xl font-bold text-poly-green">{s.totalValueFormatted}</p>
        </div>
      </div>

      {/* Whale Trades Section */}
      {report.whaleTrades.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-xl font-bold flex items-center">
            <span className="w-3 h-3 bg-purple-500 rounded-full mr-3"></span>
            Whale Trades
            <span className="text-sm font-normal text-poly-muted ml-2">({report.whaleTrades.length})</span>
          </h2>
          <div className="bg-poly-card rounded-lg border border-poly-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-poly-border">
                  <tr>
                    <th className="text-left p-3 text-poly-muted font-medium">Whale</th>
                    <th className="text-left p-3 text-poly-muted font-medium">Market</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Fill Price</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Fill Value</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Position Value</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Pos Avg Entry</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Potential Win</th>
                    <th className="text-right p-3 text-poly-muted font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {report.whaleTrades.slice(0, 20).map((alert) => (
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
                            {alert.whaleLabel || alert.traderName}
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
                          {alert.title?.slice(0, 40)}
                        </a>
                        <span className="text-poly-muted ml-2">({alert.outcome})</span>
                      </td>
                      <td className="p-3 text-right text-poly-yellow">{alert.fillPriceFormatted}</td>
                      <td className="p-3 text-right text-poly-green">{alert.fillValueFormatted}</td>
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

      {/* Top Longshot Trades Table */}
      <section className="space-y-4">
        <h2 className="text-xl font-bold">Top Longshot Trades</h2>
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
                  <th className="text-right p-3 text-poly-muted font-medium" title="Position size in shares">
                    Pos Size
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
                  const sortedAlerts = getSortedAlerts(report.topLongshots)
                  if (sortedAlerts.length === 0) {
                    return (
                      <tr>
                        <td className="p-4 text-center text-poly-muted" colSpan={9}>
                          No longshot alerts found in this time period.
                        </td>
                      </tr>
                    )
                  }
                  return sortedAlerts.map((alert) => (
                    <tr key={alert.id} className="border-t border-poly-border hover:bg-poly-border/30">
                      <td className="p-3 max-w-xs truncate">
                        <a
                          href={`https://polymarket.com/event/${alert.eventSlug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-poly-blue hover:underline"
                        >
                          {alert.title?.slice(0, 40)}
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
                          {alert.traderName}
                        </a>
                      </td>
                      <td className="p-3 text-right text-poly-yellow">{alert.fillPriceFormatted}</td>
                      <td className="p-3 text-right text-poly-green">{alert.fillValueFormatted}</td>
                      <td className="p-3 text-right text-white font-medium">{alert.positionCurrentValueFormatted}</td>
                      <td className="p-3 text-right text-poly-muted">{alert.positionAvgPriceFormatted}</td>
                      <td className="p-3 text-right text-poly-muted">{alert.positionSizeFormatted}</td>
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
          <div className="px-3 py-2 border-t border-poly-border text-xs text-poly-muted">
            Showing {Math.min(report.topLongshots.length, 50)} of {report.allAlerts.length} alerts
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="text-center text-poly-muted text-sm py-4 border-t border-poly-border">
        <p>Phase 1: High-accuracy data from alert_events</p>
        <p className="mt-1">Position values are snapshots from ingestion time</p>
      </footer>
    </div>
  )
}
