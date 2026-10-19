import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderStatus } from '@prisma/client';
import { PaymentController } from './payment.controller.js';

describe('PaymentController', () => {
  let controller: PaymentController;
  let mockPaystackService: any;
  let mockPrisma: any;
  let mockWaba: any;

  beforeEach(() => {
    mockPaystackService = {
      verifyWebhookSignature: vi.fn().mockReturnValue(true),
    };

    mockPrisma = {
      order: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    };

    mockWaba = {
      sendTextMessage: vi.fn().mockResolvedValue({ messageId: 'wamid-confirm' }),
    };

    controller = new PaymentController(mockPaystackService, mockPrisma, mockWaba);
  });

  it('updates order status to PAID and sends WhatsApp confirmation on charge.success', async () => {
    const mockOrder = {
      id: 'order-123',
      orderNumber: 'MX-4567',
      totalAmount: 35.0,
      status: OrderStatus.AWAITING_PAYMENT,
      buyerPhone: '+233240000000',
      tenant: {
        name: 'Fresh Market',
        whatsappPhoneNumberId: 'phone-id-123',
      },
    };

    mockPrisma.order.findUnique.mockResolvedValue(mockOrder);
    mockPrisma.order.update.mockResolvedValue({ ...mockOrder, status: OrderStatus.PAID });

    const req: any = {
      body: {
        event: 'charge.success',
        data: {
          reference: 'MX-4567',
          amount: 3500,
          channel: 'mobile_money',
          paid_at: '2026-10-19T17:00:00Z',
        },
      },
      rawBody: JSON.stringify({ event: 'charge.success' }),
    };

    const result = await controller.handlePaystackWebhook(req, 'valid-signature');

    expect(result).toEqual({ status: 'PROCESSED', reference: 'MX-4567' });
    expect(mockPrisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-123' },
        data: expect.objectContaining({
          status: OrderStatus.PAID,
        }),
      }),
    );

    expect(mockWaba.sendTextMessage).toHaveBeenCalledWith(
      'phone-id-123',
      '+233240000000',
      expect.stringContaining('Payment Confirmed'),
    );
  });

  it('is idempotent when order is already marked as PAID', async () => {
    const mockOrder = {
      id: 'order-123',
      orderNumber: 'MX-4567',
      totalAmount: 35.0,
      status: OrderStatus.PAID,
    };

    mockPrisma.order.findUnique.mockResolvedValue(mockOrder);

    const req: any = {
      body: {
        event: 'charge.success',
        data: {
          reference: 'MX-4567',
          amount: 3500,
        },
      },
      rawBody: '{}',
    };

    const result = await controller.handlePaystackWebhook(req, 'sig');

    expect(result).toEqual({ status: 'ALREADY_PAID', reference: 'MX-4567' });
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
    expect(mockWaba.sendTextMessage).not.toHaveBeenCalled();
  });
});
