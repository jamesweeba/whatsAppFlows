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
