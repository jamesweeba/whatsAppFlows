/**
 * Promoter commission and withdrawals against a real Postgres (locks, aggregates, unique
 * ledger rows). Opt-in: RUN_DB_TESTS=1 npx vitest run src/payout/promoter-payout.db.spec.ts
 * It makes a throwaway shop, promoter and orders and deletes them afterwards; Paystack is faked.
 */
import { LedgerEntryType, OrderStatus, PaymentMethod, PayoutStatus, PromoterMembershipStatus, PromoterStatus, TenantStatus } from '@prisma/client';
import 'dotenv/config';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { PayoutService } from './payout.service.js';
import { PROMOTER_MIN_WITHDRAWAL, PromoterPayoutService } from './promoter-payout.service.js';

describe.skipIf(!process.env.RUN_DB_TESTS)('promoter commission and payouts (real database)', () => {
  const prisma = new PrismaService();
  const transfers = { fakeMode: null, createMomoRecipient: vi.fn(), transfer: vi.fn(), verifyTransfer: vi.fn() };
  const notifications = { toPromoter: vi.fn(), payoutPaid: vi.fn(), payoutFailed: vi.fn() };
  const promoterPayouts = new PromoterPayoutService(prisma, transfers as any, notifications as any);
  const payouts = new PayoutService(prisma, transfers as any, notifications as any, promoterPayouts);
  const stamp = Date.now();
  const digits = String(stamp).slice(-6);
  let userId = '';
  let tenantId = '';
  let promoterId = '';
  const promoterPhone = `+23324${digits}7`;
  let n = 0;

  /** A delivered order of GH₵ 150 items + GH₵ 10 delivery from a new buyer, credited to the promoter at 10%. */
  const referredOrder = async (opts: { paymentMethod?: PaymentMethod; paymentPhone?: string } = {}) => {
    const cod = opts.paymentMethod === PaymentMethod.COD;
    const order = await prisma.order.create({
      data: {
        tenantId,
        orderNumber: `PPT-${stamp}-${++n}`,
        buyerPhone: `+23320${digits}${n}`,
        status: OrderStatus.DELIVERED,
        paymentMethod: opts.paymentMethod ?? PaymentMethod.MOMO,
        paymentPhone: opts.paymentPhone ?? null,
        totalAmount: 160,
        deliveryFee: 10,
        deliveryConfirmedAt: new Date(),
        ...(!cod && { paystackPaidAt: new Date(), paystackAmount: 16000 }),
      },
    });
    await prisma.referral.create({
      data: {
        tenantId, buyerPhone: order.buyerPhone, promoterId, linkCode: 'TSTLNK', ratePercent: 10,
        tappedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), orderId: order.id, attachedAt: new Date(), baseAmount: 15000, commissionAmount: 1500,
      },
    });
    return order;
  };
  const vendorEntries = (orderId: string) => prisma.vendorLedgerEntry.findMany({ where: { orderId }, orderBy: { amount: 'desc' } });
  const promoterBalance = () => promoterPayouts.fundsOf(prisma, promoterId);
  /** Makes all the promoter's held commission withdrawable now. */
  const releaseHolds = () => prisma.promoterLedgerEntry.updateMany({ where: { promoterId }, data: { availableAt: null } });

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { email: `ppaytest-${stamp}@example.invalid`, password: 'x', firstName: 'P', lastName: 'T' } });
    userId = user.id;
    tenantId = (await prisma.tenant.create({ data: { name: 'Promoter Pay Shop', slug: `ppaytest-${stamp}`, userId, status: TenantStatus.ACTIVE, promotionsEnabled: true, promoterRate: 10 } })).id;
    const promoter = await prisma.promoter.create({
      data: { phone: promoterPhone, fullName: 'Ama Mensah', momoNumber: '0244111222', momoNetwork: 'MTN', momoName: 'AMA MENSAH', status: PromoterStatus.ACTIVE, signupStep: null },
    });
    promoterId = promoter.id;
    await prisma.promoterMembership.create({ data: { tenantId, promoterId, status: PromoterMembershipStatus.APPROVED } });
  });

  afterAll(async () => {
    await prisma.promoterLedgerEntry.deleteMany({ where: { promoterId } });
    await prisma.promoterPayout.deleteMany({ where: { promoterId } });
    await prisma.promoter.delete({ where: { id: promoterId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    vi.stubEnv('PAYOUTS_ENABLED', 'true');
    vi.clearAllMocks();
    transfers.createMomoRecipient.mockResolvedValue({ ok: true, code: 'RCP_TEST' });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("takes the commission off the vendor's earning and holds it for the promoter, once", async () => {
    const order = await referredOrder();
    await payouts.settleOrder(order.id);
    await payouts.settleOrder(order.id); // a second settle changes nothing

    const entries = await vendorEntries(order.id);
    expect(entries.map((e) => [e.type, e.amount])).toEqual([
      [LedgerEntryType.ORDER_EARNING, 14500], // GH₵ 150 − 10% + GH₵ 10 delivery
      [LedgerEntryType.PROMOTER_COMMISSION, -1500],
    ]);
    const credits = await prisma.promoterLedgerEntry.findMany({ where: { promoterId, orderId: order.id } });
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ amount: 1500, shopName: 'Promoter Pay Shop', orderNumber: order.orderNumber });
    const holdDays = (credits[0].availableAt!.getTime() - Date.now()) / 86_400_000;
    expect(holdDays).toBeGreaterThan(6.9);
    expect(notifications.toPromoter).toHaveBeenCalledWith(promoterPhone, expect.stringContaining('You earned *GH₵ 15.00*'));
    expect(await promoterBalance()).toMatchObject({ balance: 1500, available: 0, onHold: 1500 });
  });

  it('pays nothing on a cash order or when the promoter paid for it themselves', async () => {
    const cash = await referredOrder({ paymentMethod: PaymentMethod.COD });
    const own = await referredOrder({ paymentPhone: '0244111222' });
    await payouts.settleOrder(cash.id);
    await payouts.settleOrder(own.id);
    expect((await vendorEntries(cash.id)).map((e) => e.type)).toEqual([LedgerEntryType.CASH_COMMISSION]);
    expect((await vendorEntries(own.id)).map((e) => e.type)).toEqual([LedgerEntryType.ORDER_EARNING]);
    expect(await prisma.promoterLedgerEntry.count({ where: { orderId: { in: [cash.id, own.id] } } })).toBe(0);
  });

  it('refuses a withdrawal while the money is held or under GH₵ 20', async () => {
    const held = await promoterPayouts.withdraw(promoterId);
    expect(held).toMatchObject({ kind: 'refused' });
    expect((held as any).message).toContain('on its way');

    await releaseHolds(); // GH₵ 15 available: still under the minimum
    expect(PROMOTER_MIN_WITHDRAWAL).toBe(2000);
    expect(await promoterPayouts.withdraw(promoterId)).toMatchObject({ kind: 'refused' });
  });

  it('withdraws everything available, once a day', async () => {
    await payouts.settleOrder((await referredOrder()).id);
    await releaseHolds(); // GH₵ 30 available
    transfers.transfer.mockResolvedValue({ ok: true, status: 'success', transferCode: 'TRF_1' });

    expect(await promoterPayouts.withdraw(promoterId)).toEqual({ kind: 'paid', amount: 3000, momoNumber: '0244111222' });
    expect(transfers.transfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 3000, recipientCode: 'RCP_TEST' }));
    expect(await promoterBalance()).toMatchObject({ balance: 0, available: 0 });
    // The bot tells them the result itself; no second "it landed" message.
    expect(notifications.toPromoter).not.toHaveBeenCalledWith(promoterPhone, expect.stringContaining('has been sent'));

    await payouts.settleOrder((await referredOrder()).id);
    await payouts.settleOrder((await referredOrder()).id);
    await releaseHolds();
    expect(await promoterPayouts.withdraw(promoterId)).toEqual({ kind: 'refused', message: 'You can withdraw once a day. Try again tomorrow.' });
  });

  it('puts a failed transfer back in the balance, and lets them try again the same day', async () => {
    await prisma.promoterPayout.updateMany({ where: { promoterId }, data: { createdAt: new Date(Date.now() - 2 * 86_400_000) } }); // yesterday's
    transfers.transfer.mockResolvedValueOnce({ ok: false, reason: 'Recipient rejected' });
    const failed = await promoterPayouts.withdraw(promoterId);
    expect(failed).toEqual({ kind: 'failed', amount: 3000, momoNumber: '0244111222' });
    expect(await promoterBalance()).toMatchObject({ balance: 3000, available: 3000 });

    transfers.transfer.mockResolvedValueOnce({ ok: true, status: 'pending', transferCode: 'TRF_2' });
    const retry = await promoterPayouts.withdraw(promoterId);
    expect(retry).toMatchObject({ kind: 'processing', amount: 3000 });

    // Paystack's webhook confirms it: checked with Paystack, then the promoter is told.
    const payout = await prisma.promoterPayout.findFirstOrThrow({ where: { promoterId, status: PayoutStatus.PROCESSING } });
    transfers.verifyTransfer.mockResolvedValue({ state: 'success' });
    expect(await promoterPayouts.handleTransferEvent('transfer.success', { reference: payout.reference })).toBe(true);
    expect((await prisma.promoterPayout.findUniqueOrThrow({ where: { id: payout.id } })).status).toBe(PayoutStatus.SUCCESS);
    await vi.waitFor(() => expect(notifications.toPromoter).toHaveBeenCalledWith(promoterPhone, expect.stringContaining('GH₵ 30.00 has been sent')));
  });

  it("ignores transfer webhooks that aren't promoter payouts", async () => {
    expect(await promoterPayouts.handleTransferEvent('transfer.success', { reference: 'payout_someone_else' })).toBe(false);
  });

  it('refuses when payouts are switched off or the promoter is suspended', async () => {
    vi.stubEnv('PAYOUTS_ENABLED', 'false');
    expect(await promoterPayouts.withdraw(promoterId)).toMatchObject({ kind: 'refused', message: expect.stringContaining('aren’t available yet') });
    vi.stubEnv('PAYOUTS_ENABLED', 'true');
    await prisma.promoter.update({ where: { id: promoterId }, data: { status: PromoterStatus.SUSPENDED } });
    expect(await promoterPayouts.withdraw(promoterId)).toMatchObject({ kind: 'refused', message: expect.stringContaining('paused') });
    await prisma.promoter.update({ where: { id: promoterId }, data: { status: PromoterStatus.ACTIVE } });
  });
});
