/**
 * Runs the payout flow against a real Postgres (advisory locks, aggregates and raw SQL
 * can't be faked). Opt-in: RUN_DB_TESTS=1 npx vitest run src/payout/payout.db.spec.ts
 * It makes a throwaway shop and deletes it afterwards; Paystack is faked.
 */
import { OrderStatus, PaymentMethod, PayoutSource, PayoutStatus, TenantStatus } from '@prisma/client';
import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { PayoutReportService } from './payout-report.service.js';
import { PayoutService } from './payout.service.js';

describe.skipIf(!process.env.RUN_DB_TESTS)('payouts (real database)', () => {
  const prisma = new PrismaService();
  const transfers = {
    createMomoRecipient: vi.fn(),
    transfer: vi.fn(),
    verifyTransfer: vi.fn(),
  };
  const service = new PayoutService(prisma, transfers as any);
  const reports = new PayoutReportService(prisma, service);
  /** The vendor withdraws `amount` (default: the whole balance). */
  const withdraw = async (amount?: number) => service.withdraw(tenantId, userId, amount ?? (await balance()));
  /** Moves the shop's payouts a day back, as if they were made yesterday. */
  const yesterday = () =>
    prisma.vendorPayout.updateMany({ where: { tenantId }, data: { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
  const stamp = Date.now();
  let userId = '';
  let tenantId = '';
  let n = 0;

  const order = (data: Partial<{ paymentMethod: PaymentMethod; status: OrderStatus; totalAmount: number; deliveryFee: number; paid: boolean; confirmed: boolean; paystackAmount: number }>) =>
    prisma.order.create({
      data: {
        tenantId,
        orderNumber: `PAYTEST-${stamp}-${++n}`,
        buyerPhone: '+233240000000',
        status: data.status ?? OrderStatus.DELIVERED,
        paymentMethod: data.paymentMethod ?? PaymentMethod.MOMO,
        totalAmount: data.totalAmount ?? 1050,
        deliveryFee: data.deliveryFee ?? 50,
        ...(data.paid !== false && data.paymentMethod !== PaymentMethod.COD && { paystackPaidAt: new Date(), paystackAmount: data.paystackAmount ?? 105000 }),
        ...(data.confirmed !== false && { deliveryConfirmedAt: new Date() }),
      },
    });
  const balance = () => service.balanceOf(prisma, tenantId);

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { email: `paytest-${stamp}@example.invalid`, password: 'x', firstName: 'Pay', lastName: 'Test' } });
    userId = user.id;
    const tenant = await prisma.tenant.create({
      data: { name: 'Payout Test Shop', slug: `paytest-${stamp}`, userId, momoNumber: '0244111222', momoName: 'Ama Mensah', status: 'ACTIVE' },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } }); // cascades to the shop, its orders, ledger and payouts
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    process.env.PAYOUTS_ENABLED = 'true';
    transfers.createMomoRecipient.mockReset().mockResolvedValue({ ok: true, code: 'RCP_test' });
    transfers.transfer.mockReset().mockResolvedValue({ ok: true, status: 'pending', transferCode: 'TRF_test' });
    transfers.verifyTransfer.mockReset().mockResolvedValue({ state: 'success' });
    await prisma.vendorLedgerEntry.deleteMany({ where: { tenantId } });
    await prisma.vendorPayout.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { status: TenantStatus.ACTIVE, payoutsPaused: false, momoNumber: '0244111222', paystackRecipientCode: null, paystackRecipientFor: null },
    });
  });

  it('credits 90% of the items plus the delivery fee when the buyer confirms; nothing is sent until the vendor withdraws', async () => {
    const o = await order({});
    await service.settleOrder(o.id);
    expect(await balance()).toBe(95000);
    expect(transfers.transfer).not.toHaveBeenCalled();

    const payout = await withdraw(40000);

    expect(payout).toMatchObject({ amount: 40000, status: PayoutStatus.PROCESSING, momoNumber: '0244111222', source: PayoutSource.VENDOR, initiatedById: userId });
    expect(transfers.createMomoRecipient).toHaveBeenCalledWith({ name: 'Ama Mensah', momoNumber: '0244111222', network: 'MTN' });
    expect(transfers.transfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 40000, recipientCode: 'RCP_test' }));
    expect(await balance()).toBe(55000); // taken off the balance at once
  });

  it('allows one withdrawal per Accra day, and says when the next one is', async () => {
    await service.settleOrder((await order({})).id);
    const first = await withdraw(10000);
    await service.handleTransferEvent('transfer.success', { reference: first.reference });

    await expect(withdraw(10000)).rejects.toThrow('once a day');
    const next = (await reports.shopSummary(tenantId)).payouts.nextWithdrawalAt;
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    expect(next?.toISOString()).toBe(midnight.toISOString());

    await yesterday();
    expect((await reports.shopSummary(tenantId)).payouts.nextWithdrawalAt).toBeNull();
    expect(await withdraw(10000)).toMatchObject({ amount: 10000 });
  });

  it('lets the vendor try again the same day after a failed withdrawal', async () => {
    transfers.transfer.mockResolvedValueOnce({ ok: false, reason: 'Insufficient balance' });
    await service.settleOrder((await order({})).id);
    const failed = await withdraw();
    expect(failed).toMatchObject({ status: PayoutStatus.FAILED, failureReason: 'Insufficient balance' });
    expect(await balance()).toBe(95000);
    expect((await reports.shopSummary(tenantId)).payouts.nextWithdrawalAt).toBeNull();

    expect(await withdraw()).toMatchObject({ amount: 95000, status: PayoutStatus.PROCESSING });
  });

  it('refuses amounts under GH₵ 1, over the balance, or while one is on its way', async () => {
    await service.settleOrder((await order({})).id);
    await expect(withdraw(99)).rejects.toThrow('least you can withdraw');
    await expect(withdraw(100.5)).rejects.toThrow('least you can withdraw');
    await expect(withdraw(95001)).rejects.toThrow('up to GH₵ 950.00');

    await withdraw(1000);
    await yesterday(); // not the daily limit: the first one is still on its way
    await expect(withdraw(1000)).rejects.toThrow('Wait for your last withdrawal');
  });

  it('pays one of two withdrawals made at the same moment', async () => {
    await service.settleOrder((await order({})).id);
    const results = await Promise.allSettled([withdraw(1000), withdraw(1000), withdraw(1000)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(transfers.transfer).toHaveBeenCalledTimes(1);
    expect(await balance()).toBe(94000);
  });

  it('records an order once, however often it is settled', async () => {
    const o = await order({});
    await Promise.all([service.settleOrder(o.id), service.settleOrder(o.id), service.settleOrder(o.id)]);
    expect(await prisma.vendorLedgerEntry.count({ where: { orderId: o.id } })).toBe(1);
    expect(await balance()).toBe(95000);
  });

  it('waits for the buyer, unless an admin releases the order', async () => {
    const o = await order({ confirmed: false });
    await service.settleOrder(o.id);
    expect(await balance()).toBe(0);
    expect((await service.awaitingConfirmation(tenantId)).amount).toBe(95000);

    await service.settleOrder(o.id, { released: true });
    await withdraw();
    expect(transfers.transfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 95000 }));
  });

  it('never pays for an order MarketiX was not paid for', async () => {
    const o = await order({ paid: false });
    await service.settleOrder(o.id);
    expect(await prisma.vendorLedgerEntry.count({ where: { tenantId } })).toBe(0);
  });

  it('takes the 10% on cash orders off the balance', async () => {
    const cash = await order({ paymentMethod: PaymentMethod.COD, totalAmount: 310, deliveryFee: 10 }); // GH₵ 300 items
    await service.settleOrder(cash.id);
    expect(await balance()).toBe(-3000);
    await expect(withdraw(100)).rejects.toThrow('Nothing to withdraw');

    await service.settleOrder((await order({})).id);
    await expect(withdraw(95000)).rejects.toThrow('up to GH₵ 920.00');
    await withdraw();
    expect(transfers.transfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 95000 - 3000 }));
  });

  it("lets an admin pay now or retry without using up the vendor's day", async () => {
    transfers.transfer.mockResolvedValueOnce({ ok: false, reason: 'Insufficient balance' });
    await service.settleOrder((await order({})).id);
    await withdraw(5000); // fails
    expect((await reports.adminSummary()).failedPayouts).toBeGreaterThanOrEqual(1);
    expect((await reports.payoutList({ tenantId })).data[0]).toMatchObject({ status: 'FAILED', superseded: false });

    const retried = await service.payTenant(tenantId, null);
    expect(retried).toMatchObject({ amount: 95000, status: PayoutStatus.PROCESSING, source: PayoutSource.ADMIN });
    expect(transfers.createMomoRecipient).toHaveBeenCalledTimes(1); // recipient reused
    const [newest, old] = (await reports.payoutList({ tenantId })).data;
    expect([newest.id, newest.superseded, old.superseded]).toEqual([retried.id, false, true]);
    expect((await reports.balances({ search: 'Payout Test Shop' })).data[0].lastPayoutFailed).toBe(false);

    await service.handleTransferEvent('transfer.success', { reference: retried.reference });
    await service.settleOrder((await order({})).id);
    expect((await reports.shopSummary(tenantId)).payouts.nextWithdrawalAt).toBeNull();
    const own = await withdraw(); // the admin's payout didn't count
    await service.handleTransferEvent('transfer.success', { reference: own.reference });
    await service.settleOrder((await order({})).id);
    expect(await service.payTenant(tenantId, null)).toMatchObject({ amount: 95000 }); // and the vendor's doesn't block the admin
  });

  it('settles from Paystack webhooks, and a reversal after success refunds the balance once', async () => {
    await service.settleOrder((await order({})).id);
    const payout = await withdraw();
    await service.handleTransferEvent('transfer.success', { reference: payout.reference });
    expect(await prisma.vendorPayout.findUnique({ where: { id: payout.id } })).toMatchObject({ status: PayoutStatus.SUCCESS });

    transfers.verifyTransfer.mockResolvedValue({ state: 'failed', reason: 'Reversed by the network' });
    await service.handleTransferEvent('transfer.reversed', { reference: payout.reference });
    await service.handleTransferEvent('transfer.reversed', { reference: payout.reference });
    expect(await balance()).toBe(95000);
    expect(await service.handleTransferEvent('transfer.success', { reference: 'not-ours' })).toBe(false);
  });

  it('holds money while paused, switched off, suspended or without a MoMo number, and says why', async () => {
    await service.settleOrder((await order({})).id);

    await prisma.tenant.update({ where: { id: tenantId }, data: { payoutsPaused: true } });
    await expect(withdraw()).rejects.toThrow('on hold');
    await expect(service.payTenant(tenantId, null)).rejects.toThrow('paused');

    await prisma.tenant.update({ where: { id: tenantId }, data: { payoutsPaused: false, status: TenantStatus.SUSPENDED } });
    await expect(withdraw()).rejects.toThrow('suspended');

    await prisma.tenant.update({ where: { id: tenantId }, data: { status: TenantStatus.ACTIVE, momoNumber: null } });
    await expect(withdraw()).rejects.toThrow('Add your MoMo number');

    process.env.PAYOUTS_ENABLED = '';
    await expect(withdraw()).rejects.toThrow('aren’t available yet');
    await expect(service.payTenant(tenantId, null)).rejects.toThrow('turned off');
    expect(transfers.transfer).not.toHaveBeenCalled();
    expect(await balance()).toBe(95000);
  });

  it('reports balances and totals for the vendor and admin pages', async () => {
    const cash = await order({ paymentMethod: PaymentMethod.COD, totalAmount: 310, deliveryFee: 10 });
    await service.settleOrder(cash.id);
    await service.settleOrder((await order({})).id);
    const p = await withdraw();
    await service.handleTransferEvent('transfer.success', { reference: p.reference });

    const summary = await reports.shopSummary(tenantId);
    expect(summary).toMatchObject({
      balance: 0,
      inFlight: 0,
      totals: { earned: 95000, commissionOnPaidOrders: 10000, commissionOnCashOrders: 3000, paidOut: 92000 },
    });
    const statement = await reports.shopEntries(tenantId, {});
    expect(statement.data.map((e) => e.type)).toEqual(['PAYOUT', 'ORDER_EARNING', 'CASH_COMMISSION']);

    const balances = await reports.balances({ search: 'Payout Test Shop' });
    expect(balances.data[0]).toMatchObject({ name: 'Payout Test Shop', balance: 0, paidOut: 92000 });
    const admin = await reports.adminSummary();
    expect(admin.last30Days.commission).toBeGreaterThanOrEqual(13000);
  });

  // ── Money safety: a transfer is only refunded when Paystack confirms it didn't go out ──

  /** Makes the shop's in-flight payouts look 11 minutes old, so they're checked with Paystack. */
  const makeStale = () =>
    prisma.$executeRaw`UPDATE "VendorPayout" SET "updatedAt" = NOW() - INTERVAL '11 minutes' WHERE "tenantId" = ${tenantId}`;

  it('keeps a transfer Paystack may have sent in flight (not refunded) when its reply is unclear', async () => {
    transfers.transfer.mockResolvedValueOnce({ ok: false, unknown: true, reason: 'Could not reach Paystack.' });
    await service.settleOrder((await order({})).id);
    const payout = await withdraw();

    expect(payout).toMatchObject({ status: PayoutStatus.PROCESSING });
    expect(await balance()).toBe(0); // still taken off: it may have gone out
    await yesterday();
    await expect(withdraw(100)).rejects.toThrow('Wait for your last withdrawal');
  });

  it('refunds a stuck transfer once Paystack says it never got it', async () => {
    transfers.transfer.mockResolvedValueOnce({ ok: false, unknown: true, reason: 'timeout' });
    await service.settleOrder((await order({})).id);
    const payout = await withdraw();

    transfers.verifyTransfer.mockResolvedValue({ state: 'not_found' });
    await reports.shopSummary(tenantId); // not stale yet: left alone
    expect(await balance()).toBe(0);

    await makeStale();
    const summary = await reports.shopSummary(tenantId);
    expect(summary).toMatchObject({ balance: 95000, inFlight: 0 });
    expect(await prisma.vendorPayout.findUnique({ where: { id: payout.id } })).toMatchObject({ status: PayoutStatus.FAILED });
    expect(transfers.verifyTransfer).toHaveBeenCalledWith(payout.reference);
  });

  it('marks a stuck transfer paid when Paystack says it went out, without refunding it', async () => {
    transfers.transfer.mockResolvedValueOnce({ ok: false, unknown: true, reason: 'timeout' });
    await service.settleOrder((await order({})).id);
    const payout = await withdraw();
    await makeStale();

    await reports.shopSummary(tenantId);
    expect(await prisma.vendorPayout.findUnique({ where: { id: payout.id } })).toMatchObject({ status: PayoutStatus.SUCCESS });
    expect(await balance()).toBe(0);
  });

  it('ignores a "failed" or "reversed" webhook when Paystack says the transfer was paid (e.g. a replay)', async () => {
    await service.settleOrder((await order({})).id);
    const payout = await withdraw();
    transfers.verifyTransfer.mockResolvedValue({ state: 'success' });

    await service.handleTransferEvent('transfer.failed', { reference: payout.reference });
    await service.handleTransferEvent('transfer.reversed', { reference: payout.reference });

    expect(await prisma.vendorPayout.findUnique({ where: { id: payout.id } })).toMatchObject({ status: PayoutStatus.SUCCESS });
    expect(await balance()).toBe(0);
  });

  it('takes the money off again when a payout marked failed turns out to have been paid', async () => {
    transfers.transfer.mockResolvedValueOnce({ ok: true, status: 'pending', transferCode: 'TRF_1' });
    await service.settleOrder((await order({})).id);
    const payout = await withdraw();
    transfers.verifyTransfer.mockResolvedValue({ state: 'failed', reason: 'Network timeout' });
    await service.handleTransferEvent('transfer.failed', { reference: payout.reference });
    expect(await balance()).toBe(95000);

    transfers.verifyTransfer.mockResolvedValue({ state: 'success' });
    await service.handleTransferEvent('transfer.success', { reference: payout.reference });
    await service.handleTransferEvent('transfer.success', { reference: payout.reference }); // once only
    expect(await prisma.vendorPayout.findUnique({ where: { id: payout.id } })).toMatchObject({ status: PayoutStatus.SUCCESS });
    expect(await balance()).toBe(0);
  });

  it('asks Paystack to resend a webhook it could not confirm, and changes nothing', async () => {
    await service.settleOrder((await order({})).id);
    const payout = await withdraw();
    transfers.verifyTransfer.mockResolvedValue({ state: 'unknown', reason: 'ECONNRESET' });

    await expect(service.handleTransferEvent('transfer.failed', { reference: payout.reference })).rejects.toThrow('Could not confirm');
    expect(await prisma.vendorPayout.findUnique({ where: { id: payout.id } })).toMatchObject({ status: PayoutStatus.PROCESSING });
    expect(await balance()).toBe(0);
  });

  it('never credits more than Paystack collected for an order', async () => {
    await service.settleOrder((await order({ paystackAmount: 50000 })).id);
    expect(await balance()).toBe(50000);
  });
});
