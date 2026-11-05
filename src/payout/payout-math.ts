import { toGhanaLocal } from '../common/phone.util.js';

/** MarketiX's commission on the items of each order (not on the delivery fee). */
export const COMMISSION_PERCENT = 10;
/** Smallest payout worth a transfer (pesewas): GH₵ 1. Smaller balances wait for the next order. */
export const MIN_PAYOUT = 100;

export const toPesewas = (cedis: number) => Math.round(cedis * 100);

export interface OrderSplit {
  /** What the items cost (order total less delivery fee). */
  items: number;
  /** MarketiX's 10% of the items. */
  commission: number;
  deliveryFee: number;
  /** What the vendor gets for a paid order: items less commission, plus the whole delivery fee. */
  vendorShare: number;
}

/** How an order's total divides between vendor and MarketiX, in pesewas. */
export function orderSplit(order: { totalAmount: number; deliveryFee: number }): OrderSplit {
  const total = toPesewas(order.totalAmount);
  const deliveryFee = Math.min(Math.max(toPesewas(order.deliveryFee), 0), total);
  const items = total - deliveryFee;
  const commission = Math.round((items * COMMISSION_PERCENT) / 100);
  return { items, commission, deliveryFee, vendorShare: items - commission + deliveryFee };
}

/** Paystack's mobile-money "bank" codes for Ghana. */
export type MomoNetworkCode = 'MTN' | 'VOD' | 'ATL';

const NETWORK_PREFIXES: Record<MomoNetworkCode, string[]> = {
  MTN: ['024', '025', '053', '054', '055', '059'],
  VOD: ['020', '050'],
  ATL: ['026', '027', '056', '057'],
};

/**
 * The MoMo network of a Ghana number, from its prefix. A number moved to another network
 * keeps its old prefix, so a transfer can still fail; admins can retry once fixed.
 */
export function momoNetworkOf(phone: string): MomoNetworkCode | null {
  const prefix = toGhanaLocal(phone).slice(0, 3);
  for (const [code, prefixes] of Object.entries(NETWORK_PREFIXES) as [MomoNetworkCode, string[]][]) {
    if (prefixes.includes(prefix)) return code;
  }
  return null;
}

export const ghs = (pesewas: number) => `GH₵ ${(pesewas / 100).toFixed(2)}`;
