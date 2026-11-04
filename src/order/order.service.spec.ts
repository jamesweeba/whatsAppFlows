import { OrderStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantService } from '../tenant/tenant.service.js';
import { OrderService } from './order.service.js';

describe('OrderService', () => {
  let service: OrderService;
  let prisma: any;
  let waba: any;

  beforeEach(() => {
    prisma = {
      tenant: { findUnique: vi.fn() },
      order: {
        create: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    };

    waba = { sendTextMessage: vi.fn().mockResolvedValue({ messageId: 'wamid-1' }) };
    service = new OrderService(prisma, new TenantService(prisma, { vendorWelcome: vi.fn() } as any), waba);
  });

  it('creates an order with line items and calculates total amount including delivery fee', async () => {
    prisma.order.create.mockImplementation(({ data }: any) => ({ id: 'order-123', ...data }));

    const result = await service.createOrder('tenant-1', {
      buyerPhone: '+233500000000',
      deliveryFee: 5,
      items: [
        { productName: 'Tomatoes', unitPrice: 10, quantity: 2 },
        { productName: 'Onions', unitPrice: 5, quantity: 3 },
      ],
    });

    expect(prisma.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        orderNumber: expect.stringMatching(/^MX-[A-Z2-9]{6}$/),
        buyerPhone: '+233500000000',
        sessionId: null,
        status: OrderStatus.PENDING,
        totalAmount: 40,
        deliveryFee: 5,
        notes: null,
        items: {
          create: [
            { productId: null, productName: 'Tomatoes', measureCode: null, unitPrice: 10, quantity: 2, totalPrice: 20 },
            { productId: null, productName: 'Onions', measureCode: null, unitPrice: 5, quantity: 3, totalPrice: 15 },
          ],
        },
      }),
      include: { items: true, session: true },
    });

    expect(result.id).toBe('order-123');
    expect(result.totalAmount).toBe(40);
  });

  it('retries with a fresh reference when the order number collides', async () => {
    const collision = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: ['orderNumber'] },
    });
    Object.setPrototypeOf(collision, (await import('@prisma/client')).Prisma.PrismaClientKnownRequestError.prototype);

    prisma.order.create
      .mockRejectedValueOnce(collision)
      .mockImplementationOnce(({ data }: any) => ({ id: 'order-2', ...data }));

    const result = await service.createOrder('tenant-1', {
      buyerPhone: '+233500000000',
      items: [{ productName: 'Tomatoes', unitPrice: 10, quantity: 1 }],
    });

    expect(prisma.order.create).toHaveBeenCalledTimes(2);
    const [first, second] = prisma.order.create.mock.calls.map((c: any) => c[0].data.orderNumber);
    expect(first).not.toBe(second);
    expect(result.id).toBe('order-2');
  });

  it('generates distinct, human-friendly order numbers', () => {
    const refs = new Set(Array.from({ length: 200 }, () => service.generateOrderNumber()));
    expect(refs.size).toBe(200);
    for (const ref of refs) expect(ref).toMatch(/^MX-[A-Z2-9]{6}$/);
  });

  it('lists orders for vendor tenant with pagination', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', userId: 'user-1' });
    prisma.order.findMany.mockResolvedValue([{ id: 'o1', buyerPhone: '+233500000000', totalAmount: 35 }]);
    prisma.order.count.mockResolvedValue(1);

    const result = await service.findAll('user-1', 1, 10);

    expect(result.data).toHaveLength(1);
    expect(result.meta.total).toBe(1);
  });

  const updatedOrder = (status: OrderStatus, extra: Record<string, any> = {}) => ({
    id: 'order-1',
    orderNumber: 'MX-ABC123',
    status,
    buyerPhone: '+233240000000',
    totalAmount: 250,
    paymentMethod: 'COD',
    riderName: null,
    riderPhone: null,
    tenant: { whatsappPhoneNumberId: 'phone-1' },
    ...extra,
  });

  it('updates order status successfully', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', userId: 'user-1' });
    prisma.order.findFirst.mockResolvedValue({ id: 'order-1', tenantId: 'tenant-1', status: OrderStatus.PENDING });
    prisma.order.update.mockResolvedValue(updatedOrder(OrderStatus.CONFIRMED));

    const result = await service.updateStatus('user-1', 'order-1', { status: OrderStatus.CONFIRMED });

    expect(result.status).toBe(OrderStatus.CONFIRMED);
    expect(result).not.toHaveProperty('tenant');
    expect(waba.sendTextMessage).not.toHaveBeenCalled();
  });

  it('messages the buyer with the rider details when the order is dispatched', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', userId: 'user-1' });
    prisma.order.findFirst.mockResolvedValue({ id: 'order-1', tenantId: 'tenant-1', status: OrderStatus.PROCESSING });
    prisma.order.update.mockResolvedValue(updatedOrder(OrderStatus.OUT_FOR_DELIVERY, { riderName: 'Kofi', riderPhone: '0244000000' }));

    await service.updateStatus('user-1', 'order-1', { status: OrderStatus.OUT_FOR_DELIVERY, riderName: 'Kofi', riderPhone: '0244000000' });

    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ riderName: 'Kofi', riderPhone: '0244000000' }) }),
    );
    expect(waba.sendTextMessage).toHaveBeenCalledWith(
      'phone-1',
      '+233240000000',
      expect.stringMatching(/MX-ABC123\* is on its way![\s\S]*Rider: Kofi, 0244000000[\s\S]*GH₵250\.00\* ready in cash/),
    );
  });

  it('sends packed and delivered updates, but nothing when the status is unchanged', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', userId: 'user-1' });
    prisma.order.findFirst.mockResolvedValue({ id: 'order-1', tenantId: 'tenant-1', status: OrderStatus.CONFIRMED });
    prisma.order.update.mockResolvedValue(updatedOrder(OrderStatus.PROCESSING));
    await service.updateStatus('user-1', 'order-1', { status: OrderStatus.PROCESSING });
    expect(waba.sendTextMessage).toHaveBeenLastCalledWith('phone-1', '+233240000000', expect.stringContaining('is packed'));

    prisma.order.update.mockResolvedValue(updatedOrder(OrderStatus.DELIVERED));
    await service.updateStatus('user-1', 'order-1', { status: OrderStatus.DELIVERED });
    expect(waba.sendTextMessage).toHaveBeenLastCalledWith('phone-1', '+233240000000', expect.stringContaining('has been delivered'));

    waba.sendTextMessage.mockClear();
    prisma.order.findFirst.mockResolvedValue({ id: 'order-1', tenantId: 'tenant-1', status: OrderStatus.DELIVERED });
    await service.updateStatus('user-1', 'order-1', { status: OrderStatus.DELIVERED, notes: 'left at gate' });
    expect(waba.sendTextMessage).not.toHaveBeenCalled();
  });

  it('attaches a location pin to the newest order that asked for one in the last 30 minutes', async () => {
    prisma.order.findFirst.mockResolvedValue({ id: 'order-1' });
    prisma.order.update.mockResolvedValue({ id: 'order-1', orderNumber: 'MX-ABC123' });

    const result = await service.attachLocation('tenant-1', '+233240000000', { latitude: 6.67, longitude: -1.57, name: 'Unity Hall' });

    const where = prisma.order.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId: 'tenant-1', buyerPhone: '+233240000000' });
    expect(Date.now() - where.locationRequestedAt.gte.getTime()).toBeCloseTo(30 * 60 * 1000, -3);
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: expect.objectContaining({ locationLatitude: 6.67, locationLongitude: -1.57, locationName: 'Unity Hall', locationAddress: null }),
    });
    expect(result?.orderNumber).toBe('MX-ABC123');
  });

  it('returns null for a pin when no order is waiting for one', async () => {
    prisma.order.findFirst.mockResolvedValue(null);
    expect(await service.attachLocation('tenant-1', '+233240000000', { latitude: 1, longitude: 2 })).toBeNull();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('rejects vendor requests when the user has no tenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    await expect(service.findAll('user-1')).rejects.toThrow('You do not have a tenant yet.');
  });
});
