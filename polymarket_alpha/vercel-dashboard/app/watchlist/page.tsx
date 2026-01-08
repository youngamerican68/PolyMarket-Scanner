'use client'

import React, { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'

interface WatchlistItem {
  id: number
  wallet: string
  conditionId: string
  outcome: string
  title: string | null
  fillPrice: number | null
  positionCost: number | null
  potentialPayout: number | null
  insiderScore: number | null
  notes: string | null
  savedAt: string
  resolvedAt: string | null
  resolutionOutcome: string | null
  marketResolved: boolean
  winningOutcome: string | null
  // Live position data
  currentValue: number | null
  currentPositionSize: number | null
  syncedAt: string | null
  isSold: boolean
}

function getScoreColor(score: number): string {
  if (score >= 100) return 'text-red-400'
  if (score >= 75) return 'text-orange-400'
  if (score >= 50) return 'text-yellow-400'
  return 'text-gray-400'
}

function formatCurrency(value: number | null): string {
  if (value === null) return '-'
  return `$${Math.round(value).toLocaleString()}`
}

function calculatePnlPercent(cost: number | null, current: number | null): number | null {
  if (cost === null || current === null || cost === 0) return null
  return ((current - cost) / cost) * 100
}

function getPnlColor(pnlPercent: number | null): string {
  if (pnlPercent === null) return ''
  return pnlPercent >= 0 ? 'text-green-400' : 'text-red-400'
}

function getCardBgColor(pnlPercent: number | null): string {
  if (pnlPercent === null) return 'bg-gray-900/50'
  if (pnlPercent >= 10) return 'bg-green-900/20'
  if (pnlPercent >= 0) return 'bg-green-900/10'
  if (pnlPercent >= -10) return 'bg-red-900/10'
  return 'bg-red-900/20'
}

export default function WatchlistPage() {
  const [items, setItems] = useState<WatchlistItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Set<number>>(new Set())

  const fetchWatchlist = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/watchlist')
      if (!res.ok) throw new Error('Failed to fetch watchlist')
      const data = await res.json()
      setItems(data.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchWatchlist()
  }, [fetchWatchlist])

  const removeItem = async (item: WatchlistItem) => {
    setDeleting(prev => new Set(prev).add(item.id))
    try {
      const res = await fetch(`/api/watchlist?id=${item.id}`, { method: 'DELETE' })
      if (res.ok) {
        setItems(prev => prev.filter(i => i.id !== item.id))
      }
    } catch (err) {
      console.error('Failed to remove item:', err)
    } finally {
      setDeleting(prev => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
    }
  }

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  // Separate resolved and unresolved items
  const unresolvedItems = items.filter(i => !i.marketResolved)
  const resolvedItems = items.filter(i => i.marketResolved)

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/50">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                <span className="text-yellow-500">*</span>
                Watchlist
              </h1>
              <p className="text-sm text-gray-400 mt-1">
                Track saved trades and see how they resolve
              </p>
            </div>
            <Link
              href="/radar"
              className="text-sm text-blue-400 hover:text-blue-300"
            >
              Back to Radar
            </Link>
          </div>
        </div>
      </header>

      {/* Stats bar */}
      <div className="border-b border-gray-800 bg-gray-900/20">
        <div className="max-w-7xl mx-auto px-4 py-2">
          <div className="flex items-center gap-6 text-sm text-gray-400">
            <span>
              <span className="text-white font-medium">{items.length}</span> saved trades
            </span>
            <span>
              <span className="text-yellow-400">{unresolvedItems.length}</span> pending
            </span>
            <span>
              <span className="text-green-400">{resolvedItems.filter(i => i.winningOutcome === i.outcome).length}</span> won
            </span>
            <span>
              <span className="text-red-400">{resolvedItems.filter(i => i.winningOutcome && i.winningOutcome !== i.outcome).length}</span> lost
            </span>
          </div>
        </div>
      </div>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        {error && (
          <div className="bg-red-900/50 border border-red-700 rounded-lg p-4 mb-6">
            <p className="text-red-400">{error}</p>
          </div>
        )}

        {loading ? (
          <div className="text-center py-12 text-gray-500">
            Loading watchlist...
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <p>No saved trades yet.</p>
            <p className="mt-2">
              <Link href="/radar" className="text-blue-400 hover:text-blue-300">
                Go to Radar
              </Link>
              {' '}to find and save interesting trades.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {/* Pending/Unresolved */}
            {unresolvedItems.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                  <span className="text-yellow-400">Pending</span>
                  <span className="text-sm text-gray-500 font-normal">({unresolvedItems.length})</span>
                </h2>
                <div className="space-y-3">
                  {unresolvedItems.map(item => {
                    const pnlPercent = calculatePnlPercent(item.positionCost, item.currentValue)
                    return (
                      <div
                        key={item.id}
                        className={`border border-gray-700 rounded-lg p-4 ${getCardBgColor(pnlPercent)}`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <h3 className="font-medium text-white truncate">
                              {item.title || 'Unknown Market'}
                            </h3>
                            <div className="flex items-center gap-3 mt-2 text-sm">
                              <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                                item.outcome === 'Yes' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                              }`}>
                                {item.outcome}
                              </span>
                              <span className="text-gray-400">
                                @ {item.fillPrice ? `${(item.fillPrice * 100).toFixed(1)}%` : '-'}
                              </span>
                              {item.insiderScore && (
                                <span className={`font-medium ${getScoreColor(item.insiderScore)}`}>
                                  Score: {item.insiderScore}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                              <span>
                                Cost: {formatCurrency(item.positionCost)}
                              </span>
                              {item.currentValue !== null && (
                                <span className={getPnlColor(pnlPercent)}>
                                  Current: {formatCurrency(item.currentValue)}
                                  {pnlPercent !== null && (
                                    <span className="ml-1">
                                      ({pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(1)}%)
                                    </span>
                                  )}
                                </span>
                              )}
                              <span>
                                Potential: {formatCurrency(item.potentialPayout)}
                              </span>
                              <span>
                                Saved: {formatDate(item.savedAt)}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {item.isSold && (
                              <span className="px-2 py-0.5 bg-gray-500/20 text-gray-400 rounded text-xs">
                                SOLD
                              </span>
                            )}
                            <a
                              href={`https://polymarket.com/profile/${item.wallet}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-400 hover:text-blue-300"
                            >
                              Profile
                            </a>
                            <button
                              onClick={() => removeItem(item)}
                              disabled={deleting.has(item.id)}
                              className="text-xs text-gray-500 hover:text-red-400"
                            >
                              {deleting.has(item.id) ? '...' : 'Remove'}
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Resolved */}
            {resolvedItems.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                  <span className="text-gray-400">Resolved</span>
                  <span className="text-sm text-gray-500 font-normal">({resolvedItems.length})</span>
                </h2>
                <div className="space-y-3">
                  {resolvedItems.map(item => {
                    const won = item.winningOutcome === item.outcome
                    return (
                      <div
                        key={item.id}
                        className={`border rounded-lg p-4 ${
                          won
                            ? 'border-green-700 bg-green-900/10'
                            : 'border-red-700 bg-red-900/10'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <h3 className="font-medium text-white truncate">
                              {item.title || 'Unknown Market'}
                            </h3>
                            <div className="flex items-center gap-3 mt-2 text-sm">
                              <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                                won ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                              }`}>
                                {won ? 'WON' : 'LOST'}
                              </span>
                              <span className="text-gray-400">
                                Bet: {item.outcome} @ {item.fillPrice ? `${(item.fillPrice * 100).toFixed(1)}%` : '-'}
                              </span>
                              {item.insiderScore && (
                                <span className={`font-medium ${getScoreColor(item.insiderScore)}`}>
                                  Score: {item.insiderScore}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                              <span>
                                Cost: {formatCurrency(item.positionCost)}
                              </span>
                              {won && (
                                <span className="text-green-400">
                                  Payout: {formatCurrency(item.potentialPayout)}
                                </span>
                              )}
                              <span>
                                Saved: {formatDate(item.savedAt)}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <a
                              href={`https://polymarket.com/profile/${item.wallet}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-400 hover:text-blue-300"
                            >
                              Profile
                            </a>
                            <button
                              onClick={() => removeItem(item)}
                              disabled={deleting.has(item.id)}
                              className="text-xs text-gray-500 hover:text-red-400"
                            >
                              {deleting.has(item.id) ? '...' : 'Remove'}
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
