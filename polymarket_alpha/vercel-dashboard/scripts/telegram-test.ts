// scripts/telegram-test.ts
// Verify Telegram wiring end-to-end. Renders a real confirmed insider candidate
// (or a synthetic one if none exist) and sends it.
//
//   npx tsx scripts/telegram-test.ts
//
// Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the environment.
// Does NOT touch notified_at -- safe to run repeatedly.

import { sql } from '@vercel/postgres';
import { sendTelegramMessage, escapeHtml, isTelegramConfigured } from '../lib/telegram';

async function main() {
  if (!isTelegramConfigured()) {
    console.error('FAIL: TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID not set in this shell.');
    console.error('      Pull them locally with:  vercel env pull .env.local');
    process.exit(1);
  }

  let row: {
    wallet: string; outcome: string; fill_price: string; fill_value_usd: string;
    title: string | null; event_slug: string | null; slug: string | null;
    polymarket_lifetime_trades: number | null;
  } | undefined;

  try {
    const res = await sql<typeof row & object>`
      SELECT wallet, outcome, fill_price::text, fill_value_usd::text,
             title, event_slug, slug, polymarket_lifetime_trades
      FROM insider_candidates
      WHERE verification_status = 'confirmed'
      ORDER BY verified_at DESC
      LIMIT 1
    `;
    row = res.rows[0];
  } catch {
    console.warn('(could not reach DB -- falling back to a synthetic sample)');
  }

  const sample = row ?? {
    wallet: '0x52101c192f5b89d97739204a63e0950e1cc0b591',
    outcome: 'Yes',
    fill_price: '0.0679',
    fill_value_usd: '235.68',
    title: 'Will Bulgaria win Eurovision 2026?',
    event_slug: 'will-bulgaria-win-eurovision-2026',
    slug: null,
    polymarket_lifetime_trades: 2,
  };

  const price = Number(sample.fill_price);
  const value = Number(sample.fill_value_usd);
  const marketSlug = sample.event_slug || sample.slug;
  const text = [
    '\u{1F9EA} <b>TEST</b> · \u{1F6A8} <b>Insider pattern confirmed</b>',
    '',
    `<b>${escapeHtml(sample.title ?? 'Unknown market')}</b>`,
    `Bet: <b>${escapeHtml(sample.outcome)}</b> @ ${(price * 100).toFixed(1)}%`,
    `Size: $${value.toFixed(0)}`,
    `Wallet: <code>${escapeHtml(sample.wallet)}</code>`,
    `Lifetime trades: <b>${sample.polymarket_lifetime_trades ?? '?'}</b>`,
    '',
    marketSlug
      ? `<a href="https://polymarket.com/event/${encodeURIComponent(marketSlug)}">Market</a> · <a href="https://polymarket.com/profile/${encodeURIComponent(sample.wallet)}">Wallet</a>`
      : `<a href="https://polymarket.com/profile/${encodeURIComponent(sample.wallet)}">Wallet</a>`,
  ].join('\n');

  console.log('--- message preview ---');
  console.log(text.replace(/<[^>]+>/g, ''));
  console.log('-----------------------');

  const result = await sendTelegramMessage(text);
  if (result.status === 'sent') {
    console.log('OK: message sent. Check your Telegram chat.');
    process.exit(0);
  }
  console.error(`FAIL: ${JSON.stringify(result)}`);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
