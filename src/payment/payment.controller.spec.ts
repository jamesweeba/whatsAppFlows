import { OrderStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentController } from './payment.controller.js';

describe('PaymentController', () => {
  let controller: PaymentController;
  let paystack: any;
  let orders: any;
  let waba: any;

  const webhook = (data: Record<string, any>, event = 'charge.success'): any => ({
    body: { event, data },
    rawBody: Buffer.from(JSON.stringify({ event, data })),
  });

  beforeEach(() => {
    paystack = { verifyWebhookSignature: vi.fn().mockReturnValue(true) };
    orders = { findByOrderNumber: vi.fn(), markPaid: vi.fn().mockResolvedValue({}) };
    waba = { sendTextMessage: vi.fn().mockResolvedValue({ messageId: 'wamid-confirm' }) };

    controller = new PaymentController(paystack, orders, waba);
  });

  it('updates order status to PAID and sends WhatsApp confirmation on charge.success', async () => {
    orders.findByOrderNumber.mockResolvedValue({
      id: 'order-123',
      orderNumber: 'MX-4567',
      totalAmount: 35.0,
      status: OrderStatus.AWAITING_PAYMENT,
      buyerPhone: '+233240000000',
      notes: null,
      tenant: { name: 'Fresh Market', whatsappPhoneNumberId: 'phone-id-123' },
    });

    const result = await controller.handlePaystackWebhook(
      webhook({ reference: 'MX-4567', amount: 3500, channel: 'mobile_money', paid_at: '2026-10-19T17:00:00Z' }),
      'valid-signature',
    );

    expect(result).toEqual({ status: 'PROCESSED', reference: 'MX-4567' });
    expect(orders.markPaid).toHaveBeenCalledWith('order-123', expect.stringContaining('GH₵35.00 via mobile_money'));
    expect(waba.sendTextMessage).toHaveBeenCalledWith('phone-id-123', '+233240000000', expect.stringContaining('Payment Confirmed'));
  });

  it('is idempotent when order is already marked as PAID', async () => {
    orders.findByOrderNumber.mockResolvedValue({ id: 'order-123', orderNumber: 'MX-4567', totalAmount: 35.0, status: OrderStatus.PAID });

    const result = await controller.handlePaystackWebhook(webhook({ reference: 'MX-4567', amount: 3500 }), 'sig');

    expect(result).toEqual({ status: 'ALREADY_PAID', reference: 'MX-4567' });
    expect(orders.markPaid).not.toHaveBeenCalled();
    expect(waba.sendTextMessage).not.toHaveBeenCalled();
  });

  it('rejects webhooks with an invalid signature before touching any order', async () => {
    paystack.verifyWebhookSignature.mockReturnValue(false);

    await expect(controller.handlePaystackWebhook(webhook({ reference: 'MX-4567' }), 'bad')).rejects.toThrow('Invalid signature');
    expect(orders.findByOrderNumber).not.toHaveBeenCalled();
  });

  it('ignores events other than charge.success', async () => {
    const result = await controller.handlePaystackWebhook(webhook({ reference: 'MX-1' }, 'charge.failed'), 'sig');
    expect(result).toEqual({ status: 'IGNORED', event: 'charge.failed' });
  });
});
