import { OrderStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantService } from '../tenant/tenant.service.js';
import { orderRatingTap, OrderService, orderReceivedTap } from './order.service.js';

describe('OrderService', () => {
  let service: OrderService;
  let prisma: any;
  let waba: any;
  let payouts: any;

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
        updateMany: vi.fn(),
      },
    };

    waba = {
      sendTextMessage: vi.fn().mockResolvedValue({ messageId: 'wamid-1' }),
      sendInteractiveButtons: vi.fn().mockResolvedValue({ messageId: 'wamid-2' }),
      sendInteractiveList: vi.fn().mockResolvedValue({ messageId: 'wamid-3' }),
    };
    payouts = { settleOrder: vi.fn().mockResolvedValue(null) };
    service = new OrderService(prisma, new TenantService(prisma, { vendorWelcome: vi.fn() } as any), waba, payouts, { attachToOrder: vi.fn() } as any);
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
    expect(waba.sendInteractiveButtons).toHaveBeenCalledWith({
      phoneNumberId: 'phone-1',
      toPhone: '+233240000000',
      bodyText: expect.stringMatching(/MX-ABC123\* is on its way![\s\S]*Rider: Kofi, 0244000000[\s\S]*GH₵250\.00\* ready in cash/),
      buttons: [{ id: 'order_received:MX-ABC123', title: '✅ I got my order' }],
    });
    expect(waba.sendTextMessage).not.toHaveBeenCalled();
  });

  it('falls back to plain text when WhatsApp refuses the button message', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', userId: 'user-1' });
    prisma.order.findFirst.mockResolvedValue({ id: 'order-1', tenantId: 'tenant-1', status: OrderStatus.PROCESSING });
    prisma.order.update.mockResolvedValue(updatedOrder(OrderStatus.OUT_FOR_DELIVERY));
    waba.sendInteractiveButtons.mockRejectedValue(new Error('outside the 24h window'));

    await service.updateStatus('user-1', 'order-1', { status: OrderStatus.OUT_FOR_DELIVERY });
    expect(waba.sendTextMessage).toHaveBeenCalledWith('phone-1', '+233240000000', expect.stringContaining('is on its way'));
  });

  describe('buyer taps "I got my order"', () => {
    const order = (status: OrderStatus, extra: Record<string, unknown> = {}) => ({
      id: 'order-1', tenantId: 'tenant-1', orderNumber: 'MX-ABC123', buyerPhone: '+233240000000', status, deliveryConfirmedAt: null, ...extra,
    });

    it('reads the order number from the button id', () => {
      expect(orderReceivedTap('order_received:MX-ABC123')).toBe('MX-ABC123');
      expect(orderReceivedTap('order received please')).toBeNull();
    });

    it('marks an out-for-delivery order DELIVERED, matching the phone in any format', async () => {
      prisma.order.findFirst.mockResolvedValue(order(OrderStatus.OUT_FOR_DELIVERY));
      prisma.order.updateMany.mockResolvedValue({ count: 1 });

      const reply = await service.confirmReceivedByBuyer('tenant-1', '233240000000', 'MX-ABC123');
      expect(reply).toContain('marked as received');
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', status: OrderStatus.OUT_FOR_DELIVERY },
        data: { status: OrderStatus.DELIVERED, deliveryConfirmedAt: expect.any(Date) },
      });
      expect(prisma.order.findFirst).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1', orderNumber: 'MX-ABC123' } });
    });

    it("ignores a tap from someone else's number (e.g. a forwarded message)", async () => {
      prisma.order.findFirst.mockResolvedValue(order(OrderStatus.OUT_FOR_DELIVERY));
      const reply = await service.confirmReceivedByBuyer('tenant-1', '+233209999999', 'MX-ABC123');
      expect(reply).toContain("couldn't find order");
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('records the confirmation on an order the vendor already marked delivered', async () => {
      prisma.order.findFirst.mockResolvedValue(order(OrderStatus.DELIVERED));
      expect(await service.confirmReceivedByBuyer('tenant-1', '+233240000000', 'MX-ABC123')).toContain('already marked as received');
      expect(prisma.order.update).toHaveBeenCalledWith({ where: { id: 'order-1' }, data: { deliveryConfirmedAt: expect.any(Date) } });
    });

    it('changes nothing on a cancelled order or one not yet dispatched', async () => {
      prisma.order.findFirst.mockResolvedValue(order(OrderStatus.CANCELLED));
      expect(await service.confirmReceivedByBuyer('tenant-1', '+233240000000', 'MX-ABC123')).toContain('was cancelled');
      prisma.order.findFirst.mockResolvedValue(order(OrderStatus.PROCESSING));
      expect(await service.confirmReceivedByBuyer('tenant-1', '+233240000000', 'MX-ABC123')).toContain("isn't out for delivery yet");
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('treats a second tap (the race lost) as already received', async () => {
      prisma.order.findFirst
        .mockResolvedValueOnce(order(OrderStatus.OUT_FOR_DELIVERY))
        .mockResolvedValueOnce(order(OrderStatus.DELIVERED, { deliveryConfirmedAt: new Date() }));
      prisma.order.updateMany.mockResolvedValue({ count: 0 });
      expect(await service.confirmReceivedByBuyer('tenant-1', '+233240000000', 'MX-ABC123')).toContain('already marked as received');
    });
  });

  describe('buyer ratings', () => {
    const tenant = { id: 'tenant-1', name: 'Fresh Market', whatsappPhoneNumberId: 'phone-1' };
    const order = (extra: Record<string, unknown> = {}) => ({
      id: 'order-1', tenantId: 'tenant-1', orderNumber: 'MX-ABC123', buyerPhone: '+233240000000', status: OrderStatus.DELIVERED,
      deliveryConfirmedAt: new Date(), buyerRating: null, ratingRequestedAt: null, ...extra,
    });

    it('reads the order and stars from the list row id', () => {
      expect(orderRatingTap('rate_order:MX-ABC123:4')).toEqual({ orderNumber: 'MX-ABC123', rating: 4 });
      expect(orderRatingTap('rate_order:MX-ABC123:6')).toBeNull();
      expect(orderRatingTap('rate_order:MX-ABC123:0')).toBeNull();
      expect(orderRatingTap('5 stars')).toBeNull();
    });

    it('asks once, with five choices, after the buyer confirms', async () => {
      prisma.order.findFirst.mockResolvedValue(order());
      prisma.order.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

      await service.requestRating(tenant, '233240000000', 'MX-ABC123');
      await service.requestRating(tenant, '233240000000', 'MX-ABC123'); // a double tap
      expect(waba.sendInteractiveList).toHaveBeenCalledTimes(1);
      const list = waba.sendInteractiveList.mock.calls[0][0];
      expect(list).toMatchObject({ phoneNumberId: 'phone-1', toPhone: '233240000000', buttonText: 'Rate your order' });
      expect(list.rows.map((r: any) => r.id)).toEqual([5, 4, 3, 2, 1].map((n) => `rate_order:MX-ABC123:${n}`));
      expect(prisma.order.updateMany).toHaveBeenCalledWith({ where: { id: 'order-1', ratingRequestedAt: null }, data: { ratingRequestedAt: expect.any(Date) } });
    });

    it("doesn't ask about an unconfirmed, already rated or someone else's order", async () => {
      for (const o of [order({ deliveryConfirmedAt: null }), order({ buyerRating: 5 }), order({ buyerPhone: '+233209999999' })]) {
        prisma.order.findFirst.mockResolvedValue(o);
        await service.requestRating(tenant, '+233240000000', 'MX-ABC123');
      }
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(waba.sendInteractiveList).not.toHaveBeenCalled();
    });

    it('lets the buyer be asked again if the list could not be sent', async () => {
      prisma.order.findFirst.mockResolvedValue(order());
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      waba.sendInteractiveList.mockRejectedValue(new Error('outside window'));
      await service.requestRating(tenant, '+233240000000', 'MX-ABC123');
      expect(prisma.order.update).toHaveBeenCalledWith({ where: { id: 'order-1' }, data: { ratingRequestedAt: null } });
    });

    it('records a rating once, from the buyer of a received order', async () => {
      prisma.order.findFirst.mockResolvedValue(order());
      prisma.order.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

      expect(await service.rateByBuyer('tenant-1', '233240000000', 'MX-ABC123', 5)).toContain('Thank you for rating');
      expect(prisma.order.updateMany).toHaveBeenCalledWith({ where: { id: 'order-1', buyerRating: null }, data: { buyerRating: 5, ratedAt: expect.any(Date) } });
      expect(await service.rateByBuyer('tenant-1', '233240000000', 'MX-ABC123', 1)).toContain('already rated');
    });

    it('says sorry for a low rating', async () => {
      prisma.order.findFirst.mockResolvedValue(order());
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      expect(await service.rateByBuyer('tenant-1', '+233240000000', 'MX-ABC123', 2)).toContain("sorry order *MX-ABC123* wasn't great");
    });

    it("ignores ratings for someone else's order or one not received", async () => {
      prisma.order.findFirst.mockResolvedValue(order({ buyerPhone: '+233209999999' }));
      expect(await service.rateByBuyer('tenant-1', '+233240000000', 'MX-ABC123', 5)).toContain("couldn't find order");
      prisma.order.findFirst.mockResolvedValue(order({ deliveryConfirmedAt: null }));
      expect(await service.rateByBuyer('tenant-1', '+233240000000', 'MX-ABC123', 5)).toContain('once you have it');
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });
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
