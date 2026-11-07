import { OrderStatus, PaymentMethod } from '@prisma/client';
import { toE164 } from '../common/phone.util.js';
import { CANCELLED_ORDER_STATUSES, DELIVERED_ORDER_STATUSES } from '../order/order-status-groups.js';
import { orderSplit, toPesewas } from '../payout/payout-math.js';
import { CODE_LENGTH } from './promoter-rules.js';

const REF_PATTERN = new RegExp(`\\(\\s*ref\\s+([A-Z0-9]{${CODE_LENGTH}})\\s*\\)`, 'i');

/** The link code in a buyer's first message, "Hi! I'd like to order (ref K7Q2MX)", or null. */
export function parseRefCode(text: string | null | undefined): string | null {
  const match = REF_PATTERN.exec(text ?? '');
  return match ? match[1].toUpperCase() : null;
}

/**
 * What the commission is on, and the commission, in pesewas. A shop link: all the items (not
 * delivery). A product link: only that product's lines, so 0 if the order doesn't have it.
 */
export function commissionFor(
  referral: { productId: string | null; ratePercent: number },
  order: { totalAmount: number; deliveryFee: number; items: { productId: string | null; totalPrice: number }[] },
): { base: number; commission: number } {
  const base = referral.productId
    ? order.items.filter((item) => item.productId === referral.productId).reduce((sum, item) => sum + toPesewas(item.totalPrice), 0)
    : orderSplit(order).items;
  return { base, commission: Math.round((base * referral.ratePercent) / 100) };
}

/**
 * Where a referral stands:
 * - WAITING: the buyer tapped the link but hasn't ordered yet; EXPIRED once the 14 days pass.
 * - PENDING: ordered; waiting for payment and delivery.
 * - EARNED: paid by MoMo or card and delivered. (Crediting the promoter comes with promoter payouts.)
 * - NO_COMMISSION: see the reason.
 */
export type ReferralState = 'WAITING' | 'EXPIRED' | 'PENDING' | 'EARNED' | 'NO_COMMISSION';
export type NoCommissionReason = 'CANCELLED' | 'CASH' | 'OWN_NUMBER' | 'PRODUCT_NOT_IN_ORDER';

export interface ReferralOrderFacts {
  status: OrderStatus;
  paymentMethod: PaymentMethod | null;
  paystackPaidAt: Date | null;
  buyerPhone: string;
  paymentPhone: string | null;
}

export function referralState(
  referral: { expiresAt: Date; commissionAmount: number | null },
  order: ReferralOrderFacts | null,
  promoter: { phone: string; momoNumber: string | null },
  now = new Date(),
): { state: ReferralState; reason?: NoCommissionReason } {
  if (!order) return { state: referral.expiresAt > now ? 'WAITING' : 'EXPIRED' };
  if (CANCELLED_ORDER_STATUSES.includes(order.status)) return { state: 'NO_COMMISSION', reason: 'CANCELLED' };
  if (order.paymentMethod === PaymentMethod.COD) return { state: 'NO_COMMISSION', reason: 'CASH' };
  if (isPromotersOwnNumber(order, promoter)) return { state: 'NO_COMMISSION', reason: 'OWN_NUMBER' };
  if (!referral.commissionAmount) return { state: 'NO_COMMISSION', reason: 'PRODUCT_NOT_IN_ORDER' };
  if (DELIVERED_ORDER_STATUSES.includes(order.status) && order.paystackPaidAt) return { state: 'EARNED' };
  return { state: 'PENDING' };
}

/** The buyer, or whoever paid, is the promoter: their WhatsApp number or their MoMo number. */
export function isPromotersOwnNumber(
  order: Pick<ReferralOrderFacts, 'buyerPhone' | 'paymentPhone'>,
  promoter: { phone: string; momoNumber: string | null },
): boolean {
  const theirs = new Set([promoter.phone, promoter.momoNumber].filter(Boolean).map((n) => toE164(n!)));
  return [order.buyerPhone, order.paymentPhone].some((n) => n && theirs.has(toE164(n)));
}
