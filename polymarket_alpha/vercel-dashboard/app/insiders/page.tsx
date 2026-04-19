'use client'

import React, { useState, useEffect, useCallback } from 'react'

interface InsiderSignal {
  alertEventId: string
  wallet: string
  conditionId: string
  outcome: string
  title: string | null
  eventSlug: string | null
  slug: string | null
  fillPrice: number
  fillPriceFormatted: string
  fillValueUsd: number
  fillValueFormatted: string
  fillTimestamp: string
  polymarketLifetimeTrades: number | null
  polymarketFirstTradeAt: string | null
  verifiedAt: string | null
  potentialPayoutUsd: number
  potentialPayoutFormatted: string
  marketResolved: boolean
  winningOutcome: string | null
  won: boolean | null
}

interface ApiResponse {
  signals: InsiderSignal[]
  count: number
  generatedAt: string
  error?: string
}

function formatRelative(ts: string): string {
  const diffMs = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function shortWallet(w: string): string {
  return `${w.slice(0, 6)}…${w.slice(-4)}`
}

function marketUrl(slug: string | null, eventSlug: string | null): string | null {
  if (slug) return `https://polymarket.com/market/${slug}`
  if (eventSlug) return `https://polymarket.com/event/${eventSlug}`
  return null
}

export default function InsidersPage() {
  const [signals, setSignals] = useState<InsiderSignal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [includeResolved, setIncludeResolved] = useState(false)
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        sinceDays: '30',
        limit: '100',
        includeResolved: includeResolved ? 'true' : 'false',
      })
      const res = await fetch(`/api/insiders?${params.toString()}`, { cache: 'no-store' })
      const data: ApiResponse = await res.json()
      if (data.error) {
        setError(data.error)
      } else {
        setSignals(data.signals || [])
        setGeneratedAt(data.generatedAt)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [includeResolved])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const openCount = signals.filter(s => !s.marketResolved).length
  const resolvedWins = signals.filter(s => s.marketResolved && s.won === true).length
  const resolvedLosses = signals.filter(s => s.marketResolved && s.won === false).length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-2">Insider Candidates</h1>
        <p className="text-poly-muted text-sm max-w-2xl">
          Fresh wallets (≤3 lifetime Polymarket trades) placing small bets ($100-$500) on deep
          longshots (&lt;10% implied). Verified against the Polymarket trades API at ingestion time.
          This is the narrow pattern with measured ~7× edge vs. market-implied probability.
        </p>
      </div>

      <div className="flex flex-wrap gap-4 items-center bg-poly-card border border-poly-border rounded-lg px-4 py-3">
        <div className="text-sm">
          <span className="text-poly-muted">Open markets:</span>{' '}
          <span className="font-semibold">{openCount}</span>
        </div>
        <div className="text-sm">
          <span className="text-poly-muted">Resolved wins:</span>{' '}
          <span className="font-semibold text-poly-green">{resolvedWins}</span>
        </div>
        <div className="text-sm">
          <span className="text-poly-muted">Resolved losses:</span>{' '}
          <span className="font-semibold">{resolvedLosses}</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={includeResolved}
              onChange={e => setIncludeResolved(e.target.checked)}
              className="cursor-pointer"
            />
            Include resolved
          </label>
          <button
            onClick={fetchData}
            disabled={loading}
            className="px-3 py-1 text-sm rounded border border-poly-border hover:bg-poly-card-hover disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/20 border border-red-700 text-red-200 rounded-lg p-4 text-sm">
          Error: {error}
        </div>
      )}

      {!loading && signals.length === 0 && !error && (
        <div className="bg-poly-card border border-poly-border rounded-lg p-8 text-center text-poly-muted">
          No confirmed insider candidates in the selected window.
        </div>
      )}

      <div className="space-y-3">
        {signals.map(s => {
          const url = marketUrl(s.slug, s.eventSlug)
          return (
            <div
              key={s.alertEventId}
              className={`bg-poly-card border rounded-lg p-4 ${
                s.marketResolved
                  ? s.won
                    ? 'border-poly-green/50'
                    : 'border-poly-border opacity-75'
                  : 'border-poly-border'
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
                <div className="flex-1 min-w-0">
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold hover:underline text-white"
                    >
                      {s.title || '(untitled market)'}
                    </a>
                  ) : (
                    <span className="font-semibold text-white">{s.title || '(untitled market)'}</span>
                  )}
                  <div className="text-sm text-poly-muted mt-1">
                    Bought <span className="text-white font-medium">{s.outcome}</span> at{' '}
                    <span className="text-white font-medium">{s.fillPriceFormatted}</span>
                    {' · '}
                    {s.fillValueFormatted} stake · potential payout{' '}
                    <span className="text-white font-medium">{s.potentialPayoutFormatted}</span>
                  </div>
                </div>
                <div className="text-right text-xs">
                  {s.marketResolved ? (
                    s.won === true ? (
                      <span className="inline-block bg-poly-green/20 text-poly-green rounded px-2 py-0.5 font-semibold">
                        WON
                      </span>
                    ) : s.won === false ? (
                      <span className="inline-block bg-red-900/40 text-red-300 rounded px-2 py-0.5">
                        LOST
                      </span>
                    ) : (
                      <span className="inline-block bg-poly-border rounded px-2 py-0.5">
                        RESOLVED
                      </span>
                    )
                  ) : (
                    <span className="inline-block bg-blue-900/30 text-blue-200 rounded px-2 py-0.5">
                      OPEN
                    </span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mt-3">
                <div>
                  <div className="text-poly-muted">Wallet</div>
                  <a
                    href={`https://polymarket.com/profile/${s.wallet}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono hover:underline"
                  >
                    {shortWallet(s.wallet)}
                  </a>
                </div>
                <div>
                  <div className="text-poly-muted">Lifetime trades</div>
                  <div className="font-semibold">{s.polymarketLifetimeTrades ?? '—'}</div>
                </div>
                <div>
                  <div className="text-poly-muted">First trade</div>
                  <div>
                    {s.polymarketFirstTradeAt
                      ? formatRelative(s.polymarketFirstTradeAt)
                      : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-poly-muted">This bet</div>
                  <div>{formatRelative(s.fillTimestamp)}</div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {generatedAt && (
        <div className="text-xs text-poly-muted text-right">
          Updated {formatRelative(generatedAt)}
        </div>
      )}
    </div>
  )
}
