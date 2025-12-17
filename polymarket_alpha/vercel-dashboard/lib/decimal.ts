// /lib/decimal.ts
// Decimal-safe math utilities for Phase 1
// Uses decimal.js-light to avoid JavaScript float precision errors

import Decimal from 'decimal.js-light';

/**
 * Compute fill_value_usd as price * size using decimal-safe math.
 * Returns string for direct insertion into Postgres NUMERIC column.
 */
export function computeFillValue(price: number, size: number): string {
  return new Decimal(price).mul(new Decimal(size)).toDecimalPlaces(6).toString();
}

/**
 * Round price to 6 decimal places for dedupe ID.
 * Returns string to avoid float drift.
 */
export function roundPrice(price: number): string {
  return new Decimal(price).toDecimalPlaces(6).toString();
}

/**
 * Round size to 2 decimal places for dedupe ID.
 * Returns string to avoid float drift.
 */
export function roundSize(size: number): string {
  return new Decimal(size).toDecimalPlaces(2).toString();
}
