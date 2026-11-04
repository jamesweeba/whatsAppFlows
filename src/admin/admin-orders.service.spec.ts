import { OrderStatus, TenantStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANCELLED_ORDER_STATUSES,
  DELIVERED_ORDER_STATUSES,
  OPEN_ORDER_STATUSES,
  PLACED_ORDER_STATUSES,
  UNPAID_ORDER_STATUSES,
} from '../order/order-status-groups.js';
import { AdminOrdersService } from './admin-orders.service.js';

describe('order status groups', () => {
  it('splits every status into exactly one of open, delivered, cancelled or unpaid', () => {
    const groups = [OPEN_ORDER_STATUSES, DELIVERED_ORDER_STATUSES, CANCELLED_ORDER_STATUSES, UNPAID_ORDER_STATUSES].flat();
    expect([...groups].sort()).toEqual(Object.values(OrderStatus).sort());
  });

  it('counts an order as placed once paid or confirmed, cancelled or not, but never while unpaid', () => {
    expect(PLACED_ORDER_STATUSES).toContain(OrderStatus.CANCELLED);
    expect(PLACED_ORDER_STATUSES).not.toContain(OrderStatus.AWAITING_PAYMENT);
  });
});

describe('AdminOrdersService.shopOrders', () => {
  let prisma: any;
  let service: AdminOrdersService;

  beforeEach(() => {
    prisma = {
      tenant: { findUnique: vi.fn() },
      order: { findMany: vi.fn() },
      $queryRaw: vi.fn(),
    };
    service = new AdminOrdersService(prisma);
  });

  it('404s for an unknown shop', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    await expect(service.shopOrders('t1', { range: {} })).rejects.toThrow('Shop not found.');
  });

  it('returns the page in newest-first order, with item counts, tab counts and the shop ref', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 't1', refNumber: 101, name: 'Mama Abena Tomatoes', market: 'Kejetia', status: TenantStatus.ACTIVE, whatsappNumber: null });
    prisma.$queryRaw
      .mockResolvedValueOnce([{ orders: 3, open: 1, deliveredSales: 120, buyers: 2 }])
      .mockResolvedValueOnce([
        { status: OrderStatus.CONFIRMED, count: 1 },
        { status: OrderStatus.DELIVERED, count: 1 },
        { status: OrderStatus.CANCELLED, count: 1 },
        { status: OrderStatus.AWAITING_PAYMENT, count: 4 },
      ])
      .mockResolvedValueOnce([{ id: 'o2' }, { id: 'o1' }]);
    prisma.order.findMany.mockResolvedValue([
      { id: 'o1', orderNumber: 'A', _count: { items: 1 } },
      { id: 'o2', orderNumber: 'B', _count: { items: 3 } },
    ]);

    const result = await service.shopOrders('t1', { range: {}, page: 1, limit: 2 });

    expect(result.shop).toMatchObject({ id: 't1', ref: 'MX-V-0101' });
    expect(result.data).toEqual([
      { id: 'o2', orderNumber: 'B', itemCount: 3 },
      { id: 'o1', orderNumber: 'A', itemCount: 1 },
    ]);
    expect(result.counts).toEqual({ placed: 3, open: 1, delivered: 1, cancelled: 1, unpaid: 4, all: 7 });
    expect(result.meta).toEqual({ total: 3, page: 1, limit: 2, totalPages: 2 });
  });
});
