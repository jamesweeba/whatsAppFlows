import { OrderStatus, PaymentMethod } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { canMarkPaidByHand } from './order.service.js';

const prompted = { status: OrderStatus.AWAITING_PAYMENT, paymentMethod: PaymentMethod.MOMO, paymentRequestedAt: new Date(), paystackPaidAt: null };

describe('canMarkPaidByHand', () => {
  it('refuses to move a prompted MoMo order to any paid status before Paystack confirms', () => {
    for (const next of [OrderStatus.PAID, OrderStatus.CONFIRMED, OrderStatus.PROCESSING, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED]) {
      expect(canMarkPaidByHand(prompted, next)).toBe(false);
    }
    expect(canMarkPaidByHand({ ...prompted, status: OrderStatus.PENDING }, OrderStatus.PAID)).toBe(false);
    expect(canMarkPaidByHand({ ...prompted, status: OrderStatus.CANCELLED }, OrderStatus.PAID)).toBe(false);
  });

  it('still lets the vendor cancel an unpaid order', () => {
    expect(canMarkPaidByHand(prompted, OrderStatus.CANCELLED)).toBe(true);
  });

  it('allows everything once Paystack confirmed the payment', () => {
    expect(canMarkPaidByHand({ ...prompted, status: OrderStatus.PAID, paystackPaidAt: new Date() }, OrderStatus.PROCESSING)).toBe(true);
  });

  it('leaves cash orders and orders the vendor took themselves alone', () => {
    expect(canMarkPaidByHand({ ...prompted, paymentMethod: PaymentMethod.COD }, OrderStatus.CONFIRMED)).toBe(true);
    expect(canMarkPaidByHand({ ...prompted, status: OrderStatus.PENDING, paymentRequestedAt: null }, OrderStatus.PAID)).toBe(true);
  });

  it('lets an order already past payment keep moving', () => {
    expect(canMarkPaidByHand({ ...prompted, status: OrderStatus.PAID }, OrderStatus.PROCESSING)).toBe(true);
  });
});
