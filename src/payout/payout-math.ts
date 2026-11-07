import { PayoutStatus } from '@prisma/client';
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

/** Card earnings are held this many days by default before they can be withdrawn. */
export const DEFAULT_CARD_HOLD_DAYS = 3;

/**
 * Days a card payment's earning is held (CARD_EARNINGS_HOLD_DAYS, 0-30; default 3), so a
 * buyer who disputes the charge can't leave MarketiX paying for money already withdrawn.
 * An unreadable value falls back to the default rather than releasing money early.
 */
export function cardHoldDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CARD_EARNINGS_HOLD_DAYS?.trim();
  if (!raw) return DEFAULT_CARD_HOLD_DAYS;
  const days = Number(raw);
  return Number.isInteger(days) && days >= 0 && days <= 30 ? days : DEFAULT_CARD_HOLD_DAYS;
}

/**
 * Whether the buyer paid in a way that can be disputed and pulled back (a card, or any
 * Paystack channel other than mobile money). Orders paid before the channel was recorded
 * go by the payment method the buyer picked.
 */
export function isDisputablePayment(order: { paystackChannel: string | null; paymentMethod: string | null }): boolean {
  if (order.paystackChannel) return order.paystackChannel !== 'mobile_money';
  return order.paymentMethod !== 'MOMO';
}

/** When an order's earning can be withdrawn: null for right away. */
export function earningAvailableAt(
  order: { paystackChannel: string | null; paymentMethod: string | null },
  now: Date = new Date(),
  holdDays: number = cardHoldDays(),
): Date | null {
  if (holdDays === 0 || !isDisputablePayment(order)) return null;
  return new Date(now.getTime() + holdDays * 24 * 60 * 60 * 1000);
}

const accraDateTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** "8 Nov, 14:30" in Accra (GMT all year). */
export const formatAccra = (date: Date) => accraDateTime.format(date);

/** Payouts in flight: at most one per shop, so a balance is never sent twice. */
export const IN_FLIGHT: PayoutStatus[] = [PayoutStatus.PENDING, PayoutStatus.PROCESSING];

/**
 * A payout still in flight after this long is checked with Paystack before the shop is paid
 * again. Long enough that a transfer request still on its way to Paystack has landed.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

/** Transfers only go out when PAYOUTS_ENABLED=true; otherwise balances just accrue. */
export const payoutsEnabled = () => process.env.PAYOUTS_ENABLED?.trim().toLowerCase() === 'true';

/** A shop's balance split into what can be withdrawn now and what's held (card earnings). */
export interface Funds {
  /** The whole balance (negative: the vendor owes MarketiX). */
  balance: number;
  /** What can be withdrawn now. */
  available: number;
  /** Card earnings not yet withdrawable. */
  onHold: number;
  /** When the next held earning becomes withdrawable, or null. */
  nextReleaseAt: Date | null;
}

/**
 * The highest delivery fee a shop may charge, in GHS. MarketiX's commission is on items only,
 * so without a cap a shop could move its prices into the delivery fee and pay almost nothing.
 */
export const MAX_DELIVERY_FEE = 50;
