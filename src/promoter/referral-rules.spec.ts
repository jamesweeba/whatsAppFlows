import { OrderStatus, PaymentMethod } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { referralMessage } from './promoter-rules.js';
import { commissionFor, isPromotersOwnNumber, parseRefCode, referralState, ReferralOrderFacts } from './referral-rules.js';

describe('parseRefCode', () => {
  it('reads the code from the message a link pre-fills', () => {
    expect(parseRefCode(referralMessage('K7Q2MX'))).toBe('K7Q2MX');
    expect(parseRefCode(referralMessage('K7Q2MX', 'Rice (5 kg)'))).toBe('K7Q2MX');
  });

  it('copes with case and spacing, and ignores text without a code', () => {
    expect(parseRefCode('hello ( REF k7q2mx )')).toBe('K7Q2MX');
    expect(parseRefCode('I want to buy rice')).toBeNull();
    expect(parseRefCode('(ref K7Q)')).toBeNull();
    expect(parseRefCode(undefined)).toBeNull();
  });
});

describe('commissionFor', () => {
  const order = {
    totalAmount: 160, // GH₵ 150 of items + GH₵ 10 delivery
    deliveryFee: 10,
    items: [
      { productId: 'rice', totalPrice: 100 },
      { productId: 'oil', totalPrice: 50 },
    ],
  };

  it('pays a shop link on all items, not delivery', () => {
    expect(commissionFor({ productId: null, ratePercent: 10 }, order)).toEqual({ base: 15000, commission: 1500 });
  });

  it("pays a product link on that product's lines only", () => {
    expect(commissionFor({ productId: 'rice', ratePercent: 12 }, order)).toEqual({ base: 10000, commission: 1200 });
  });

  it('pays nothing when the order lacks the product', () => {
    expect(commissionFor({ productId: 'yam', ratePercent: 12 }, order)).toEqual({ base: 0, commission: 0 });
  });
});

describe('referralState', () => {
  const promoter = { phone: '+233244111222', momoNumber: '0244111222' };
  const now = new Date('2026-11-10T12:00:00Z');
  const referral = { expiresAt: new Date('2026-11-20T12:00:00Z'), commissionAmount: 1500 };
  const order = (facts: Partial<ReferralOrderFacts> = {}): ReferralOrderFacts => ({
    status: OrderStatus.PAID,
    paymentMethod: PaymentMethod.MOMO,
    paystackPaidAt: new Date(),
    buyerPhone: '+233200000001',
    paymentPhone: '0200000001',
    ...facts,
  });

  it('waits for an order, then expires', () => {
    expect(referralState(referral, null, promoter, now)).toEqual({ state: 'WAITING' });
    expect(referralState({ ...referral, expiresAt: new Date('2026-11-01') }, null, promoter, now)).toEqual({ state: 'EXPIRED' });
  });

  it('is pending until a paid order is delivered, then earned', () => {
    expect(referralState(referral, order(), promoter, now)).toEqual({ state: 'PENDING' });
    expect(referralState(referral, order({ status: OrderStatus.DELIVERED }), promoter, now)).toEqual({ state: 'EARNED' });
    expect(referralState(referral, order({ status: OrderStatus.DELIVERED, paystackPaidAt: null }), promoter, now)).toEqual({ state: 'PENDING' });
  });

  it.each([
    ['CANCELLED', { status: OrderStatus.CANCELLED }],
    ['CASH', { paymentMethod: PaymentMethod.COD, paystackPaidAt: null }],
    ['OWN_NUMBER', { paymentPhone: '024 411 1222' }],
  ] as const)('earns nothing: %s', (reason, facts) => {
    expect(referralState(referral, order(facts), promoter, now)).toEqual({ state: 'NO_COMMISSION', reason });
  });

  it('earns nothing when the product link has nothing to pay on', () => {
    expect(referralState({ ...referral, commissionAmount: 0 }, order(), promoter, now)).toEqual({ state: 'NO_COMMISSION', reason: 'PRODUCT_NOT_IN_ORDER' });
  });
});

describe('isPromotersOwnNumber', () => {
  const promoter = { phone: '+233244111222', momoNumber: '0551234567' };
  it("matches the promoter's WhatsApp or MoMo number in any format", () => {
    expect(isPromotersOwnNumber({ buyerPhone: '+233244111222', paymentPhone: null }, promoter)).toBe(true);
    expect(isPromotersOwnNumber({ buyerPhone: '+233200000001', paymentPhone: '+233551234567' }, promoter)).toBe(true);
    expect(isPromotersOwnNumber({ buyerPhone: '+233200000001', paymentPhone: '0200000001' }, promoter)).toBe(false);
  });
});
