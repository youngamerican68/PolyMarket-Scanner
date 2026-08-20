// scripts/backfill-at-fill-freshness.ts
// Recompute point-in-time freshness (trades at or before the fill) for existing
// insider_candidates rows, which were classified using the drifting "trades now"
// count. Reports any row whose tier would change. Pass --apply to write.
//
//   npx tsx scripts/backfill-at-fill-freshness.ts [--apply]

import { sql } from '@vercel/postgres';

const PAGE = 500, MAX_PAGES = 4;
const CONFIRM_MAX = 3, WATCH_MAX = 10;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const tierOf = (n: number, truncated: boolean) =>
  truncated ? 'rejected_established'
  : n > 0 && n <= CONFIRM_MAX ? 'confirmed'
  : n > 0 && n <= WATCH_MAX ? 'watch'
  : 'rejected_established';

async function history(wallet: string) {
  const ts: number[] = [];
  let truncated = false;
  for (let p = 0; p < MAX_PAGES; p++) {
    const res = await fetch(`https://data-api.polymarket.com/trades?user=${wallet}&limit=${PAGE}&offset=${p * PAGE}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const batch = await res.json() as { timestamp?: number }[];
    if (!Array.isArray(batch)) throw new Error('bad payload');
    for (const t of batch) if (typeof t.timestamp === 'number') ts.push(t.timestamp);
    if (batch.length < PAGE) return { ts, truncated };
    if (p === MAX_PAGES - 1) truncated = true;
  }
  return { ts, truncated };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { rows } = await sql<{
    alert_event_id: string; wallet: string; fill_timestamp: string;
    verification_status: string; polymarket_lifetime_trades: number | null; title: string | null;
  }>`
    SELECT alert_event_id, wallet, fill_timestamp::text, verification_status,
           polymarket_lifetime_trades, title
    FROM insider_candidates
    WHERE lifetime_trades_at_fill IS NULL
    ORDER BY fill_timestamp DESC
  `;
  console.log(`${rows.length} rows to backfill (apply=${apply})\n`);

  const changes: string[] = [];
  let done = 0, failed = 0;

  for (const r of rows) {
    let h;
    try { h = await history(r.wallet); }
    catch (e) { failed++; console.warn(`  lookup failed ${r.wallet.slice(0,10)}…: ${String(e).slice(0,60)}`); await sleep(300); continue; }

    const fill = Math.floor(new Date(r.fill_timestamp).getTime() / 1000);
    const atFill = h.ts.reduce((n, t) => (t <= fill ? n + 1 : n), 0);
    const newTier = tierOf(atFill, h.truncated);

    if (newTier !== r.verification_status) {
      changes.push(`  ${r.verification_status} -> ${newTier}  atFill=${atFill} now=${r.polymarket_lifetime_trades} ${String(r.title).slice(0,44)}`);
    }
    if (apply) {
      await sql`
        UPDATE insider_candidates
        SET lifetime_trades_at_fill = ${atFill},
            history_truncated = ${h.truncated},
            verification_status = ${newTier}
        WHERE alert_event_id = ${r.alert_event_id}
      `;
    }
    done++;
    if (done % 25 === 0) console.log(`  ...${done}/${rows.length}`);
    await sleep(250);
  }

  console.log(`\nprocessed ${done}, lookup failures ${failed}`);
  console.log(`tier changes: ${changes.length}`);
  changes.forEach(c => console.log(c));
  if (!apply && changes.length) console.log('\n(dry run -- re-run with --apply to write)');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
