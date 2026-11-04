/** Format an amount in Ghana cedis for WhatsApp copy, e.g. `₵12.50`. */
export function cedis(amount: number): string {
  return `₵${Number(amount || 0).toFixed(2)}`;
}

/** Long-form currency label used in receipts, e.g. `GH₵12.50`. */
export function ghCedis(amount: number): string {
  return `GH${cedis(amount)}`;
}

/** Round to two decimals to keep float drift out of persisted totals. */
export function roundMoney(amount: number): number {
  return Math.round((Number(amount) || 0) * 100) / 100;
}

/**
 * Compact cedi label for Flow fields with hard length caps, e.g. `GH₵ 1,200`.
 * Falls back to `₵1,200.50` and then a rounded `₵1,201` when the cap is tight.
 */
export function ghsCompact(amount: number, maxLength = Infinity): string {
  const value = roundMoney(amount);
  const exact = value.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  const rounded = Math.round(value).toLocaleString('en-US');
  const candidates = [`GH₵ ${exact}`, `₵${exact}`, `₵${rounded}`];
  return candidates.find((c) => c.length <= maxLength) ?? candidates[candidates.length - 1];
}
