/**
 * The vendor sales summary against a real Postgres (its queries are raw SQL).
 * Opt-in: RUN_DB_TESTS=1 npx vitest run src/payout/sales-summary.db.spec.ts
 */
import { OrderStatus } from '@prisma/client';
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { SalesSummaryService } from './sales-summary.service.js';

describe.skipIf(!process.env.RUN_DB_TESTS)('sales summary (real database)', () => {
  const prisma = new PrismaService();
  const sales = new SalesSummaryService(prisma);
  const stamp = Date.now();
  const now = new Date();
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  let userId = '';
  let tenantId = '';
  let n = 0;

  const order = (data: { buyer: string; daysAgo: number; total: number; status?: OrderStatus; items: [string, number, number][]; rating?: number }) =>
    prisma.order.create({
      data: {
        tenantId,
        orderNumber: `SALESTEST-${stamp}-${++n}`,
        buyerPhone: data.buyer,
        status: data.status ?? OrderStatus.DELIVERED,
        totalAmount: data.total,
        createdAt: daysAgo(data.daysAgo),
        ...(data.rating && { buyerRating: data.rating, ratedAt: daysAgo(data.daysAgo), deliveryConfirmedAt: daysAgo(data.daysAgo) }),
        items: { create: data.items.map(([productName, quantity, unitPrice]) => ({ productName, quantity, unitPrice, totalPrice: quantity * unitPrice })) },
      },
    });

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { email: `salestest-${stamp}@example.invalid`, password: 'x', firstName: 'Sales', lastName: 'Test' } });
    userId = user.id;
    tenantId = (await prisma.tenant.create({ data: { name: 'Sales Test Shop', slug: `salestest-${stamp}`, userId } })).id;

    await order({ buyer: '+233240000001', daysAgo: 1, total: 100, items: [['Tomatoes', 10, 10]], rating: 5 });
    await order({ buyer: '+233240000001', daysAgo: 20, total: 50, items: [['Onions', 5, 10]], rating: 2 });
    await order({ buyer: '+233240000002', daysAgo: 3, total: 30, status: OrderStatus.PAID, items: [['Onions', 3, 10]] });
    await order({ buyer: '+233240000003', daysAgo: 10, total: 40, items: [['Yam', 2, 20]], rating: 4 });
    await order({ buyer: '+233240000004', daysAgo: 2, total: 999, status: OrderStatus.CANCELLED, items: [['Gold', 1, 999]] });
    await order({ buyer: '+233240000005', daysAgo: 2, total: 999, status: OrderStatus.AWAITING_PAYMENT, items: [['Gold', 1, 999]] });
    await order({ buyer: '+233240000006', daysAgo: 45, total: 70, items: [['Yam', 3, 20]] }); // outside the window
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } }); // cascades to the shop and its orders
    await prisma.$disconnect();
  });

  it('compares the last 7 days with the 7 before, counting only paid orders', async () => {
    const summary = await sales.forShop(tenantId, now);
    expect(summary.thisWeek).toEqual({ sales: 13000, orders: 2 });
    expect(summary.lastWeek).toEqual({ sales: 4000, orders: 1 });
  });

  it('lists best sellers over 30 days by sales', async () => {
    const { bestSellers } = await sales.forShop(tenantId, now);
    expect(bestSellers.map(({ name, quantity, sales }) => ({ name, quantity, sales }))).toEqual([
      { name: 'Tomatoes', quantity: 10, sales: 10000 },
      { name: 'Onions', quantity: 8, sales: 8000 },
      { name: 'Yam', quantity: 2, sales: 4000 },
    ]);
  });

  it('counts buyers in the window and how many came back', async () => {
    expect((await sales.forShop(tenantId, now)).buyers).toEqual({ total: 3, repeat: 1 });
  });

  it('averages ratings and lists recent low ones', async () => {
    const { rating } = await sales.forShop(tenantId, now);
    expect(rating).toMatchObject({ average: 3.7, count: 3 });
    expect(rating.recentLow).toEqual([expect.objectContaining({ rating: 2, orderNumber: `SALESTEST-${stamp}-2` })]);
  });
});
