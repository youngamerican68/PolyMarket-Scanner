# Polymarket Longshot Tracker - Progress

## Current Status: Live & Automated

Dashboard URL: `https://poly-market-scanner.vercel.app`

---

## What We're Tracking

### Top Longshot Trades
- **Criteria:** $5K+ value trades at <25% odds
- **Data shown:**
  - Market title (clickable link to Polymarket)
  - Trader name/wallet (clickable link to profile)
  - Settled record (W-L for resolved bets)
  - Position status: Holding, Sold, or Hedge indicator
  - Current odds (live from Polymarket)
  - 24h Value (amount added in last 24 hours)
  - Total Position (full holding value: shares × current price)
  - Potential payout (if bet wins at $1/share)
- **Filtering:** Dropdown to filter by odds range (All <25%, <20%, <15%, <10%, <5%)

### Sharp Convergence Alerts
- **Criteria:** 2+ wallets independently betting on same longshot outcome
- **Minimum bet:** $5K per wallet
- **Maximum odds:** 25%
- **Signal:** Multiple sharp bettors agreeing = stronger conviction

### Hedge Detection
- **Indicator:** Balance scale emoji shown when wallet holds both sides of same market
- **Scope:** Same market only (not event-level hedging)

---

## Data Collection

### Automated Cron Job
- **Frequency:** Every 30 minutes via GitHub Actions
- **Endpoint:** `/api/collect-trades`
- **Process:**
  1. Fetches recent trades from Polymarket API (up to 10K per run)
  2. Stores in Vercel Postgres database
  3. Prunes trades older than 48 hours

### Database
- **Provider:** Vercel Postgres (Neon) - Free tier
- **Retention:** 48 hours rolling window
- **Capacity:** ~256 MB limit, currently using ~30 MB estimated
- **All trades stored** (not just longshots) for filter flexibility

### API Limits
- Polymarket: 10K trades per API call
- At current volume (~2K trades per 30 min), well under limit
- If volume spikes, can increase cron frequency to 15 minutes

---

## Decisions Made - Not Tracking

### Historical Win Tracking
- **What:** Track longshot winners over time to build "sharp" profiles
- **Why not:** Adds database complexity, would need separate tables for outcomes
- **Revisit if:** Want to surface "this trader has won 3 longshots this month"

### Event-Level Hedge Detection
- **What:** Detect hedges across different markets in same event (e.g., Fed rate bets)
- **Why not:** Complex to implement, event relationships not clean in API
- **Current approach:** User can eyeball related markets manually
- **Example:** sorcerer.05 betting "no change" AND "-25 bps" on Fed meeting - both are +EV if uncertain, not truly hedged

### Sub-$5K Trades
- **What:** Track smaller longshot bets
- **Why not:** Verified that sub-$5K trades at <10% odds are mostly $100-500 lottery tickets
- **Rationale:** Insiders with real information would bet larger amounts

### Settlement Anomalies
- **What:** Flag markets that settled unexpectedly
- **Why not:** Too noisy, not actionable for finding sharps

### Sold-Early Trades
- **What:** Include trades where position was already closed
- **Why not:** Can't verify if they won or lost, position size unknown
- **Current:** Only show trades where wallet is still holding

---

## Technical Stack

- **Frontend:** Next.js 14 + Tailwind CSS
- **Backend:** Next.js API routes
- **Database:** Vercel Postgres
- **Hosting:** Vercel (Hobby plan)
- **Cron:** GitHub Actions (Vercel cron limited to daily on free plan)
- **Data source:** Polymarket CLOB API + Gamma API

---

## Future Considerations

- Increase cron to 15-minute intervals if trade volume grows
- Historical win tracking if want to identify consistently profitable wallets
- Alert system (email/Discord) when new sharp convergence detected
- Extend retention beyond 48 hours for trend analysis
