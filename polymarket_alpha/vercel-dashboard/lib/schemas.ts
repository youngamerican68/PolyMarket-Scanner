// /lib/schemas.ts
// Zod schemas with safe numeric helpers for Phase 1
// CRITICAL: These helpers prevent silent coercion of empty strings to 0

import { z } from 'zod';

/**
 * Normalize timestamp: if > 1e12, treat as milliseconds and convert to seconds.
 * Always returns integer seconds.
 */
export function normalizeTimestamp(ts: number): number {
  return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
}

/**
 * Optional numeric field — allows null, rejects empty strings and invalid values.
 * "" → null (not 0)
 * null/undefined → null
 * "0.25" → 0.25
 * 0 → 0 (explicit zero is valid)
 * "abc" → NaN (fails validation)
 */
export const optionalNumber = z.preprocess((val) => {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string' && val.trim() === '') return null;

  const n =
    typeof val === 'number' ? val :
    typeof val === 'string' ? Number(val) :
    NaN;

  return Number.isFinite(n) ? n : NaN;
}, z.number().nullable());

/**
 * Required numeric field — must be present and valid.
 * "" → validation error
 * null/undefined → validation error
 * "0.25" → 0.25
 * 0 → 0 (explicit zero is valid)
 * "abc" → validation error
 */
export const requiredNumber = z.preprocess((val) => {
  if (val === null || val === undefined) return undefined;
  if (typeof val === 'string' && val.trim() === '') return undefined;

  const n =
    typeof val === 'number' ? val :
    typeof val === 'string' ? Number(val) :
    NaN;

  return Number.isFinite(n) ? n : undefined;
}, z.number());

/**
 * Optional integer field — allows null, rejects empty strings and invalid values.
 */
export const optionalInt = z.preprocess((val) => {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string' && val.trim() === '') return null;

  const n =
    typeof val === 'number' ? val :
    typeof val === 'string' ? Number(val) :
    NaN;

  return Number.isFinite(n) && Number.isInteger(n) ? n : NaN;
}, z.number().int().nullable());

/**
 * Required integer field — must be present and valid.
 */
export const requiredInt = z.preprocess((val) => {
  if (val === null || val === undefined) return undefined;
  if (typeof val === 'string' && val.trim() === '') return undefined;

  const n =
    typeof val === 'number' ? val :
    typeof val === 'string' ? Number(val) :
    NaN;

  return Number.isFinite(n) && Number.isInteger(n) ? n : undefined;
}, z.number().int());

/**
 * Trade schema - validates trade API responses from Polymarket
 */
export const TradeSchema = z.object({
  proxyWallet: z.string(),
  side: z.enum(['BUY', 'SELL']),
  asset: z.string(),
  conditionId: z.string(),
  size: requiredNumber,
  price: requiredNumber,
  timestamp: requiredNumber,
  title: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  eventSlug: z.string().nullable().optional(),
  outcome: z.string(),
  outcomeIndex: requiredInt,
  name: z.string().nullable().optional(),
  pseudonym: z.string().nullable().optional(),
  transactionHash: z.string().nullable().optional(),
});

export type Trade = z.infer<typeof TradeSchema>;

export const TradesResponseSchema = z.array(TradeSchema);

/**
 * Position schema - validates position API responses from Polymarket
 */
export const PositionSchema = z.object({
  proxyWallet: z.string(),
  asset: z.string(),
  conditionId: z.string(),
  size: optionalNumber,
  avgPrice: optionalNumber,
  curPrice: optionalNumber,
  initialValue: optionalNumber,
  currentValue: optionalNumber,
  cashPnl: optionalNumber,
  title: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  eventSlug: z.string().nullable().optional(),
  outcome: z.string().nullable().optional(),
  outcomeIndex: optionalInt,
});

export type Position = z.infer<typeof PositionSchema>;

export const PositionsResponseSchema = z.array(PositionSchema);
