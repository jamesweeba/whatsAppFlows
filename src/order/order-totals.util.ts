import { roundMoney } from '../common/money.util.js';

export interface PricedItem {
  unitPrice: number;
  quantity: number;
}

export interface OrderTotals {
  subtotal: number;
  deliveryFee: number;
  total: number;
}

/** Quantities are stored as integers; anything below one becomes one. */
export function normalizeQuantity(quantity: unknown): number {
  const parsed = Math.round(Number(quantity));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

export function lineTotal(item: PricedItem): number {
  return roundMoney(Number(item.unitPrice || 0) * Number(item.quantity || 0));
}

export function itemsSubtotal(items: PricedItem[]): number {
  return roundMoney(items.reduce((sum, item) => sum + lineTotal(item), 0));
}

export function orderTotals(items: PricedItem[], deliveryFee = 0): OrderTotals {
  const subtotal = itemsSubtotal(items);
  const fee = roundMoney(deliveryFee);
  return { subtotal, deliveryFee: fee, total: roundMoney(subtotal + fee) };
}
