/**
 * Admin tools for promoters against a real Postgres (aggregates, audit log, payouts).
 * Opt-in: RUN_DB_TESTS=1 npx vitest run src/admin/admin-promoters.db.spec.ts
 * It makes a throwaway admin, shop and promoters and deletes them afterwards; Paystack is faked.
 */
import { ConflictException } from '@nestjs/common';
import { AuditAction, OrderStatus, PaymentMethod, PayoutStatus, PromoterLedgerEntryType, PromoterMembershipStatus, PromoterStatus, TenantStatus, UserRole } from '@prisma/client';
import 'dotenv/config';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromoterPayoutService } from '../payout/promoter-payout.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReferralService } from '../promoter/referral.service.js';
import { AdminPromotersService } from './admin-promoters.service.js';
import { AuditService } from './audit.service.js';

describe.skipIf(!process.env.RUN_DB_TESTS)('admin promoters (real database)', () => {
  const prisma = new PrismaService();
  const transfers = { fakeMode: null, createMomoRecipient: vi.fn(), transfer: vi.fn(), verifyTransfer: vi.fn() };
  const notifications = { toPromoter: vi.fn() };
  const promoterPayouts = new PromoterPayoutService(prisma, transfers as any, notifications as any);
  const service = new AdminPromotersService(prisma, promoterPayouts, new AuditService(prisma), notifications as any);
  const referrals = new ReferralService(prisma);
  const stamp = Date.now();
  const digits = String(stamp).slice(-6);
  const name = `Zzadmin${digits}`;
  const userIds: string[] = [];
  let adminId = '';
  let tenantId = '';
  let amaId = '';
  let kofiId = '';

  const ledger = (promoterId: string, amount: number, type: PromoterLedgerEntryType = PromoterLedgerEntryType.COMMISSION) =>
    prisma.promoterLedgerEntry.create({ data: { promoterId, type, amount, shopName: 'Admin Test Shop' } });

  beforeAll(async () => {
    const admin = await prisma.user.create({ data: { email: `promoadmin-${stamp}@example.invalid`, password: 'x', firstName: 'Ada', lastName: 'Admin', role: UserRole.SUPER_ADMIN } });
    const vendor = await prisma.user.create({ data: { email: `promoadminshop-${stamp}@example.invalid`, password: 'x', firstName: 'V', lastName: 'T' } });
    userIds.push(admin.id, vendor.id);
    adminId = admin.id;
    tenantId = (await prisma.tenant.create({ data: { name: 'Admin Test Shop', slug: `promoadmin-${stamp}`, userId: vendor.id, status: TenantStatus.ACTIVE, promotionsEnabled: true, promoterRate: 10 } })).id;
    const mk = (n: number, first: string) =>
      prisma.promoter.create({
        data: { phone: `+23324${digits}${n}`, fullName: `${first} ${name}`, momoNumber: `024${digits}${n}`, momoNetwork: 'MTN', momoVerifiedAt: new Date(), status: PromoterStatus.ACTIVE, signupStep: null },
      });
    amaId = (await mk(1, 'Ama')).id;
    kofiId = (await mk(2, 'Kofi')).id;
    await prisma.promoterMembership.create({ data: { tenantId, promoterId: amaId, status: PromoterMembershipStatus.APPROVED } });

    // Kofi has an order where he paid with his own MoMo: a fraud flag.
    const order = await prisma.order.create({
      data: { tenantId, orderNumber: `ADM-${stamp}`, buyerPhone: '+233200000001', paymentPhone: `024${digits}2`, status: OrderStatus.PAID, paymentMethod: PaymentMethod.MOMO, totalAmount: 110, deliveryFee: 10 },
    });
    await prisma.referral.create({
      data: { tenantId, buyerPhone: order.buyerPhone, promoterId: kofiId, linkCode: 'ADMLNK', ratePercent: 10, tappedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), orderId: order.id, baseAmount: 10000, commissionAmount: 1000 },
    });
    await ledger(amaId, 4000);
  });

  afterAll(async () => {
    await prisma.promoterLedgerEntry.deleteMany({ where: { promoterId: { in: [amaId, kofiId] } } });
    await prisma.promoterPayout.deleteMany({ where: { promoterId: { in: [amaId, kofiId] } } });
    await prisma.promoter.deleteMany({ where: { id: { in: [amaId, kofiId] } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }); // audit rows stay: the log is append-only
    await prisma.$disconnect();
  });

  beforeEach(() => {
    vi.stubEnv('PAYOUTS_ENABLED', 'true');
    vi.clearAllMocks();
    transfers.createMomoRecipient.mockResolvedValue({ ok: true, code: 'RCP_TEST' });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('lists and searches promoters with their shops, money and fraud flags', async () => {
    const { data } = await service.list({ search: name });
    const ama = data.find((p) => p.id === amaId)!;
    const kofi = data.find((p) => p.id === kofiId)!;
    expect(ama).toMatchObject({ shops: 1, earned: 4000, balance: 4000, available: 4000, ownNumberOrders: 0, momo: { verified: true } });
    expect(kofi).toMatchObject({ shops: 0, orders: 1, buyers: 1, ownNumberOrders: 1 });

    expect((await service.list({ search: `24${digits}1` })).data.map((p) => p.id)).toEqual([amaId]); // by phone digits
    expect((await service.list({ search: name, status: 'suspended' })).data).toEqual([]);
  });

  it('shows one promoter in detail', async () => {
    const detail = await service.detail(kofiId);
    expect(detail.referrals).toHaveLength(1);
    expect(detail.referrals[0]).toMatchObject({ state: 'NO_COMMISSION', reason: 'OWN_NUMBER', tenant: { name: 'Admin Test Shop' } });
    expect((await service.detail(amaId)).shops[0]).toMatchObject({ status: PromoterMembershipStatus.APPROVED, tenant: { name: 'Admin Test Shop' } });
  });

  it('suspends with a reason, logs it, and stops new orders being credited; reinstates', async () => {
    await referrals.recordTap(tenantId, '+233200000077', '(ref ZZZZZZ)'); // no such link: just making sure nothing throws
    const suspended = await service.suspend(adminId, kofiId, 'Paid for his own orders');
    expect(suspended).toMatchObject({ status: PromoterStatus.SUSPENDED, suspendedReason: 'Paid for his own orders' });
    expect(notifications.toPromoter).toHaveBeenCalledWith(`+23324${digits}2`, expect.stringContaining('paused'));
    await expect(service.suspend(adminId, kofiId, 'again')).rejects.toBeInstanceOf(ConflictException);

    const log = await prisma.auditLog.findFirstOrThrow({ where: { actorId: adminId, action: AuditAction.PROMOTER_SUSPENDED }, orderBy: { createdAt: 'desc' } });
    expect(log.details).toContain('Paid for his own orders');
    expect(log.metadata).toMatchObject({ promoterId: kofiId });

    // A buyer who tapped Kofi's link before the suspension isn't credited to him now.
    const buyer = '+233200000088';
    await prisma.referral.create({
      data: { tenantId, buyerPhone: buyer, promoterId: kofiId, linkCode: 'ADMLNK', ratePercent: 10, tappedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) },
    });
    const order = await prisma.order.create({
      data: { tenantId, orderNumber: `ADM2-${stamp}`, buyerPhone: buyer, status: OrderStatus.AWAITING_PAYMENT, paymentMethod: PaymentMethod.MOMO, totalAmount: 110, deliveryFee: 10 },
      include: { items: true },
    });
    expect(await referrals.attachToOrder(order)).toBeNull();

    expect((await service.reinstate(adminId, kofiId)).status).toBe(PromoterStatus.ACTIVE);
    await expect(service.reinstate(adminId, kofiId)).rejects.toBeInstanceOf(ConflictException);
  });

  it('retries a failed payout by sending the whole available balance, and logs it', async () => {
    transfers.transfer.mockResolvedValueOnce({ ok: false, reason: 'Recipient rejected' });
    expect(await promoterPayouts.withdraw(amaId)).toMatchObject({ kind: 'failed', amount: 4000 });
    const failed = await prisma.promoterPayout.findFirstOrThrow({ where: { promoterId: amaId, status: PayoutStatus.FAILED } });

    const listed = await service.payoutList({ status: 'failed', search: name });
    expect(listed.data.find((p) => p.id === failed.id)).toMatchObject({ superseded: false, byAdmin: false, failureReason: 'Recipient rejected', promoter: { id: amaId } });
    expect((await service.summary()).failedPayouts).toBeGreaterThanOrEqual(1);

    transfers.transfer.mockResolvedValueOnce({ ok: true, status: 'success', transferCode: 'TRF_RETRY' });
    const retried = await service.retryPayout(adminId, failed.id);
    expect(retried).toMatchObject({ status: PayoutStatus.SUCCESS, amount: 4000, byAdmin: true });
    await vi.waitFor(() => expect(notifications.toPromoter).toHaveBeenCalledWith(`+23324${digits}1`, expect.stringContaining('GH₵ 40.00 has been sent')));
    expect(await prisma.auditLog.count({ where: { actorId: adminId, action: AuditAction.PROMOTER_PAYOUT_RETRIED } })).toBe(1);

    // The old failure now has a newer payout after it: nothing left to retry.
    await expect(service.retryPayout(adminId, failed.id)).rejects.toThrow('newer payout');
    const after = await service.payoutList({ search: name });
    expect(after.data.find((p) => p.id === failed.id)?.superseded).toBe(true);
  });

  it("an admin's payout doesn't use up the promoter's own withdrawal for the day", async () => {
    await ledger(amaId, 2500);
    transfers.transfer.mockResolvedValueOnce({ ok: true, status: 'success', transferCode: 'TRF_SELF' });
    expect(await promoterPayouts.withdraw(amaId)).toMatchObject({ kind: 'paid', amount: 2500 });
  });
});
