import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OrderService } from './order.service.js';
import { OrderStatus } from '@prisma/client';

describe('OrderService', () => {
  let service: OrderService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      tenant: {
        findUnique: vi.fn(),
      },
      order: {
        create: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    };

    service = new OrderService(prisma);
  });

  it('creates an order with line items and calculates total amount correctly', async () => {
    prisma.order.create.mockImplementation(({ data }: any) => ({
      id: 'order-123',
      orderNumber: 'ORD-123',
      ...data,
    }));

    const result = await service.createOrder('tenant-1', {
      buyerPhone: '+233500000000',
      items: [
        { productName: 'Tomatoes', unitPrice: 10, quantity: 2 },
        { productName: 'Onions', unitPrice: 5, quantity: 3 },
      ],
    });

    expect(prisma.order.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        buyerPhone: '+233500000000',
        sessionId: null,
        status: OrderStatus.PENDING,
        totalAmount: 35,
        notes: null,
        items: {
          create: [
            {
              productId: null,
              productName: 'Tomatoes',
              unitPrice: 10,
              quantity: 2,
              totalPrice: 20,
            },
            {
              productId: null,
              productName: 'Onions',
              unitPrice: 5,
              quantity: 3,
              totalPrice: 15,
            },
          ],
        },
      },
      include: {
        items: true,
        session: true,
      },
    });

    expect(result.id).toBe('order-123');
    expect(result.totalAmount).toBe(35);
  });

  it('lists orders for vendor tenant with pagination', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', userId: 'user-1' });
    prisma.order.findMany.mockResolvedValue([
      { id: 'o1', buyerPhone: '+233500000000', totalAmount: 35 },
    ]);
    prisma.order.count.mockResolvedValue(1);

    const result = await service.findAll('user-1', 1, 10);

    expect(result.data).toHaveLength(1);
    expect(result.meta.total).toBe(1);
  });

  it('updates order status successfully', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', userId: 'user-1' });
    prisma.order.findFirst.mockResolvedValue({ id: 'order-1', tenantId: 'tenant-1' });
    prisma.order.update.mockResolvedValue({ id: 'order-1', status: OrderStatus.CONFIRMED });

    const result = await service.updateStatus('user-1', 'order-1', {
      status: OrderStatus.CONFIRMED,
    });

    expect(result.status).toBe(OrderStatus.CONFIRMED);
  });
});
