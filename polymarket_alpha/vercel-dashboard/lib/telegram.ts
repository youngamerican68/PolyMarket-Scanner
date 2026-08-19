// lib/telegram.ts
// Minimal Telegram Bot API notifier for cron-driven alerts.
//
// Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from the environment. If either is
// missing the notifier is a no-op that reports `skipped` -- an unconfigured bot must
// never fail a data job. Likewise every send failure is returned, never thrown.

const TELEGRAM_API = 'https://api.telegram.org';
const SEND_TIMEOUT_MS = 10_000;

export type TelegramResult =
  | { status: 'sent' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

export function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

/** Escape text for Telegram's HTML parse mode. Only these three are special. */
export function escapeHtml(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Send a message. Never throws -- callers treat notification as best-effort.
 * Uses HTML parse mode; pass text already escaped via escapeHtml() for dynamic parts.
 */
export async function sendTelegramMessage(html: string): Promise<TelegramResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return { status: 'skipped', reason: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      // Telegram returns a JSON description on error; surface it for the job log.
      const body = await res.text().catch(() => '');
      return { status: 'failed', error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return { status: 'sent' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'failed', error: msg.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}
