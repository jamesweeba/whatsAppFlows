/**
 * Referrals against a real Postgres: recording link taps and crediting first orders.
 * Opt-in: RUN_DB_TESTS=1 npx vitest run src/promoter/referral.db.spec.ts
 * It makes throwaway shops, promoters and orders and deletes them afterwards.
 */
import { OrderStatus, PaymentMethod, PromoterMembershipStatus, PromoterStatus, TenantStatus } from '@prisma/client';
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { referralMessage } from './promoter-rules.js';
import { ReferralService } from './referral.service.js';

describe.skipIf(!process.env.RUN_DB_TESTS)('referrals (real database)', () => {
  const prisma = new PrismaService();
  const service = new ReferralService(prisma);
  const stamp = Date.now();
  const digits = String(stamp).slice(-6);
  let buyerN = 0;
  /** A fresh buyer number, so each test starts with a new customer. */
  const newBuyer = () => `+23320${digits}${String(++buyerN).padStart(1, '0')}`;
  const userIds: string[] = [];
  let shopId = '';
  let otherShopId = '';
  let riceId = '';
  let ama: { id: string; phone: string };
  let shopLink = '';
  let riceLink = '';
  let kofiLink = '';
  let otherShopLink = '';
  let n = 0;

  const makeShop = async (name: string) => {
    const user = await prisma.user.create({ data: { email: `referral-${stamp}-${++n}@example.invalid`, password: 'x', firstName: 'R', lastName: 'T' } });
    userIds.push(user.id);
    const tenant = await prisma.tenant.create({
      data: { name, slug: `referral-${stamp}-${n}`, userId: user.id, status: TenantStatus.ACTIVE, promotionsEnabled: true, promoterRate: 10 },
    });
    return tenant.id;
  };
  const makePromoter = (phone: string, name: string) =>
    prisma.promoter.create({ data: { phone, fullName: name, momoNumber: `05${digits}${n}9`, status: PromoterStatus.ACTIVE, signupStep: null } });
  const approve = async (tenantId: string, promoterId: string, links: { code: string; productId?: string }[]) => {
    const membership = await prisma.promoterMembership.create({ data: { tenantId, promoterId, status: PromoterMembershipStatus.APPROVED } });
    for (const l of links) await prisma.promoLink.create({ data: { code: l.code, membershipId: membership.id, tenantId, promoterId, productId: l.productId } });
  };
  /** A buyer's order: GH₵ 100 of rice + GH₵ 50 of oil + GH₵ 10 delivery unless told otherwise. */
  const placeOrder = async (buyerPhone: string, opts: { tenantId?: string; status?: OrderStatus; paymentMethod?: PaymentMethod; rice?: boolean; vendorCreated?: boolean } = {}) => {
    const items = [
      ...(opts.rice === false ? [] : [{ productId: riceId, productName: 'Rice', unitPrice: 100, quantity: 1, totalPrice: 100 }]),
      { productId: null, productName: 'Oil', unitPrice: 50, quantity: 1, totalPrice: 50 },
    ];
    const total = items.reduce((sum, i) => sum + i.totalPrice, 0) + 10;
    const order = await prisma.order.create({
      data: {
        tenantId: opts.tenantId ?? shopId,
        orderNumber: `REF-${stamp}-${++n}`,
        buyerPhone,
        status: opts.status ?? OrderStatus.AWAITING_PAYMENT,
        paymentMethod: opts.paymentMethod ?? PaymentMethod.MOMO,
        totalAmount: total,
        deliveryFee: 10,
        vendorCreated: opts.vendorCreated ?? false,
        items: { create: items },
      },
      include: { items: true },
    });
    return { order, referral: await service.attachToOrder(order) };
  };

  beforeAll(async () => {
    shopId = await makeShop('Referral Test Shop');
    otherShopId = await makeShop('Other Referral Shop');
    riceId = (await prisma.product.create({ data: { name: 'Rice', price: 100, tenantId: shopId, promoterRate: 15 } })).id;
    ama = await makePromoter(`+23324${digits}1`, 'Ama');
    const kofi = await makePromoter(`+23324${digits}2`, 'Kofi');
    const code = (prefix: string) => `${prefix}${digits.slice(0, 5)}`.replace(/[01]/g, 'X');
    shopLink = code('A');
    riceLink = code('B');
    kofiLink = code('C');
    otherShopLink = code('D');
    await approve(shopId, ama.id, [{ code: shopLink }, { code: riceLink, productId: riceId }]);
    await approve(shopId, kofi.id, [{ code: kofiLink }]);
    await approve(otherShopId, ama.id, [{ code: otherShopLink }]);
  });

  afterAll(async () => {
    await prisma.promoter.deleteMany({ where: { phone: { startsWith: `+23324${digits}` } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it('records a tap at the shop rate, or the product rate for a product link', async () => {
    const shop = await service.recordTap(shopId, newBuyer(), referralMessage(shopLink));
    expect(shop).toMatchObject({ promoterId: ama.id, linkCode: shopLink, productId: null, ratePercent: 10, orderId: null });
    const days = (shop!.expiresAt.getTime() - shop!.tappedAt.getTime()) / 86_400_000;
    expect(days).toBe(14);

    const rice = await service.recordTap(shopId, newBuyer(), referralMessage(riceLink, 'Rice'));
    expect(rice).toMatchObject({ productId: riceId, productName: 'Rice', ratePercent: 15 });
  });

  it("ignores messages without a code, unknown codes, other shops' links and the promoter's own number", async () => {
    expect(await service.recordTap(shopId, newBuyer(), 'Hi, I want rice')).toBeNull();
    expect(await service.recordTap(shopId, newBuyer(), '(ref ZZZZZZ)')).toBeNull();
    expect(await service.recordTap(shopId, newBuyer(), referralMessage(otherShopLink))).toBeNull();
    expect(await service.recordTap(shopId, ama.phone, referralMessage(shopLink))).toBeNull();
  });

  it('ignores links that are off', async () => {
    await prisma.promoLink.update({ where: { code: kofiLink }, data: { active: false } });
    expect(await service.recordTap(shopId, newBuyer(), referralMessage(kofiLink))).toBeNull();
    await prisma.promoLink.update({ where: { code: kofiLink }, data: { active: true } });
  });

  it('credits only a new customer’s first order, with the commission worked out', async () => {
    const buyer = newBuyer();
    await service.recordTap(shopId, buyer, referralMessage(shopLink));
    const first = await placeOrder(buyer, { status: OrderStatus.PAID });
    expect(first.referral).toMatchObject({ orderId: first.order.id, baseAmount: 15000, commissionAmount: 1500 });

    // A second order earns nothing, and a new tap from the same buyer is not recorded.
    expect((await placeOrder(buyer, { status: OrderStatus.PAID })).referral).toBeNull();
    expect(await service.recordTap(shopId, buyer, referralMessage(kofiLink))).toBeNull();
  });

  it("doesn't let an order the vendor entered use up the buyer's first order", async () => {
    const buyer = newBuyer();
    await service.recordTap(shopId, buyer, referralMessage(shopLink));
    // The vendor records a "confirmed" order for the referred buyer before the buyer orders.
    await prisma.order.create({
      data: { tenantId: shopId, orderNumber: `REF-${stamp}-${++n}`, buyerPhone: buyer, status: OrderStatus.CONFIRMED, totalAmount: 1, vendorCreated: true },
    });
    const real = await placeOrder(buyer, { status: OrderStatus.PAID });
    expect(real.referral).toMatchObject({ orderId: real.order.id, commissionAmount: 1500 });
  });

  it('gives the order to the last link tapped', async () => {
    const buyer = newBuyer();
    await service.recordTap(shopId, buyer, referralMessage(shopLink));
    await new Promise((r) => setTimeout(r, 5));
    await service.recordTap(shopId, buyer, referralMessage(kofiLink));
    const { referral } = await placeOrder(buyer);
    expect(referral?.linkCode).toBe(kofiLink);
  });

  it('restarts the 14 days when the same link is tapped again, without a second record', async () => {
    const buyer = newBuyer();
    const first = await service.recordTap(shopId, buyer, referralMessage(shopLink));
    const again = await service.recordTap(shopId, buyer, referralMessage(shopLink));
    expect(again?.id).toBe(first?.id);
    expect(await prisma.referral.count({ where: { tenantId: shopId, buyerPhone: buyer } })).toBe(1);
  });

  it('moves to the next order when the first is cancelled', async () => {
    const buyer = newBuyer();
    await service.recordTap(shopId, buyer, referralMessage(shopLink));
    const cancelled = await placeOrder(buyer, { status: OrderStatus.PAID });
    await prisma.order.update({ where: { id: cancelled.order.id }, data: { status: OrderStatus.CANCELLED } });

    const next = await placeOrder(buyer, { status: OrderStatus.PAID });
    expect(next.referral?.orderId).toBe(next.order.id);
    expect(await prisma.referral.count({ where: { orderId: cancelled.order.id } })).toBe(0);
  });

  it('does not credit an order placed after the 14 days', async () => {
    const buyer = newBuyer();
    const referral = await service.recordTap(shopId, buyer, referralMessage(shopLink));
    await prisma.referral.update({ where: { id: referral!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await placeOrder(buyer)).referral).toBeNull();
  });

  it('credits a product link with GH₵ 0 when the first order lacks the product', async () => {
    const buyer = newBuyer();
    await service.recordTap(shopId, buyer, referralMessage(riceLink, 'Rice'));
    const { referral } = await placeOrder(buyer, { rice: false });
    expect(referral).toMatchObject({ baseAmount: 0, commissionAmount: 0 });
  });

  it("lists the shop's credited orders with their state, and totals per promoter", async () => {
    const buyer = newBuyer();
    await service.recordTap(shopId, buyer, referralMessage(shopLink));
    const { order } = await placeOrder(buyer, { status: OrderStatus.DELIVERED });
    await prisma.order.update({ where: { id: order.id }, data: { paystackPaidAt: new Date() } });
    const cash = newBuyer();
    await service.recordTap(shopId, cash, referralMessage(shopLink));
    await placeOrder(cash, { status: OrderStatus.CONFIRMED, paymentMethod: PaymentMethod.COD });
    const gaveUp = newBuyer(); // cancelled, and never ordered again
    await service.recordTap(shopId, gaveUp, referralMessage(shopLink));
    const dropped = await placeOrder(gaveUp, { status: OrderStatus.PAID });
    await prisma.order.update({ where: { id: dropped.order.id }, data: { status: OrderStatus.CANCELLED } });

    const sales = await service.salesForShop(shopId, { page: 1, limit: 50 });
    const byOrder = new Map(sales.data.map((row) => [row.order?.id, row]));
    expect(byOrder.get(order.id)).toMatchObject({ state: 'EARNED', commissionAmount: 1500, promoter: { fullName: 'Ama' }, link: { code: shopLink } });
    expect(sales.data.some((row) => row.state === 'NO_COMMISSION' && row.reason === 'CASH')).toBe(true);
    expect(sales.data.some((row) => row.state === 'NO_COMMISSION' && row.reason === 'CANCELLED')).toBe(true);

    const stats = (await service.statsForShop(shopId)).get(ama.id)!;
    expect(stats.buyers).toBeGreaterThanOrEqual(stats.orders);
    expect(stats.orders).toBeGreaterThan(0);
    expect(stats.commission).toBeGreaterThanOrEqual(1500);
  });
});
