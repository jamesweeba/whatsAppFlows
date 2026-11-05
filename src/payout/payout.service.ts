import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { LedgerEntryType, OrderStatus, PaymentMethod, PayoutSource, PayoutStatus, Prisma, TenantStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { NotificationService } from '../notification/notification.service.js';
import { DELIVERED_ORDER_STATUSES } from '../order/order-status-groups.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { earningAvailableAt, formatAccra, ghs, MIN_PAYOUT, momoNetworkOf, orderSplit } from './payout-math.js';
import { PaystackTransfersClient, type TransferState } from './paystack-transfers.client.js';
import { nextAccraMidnight, startOfAccraDay } from './withdrawal-day.js';

/** Payouts in flight: at most one per shop, so a balance is never sent twice. */
export const IN_FLIGHT: PayoutStatus[] = [PayoutStatus.PENDING, PayoutStatus.PROCESSING];

/**
 * A payout still in flight after this long is checked with Paystack before the shop is paid
 * again. Long enough that a transfer request still on its way to Paystack has landed.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

/** Transfers only go out when PAYOUTS_ENABLED=true; otherwise balances just accrue. */
export const payoutsEnabled = () => process.env.PAYOUTS_ENABLED?.trim().toLowerCase() === 'true';

type Db = Prisma.TransactionClient;

/** A shop's balance split into what can be withdrawn now and what's held (card earnings). */
export interface Funds {
  /** The whole balance (negative: the vendor owes MarketiX). */
  balance: number;
  /** What can be withdrawn now. */
  available: number;
  /** Card earnings not yet withdrawable. */
  onHold: number;
  /** When the next held earning becomes withdrawable, or null. */
  nextReleaseAt: Date | null;
}

/**
 * The vendor money ledger and MoMo payouts.
 *
 * - A paid (MoMo or card) order earns the vendor its items less 10%, plus the delivery fee,
 *   once the buyer confirms delivery (or an admin releases it).
 * - Nothing is paid automatically. The vendor withdraws any amount from GH₵ 1 up to their
 *   balance, once per Accra day (a failed withdrawal doesn't count). Admins can send the
 *   whole balance at any time ("Pay now", "Retry"); that doesn't use up the vendor's day.
 * - A cash-on-delivery order owes MarketiX 10% of its items once delivered; that comes
 *   off the balance.
 * - A card earning is held for a few days (CARD_EARNINGS_HOLD_DAYS) before it can be
 *   withdrawn, in case the buyer disputes the charge. MoMo earnings aren't held.
 * - The vendor gets a WhatsApp message when a payout lands or fails.
 */
@Injectable()
export class PayoutService {
  private readonly logger = new Logger(PayoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transfers: PaystackTransfersClient,
    private readonly notifications: NotificationService,
  ) {}

  // ───────────────────────── Orders ─────────────────────────

  /**
   * Record what a delivered order means for the vendor's balance; the vendor withdraws it.
   * Safe to call more than once: each order is recorded once.
   * `released`: an admin vouches for delivery of a paid order the buyer never confirmed.
   */
  async settleOrder(orderId: string, { released = false }: { released?: boolean } = {}): Promise<void> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || !DELIVERED_ORDER_STATUSES.includes(order.status)) return;

    const split = orderSplit(order);
    const details = { items: split.items, commission: split.commission, deliveryFee: split.deliveryFee };
    const base = { tenantId: order.tenantId, orderId: order.id, orderNumber: order.orderNumber, details };

    if (order.paymentMethod === PaymentMethod.COD) {
      await this.recordOnce({ ...base, type: LedgerEntryType.CASH_COMMISSION, amount: -split.commission });
      return;
    }
    if (!order.paystackPaidAt) return; // MarketiX never received this money
    if (!order.deliveryConfirmedAt && !released) return; // waiting for the buyer

    // Never credit more than Paystack actually collected for the order.
    const amount = Math.min(split.vendorShare, order.paystackAmount ?? split.vendorShare);
    const availableAt = earningAvailableAt(order);
    const created = await this.recordOnce({ ...base, type: LedgerEntryType.ORDER_EARNING, amount, availableAt });
    if (created) {
      const when = availableAt ? `card payment, withdrawable from ${formatAccra(availableAt)}` : 'ready to withdraw';
      this.logger.log(`${order.orderNumber}: vendor earned ${ghs(split.vendorShare)} (commission ${ghs(split.commission)}); ${when}.`);
    }
  }

  /** Whether an order's earning or commission has been recorded. */
  async isSettled(orderId: string) {
    return (await this.prisma.vendorLedgerEntry.count({ where: { orderId } })) > 0;
  }

  private async recordOnce(entry: Prisma.VendorLedgerEntryUncheckedCreateInput): Promise<boolean> {
    const { count } = await this.prisma.vendorLedgerEntry.createMany({ data: [entry], skipDuplicates: true });
    return count === 1;
  }

  // ───────────────────────── Payouts ─────────────────────────

  /**
   * An admin's "Pay now" or "Retry": send the shop's whole balance to its MoMo wallet now.
   * Throws 409 with the reason when it can't (payouts off or paused, one in flight, balance
   * under GH₵ 1, no MoMo number).
   */
  async payTenant(tenantId: string, adminId: string | null) {
    return this.startPayout(tenantId, { source: PayoutSource.ADMIN, initiatedById: adminId }, (tenant, funds) => {
      if (tenant.payoutsPaused) return 'Payouts to this shop are paused.';
      if (funds.available < MIN_PAYOUT) {
        return funds.onHold > 0
          ? `Nothing to pay now: ${ghs(funds.onHold)} from card payments is on hold until ${formatAccra(funds.nextReleaseAt!)}.`
          : `Nothing to pay: the balance is ${ghs(funds.balance)}.`;
      }
      if (!tenant.momoNumber) return 'The shop has no MoMo number for payouts.';
      return funds.available;
    });
  }

  /**
   * The vendor withdraws `amount` pesewas of their balance to their MoMo wallet. Once per
   * Accra day: a withdrawal that is pending, processing or paid uses up the day; a failed
   * one doesn't. Admin payouts don't count.
   */
  async withdraw(tenantId: string, userId: string, amount: number) {
    if (!Number.isInteger(amount) || amount < MIN_PAYOUT) throw new BadRequestException(`The least you can withdraw is ${ghs(MIN_PAYOUT)}.`);

    return this.startPayout(tenantId, { source: PayoutSource.VENDOR, initiatedById: userId }, async (tenant, funds, tx) => {
      if (tenant.status === TenantStatus.SUSPENDED) throw new ForbiddenException('Your shop is suspended, so you can’t withdraw. Contact MarketiX support.');
      if (tenant.payoutsPaused) return 'Withdrawals for your shop are on hold. MarketiX will contact you.';
      if (!tenant.momoNumber) return 'Add your MoMo number before you withdraw.';
      if (await this.withdrawnToday(tx, tenantId)) return 'You can withdraw once a day. Try again tomorrow.';
      if (amount > funds.available) {
        const held = funds.onHold > 0 ? ` ${ghs(funds.onHold)} from card payments can be withdrawn from ${formatAccra(funds.nextReleaseAt!)}.` : '';
        throw new BadRequestException(
          funds.available < MIN_PAYOUT ? `Nothing to withdraw yet: you have ${ghs(Math.max(funds.available, 0))} available.${held}` : `You can withdraw up to ${ghs(funds.available)} now.${held}`,
        );
      }
      return amount;
    });
  }

  /** When a vendor who withdrew today can withdraw again (the next Accra midnight), or null if they haven't. */
  async nextWithdrawalAt(db: Db, tenantId: string, now = new Date()): Promise<Date | null> {
    return (await this.withdrawnToday(db, tenantId, now)) ? nextAccraMidnight(now) : null;
  }

  private async withdrawnToday(db: Db, tenantId: string, now = new Date()): Promise<boolean> {
    const count = await db.vendorPayout.count({
      where: { tenantId, source: PayoutSource.VENDOR, status: { not: PayoutStatus.FAILED }, createdAt: { gte: startOfAccraDay(now) } },
    });
    return count > 0;
  }

  /**
   * Takes `amount` off the shop's balance and sends it. `check` returns the amount to send,
   * or a reason not to (thrown as 409). Runs under a per-shop lock, so two requests at once
   * can't both pass the checks.
   */
  private async startPayout(
    tenantId: string,
    by: { source: PayoutSource; initiatedById: string | null },
    check: (tenant: Prisma.TenantGetPayload<object>, funds: Funds, tx: Db) => number | string | Promise<number | string>,
  ) {
    await this.reconcileStale(tenantId);
    if (!payoutsEnabled()) {
      throw new ConflictException(
        by.source === PayoutSource.VENDOR ? 'Withdrawals aren’t available yet. Your balance is safe.' : 'Payouts are turned off. Set PAYOUTS_ENABLED=true once Paystack has enabled transfers.',
      );
    }

    const started = await this.prisma.$transaction(async (tx) => {
      // One shop at a time: a second caller waits here, then sees the first payout.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payout:${tenantId}`}))`;
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) throw new NotFoundException('Shop not found.');
      if (await tx.vendorPayout.count({ where: { tenantId, status: { in: IN_FLIGHT } } })) {
        throw new ConflictException(
          by.source === PayoutSource.VENDOR ? 'Wait for your last withdrawal to land before you withdraw again.' : 'A payout to this shop is already in progress.',
        );
      }
      const result = await check(tenant, await this.fundsOf(tx, tenantId), tx);
      if (typeof result === 'string') throw new ConflictException(result);

      const created = await tx.vendorPayout.create({
        data: {
          tenantId,
          amount: result,
          reference: `payout_${randomUUID().replace(/-/g, '')}`,
          momoNumber: tenant.momoNumber!,
          momoName: tenant.momoName,
          source: by.source,
          initiatedById: by.initiatedById,
        },
      });
      // Taken off the balance now, so it can't be paid twice; put back if the transfer fails.
      await tx.vendorLedgerEntry.create({ data: { tenantId, type: LedgerEntryType.PAYOUT, amount: -result, payoutId: created.id } });
      return { payout: created, tenant };
    });

    return this.sendTransfer(started.payout, started.tenant);
  }

  private async sendTransfer(
    payout: Prisma.VendorPayoutGetPayload<object>,
    tenant: Prisma.TenantGetPayload<object>,
  ) {
    const recipient = await this.recipientFor(tenant);
    if ('reason' in recipient) return this.fail(payout.id, recipient.reason);

    const result = await this.transfers.transfer({
      amount: payout.amount,
      recipientCode: recipient.code,
      reference: payout.reference,
      reason: `MarketiX payout to ${tenant.name}`.slice(0, 100),
    });
    if (!result.ok && result.unknown) {
      // Paystack may have sent it. Refunding now could pay the vendor twice, so it stays in
      // flight (blocking further payouts) until a webhook or reconcileStale() settles it.
      this.logger.warn(`Payout ${payout.reference}: no clear answer from Paystack (${result.reason}); left in flight until Paystack confirms.`);
      return this.prisma.vendorPayout.update({ where: { id: payout.id }, data: { status: PayoutStatus.PROCESSING } });
    }
    if (!result.ok) return this.fail(payout.id, result.reason);

    this.logger.log(`Payout ${payout.reference}: ${ghs(payout.amount)} to ${tenant.name} accepted by Paystack (${result.status}).`);
    if (result.status !== 'success') {
      return this.prisma.vendorPayout.update({ where: { id: payout.id }, data: { status: PayoutStatus.PROCESSING, transferCode: result.transferCode } });
    }
    // Conditional, like succeed(): a webhook that already settled it wins, and the vendor is told once.
    await this.prisma.vendorPayout.updateMany({ where: { id: payout.id, status: { in: IN_FLIGHT } }, data: { transferCode: result.transferCode } });
    await this.succeed(payout.id);
    return this.prisma.vendorPayout.findUniqueOrThrow({ where: { id: payout.id } });
  }

  /** The shop's Paystack recipient, made once per MoMo number. */
  private async recipientFor(tenant: Prisma.TenantGetPayload<object>): Promise<{ code: string } | { reason: string }> {
    const momo = tenant.momoNumber!;
    // Fake transfers (local testing): never save the fake recipient, or real payouts would use it later.
    if (this.transfers.fakeMode) return { code: 'RCP_FAKE' };
    if (tenant.paystackRecipientCode && tenant.paystackRecipientFor === momo) return { code: tenant.paystackRecipientCode };

    const network = momoNetworkOf(momo);
    if (!network) return { reason: `Can't tell the MoMo network of ${momo}. Check the shop's MoMo number.` };
    const created = await this.transfers.createMomoRecipient({ name: tenant.momoName || tenant.ownerFullName || tenant.name, momoNumber: momo, network });
    if (!created.ok) return { reason: created.reason };

    await this.prisma.tenant.update({ where: { id: tenant.id }, data: { paystackRecipientCode: created.code, paystackRecipientFor: momo } });
    return { code: created.code };
  }

  /** Marks a payout failed and puts its amount back in the balance (once). */
  private async fail(payoutId: string, reason: string) {
    const { payout, changed } = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.vendorPayout.updateMany({
        where: { id: payoutId, status: { not: PayoutStatus.FAILED } },
        data: { status: PayoutStatus.FAILED, failureReason: reason.slice(0, 500) },
      });
      const payout = await tx.vendorPayout.findUniqueOrThrow({ where: { id: payoutId } });
      if (count === 1) {
        await tx.vendorLedgerEntry.create({
          data: { tenantId: payout.tenantId, type: LedgerEntryType.PAYOUT_REVERSAL, amount: payout.amount, payoutId },
        });
        this.logger.warn(`Payout ${payout.reference} failed: ${reason}`);
      }
      return { payout, changed: count === 1 };
    });
    if (changed) this.tellVendor(payout, 'failed');
    return payout;
  }

  /**
   * Paystack's transfer.success / transfer.failed / transfer.reversed webhooks (the
   * signature is checked by the caller). The event only prompts a check: the payout is
   * settled on what Paystack's API reports, so a replayed or out-of-order webhook can't
   * refund a transfer that was paid. Returns false for a reference that isn't ours. Throws
   * 503 when Paystack can't be asked, so Paystack sends the webhook again later.
   */
  async handleTransferEvent(event: string, data: { reference?: string } | undefined): Promise<boolean> {
    const payout = data?.reference ? await this.prisma.vendorPayout.findUnique({ where: { reference: data.reference } }) : null;
    if (!payout) return false;

    const state = await this.transfers.verifyTransfer(payout.reference);
    if (state.state === 'unknown') {
      this.logger.warn(`Webhook ${event} for ${payout.reference}: couldn't confirm with Paystack (${state.reason}).`);
      throw new ServiceUnavailableException('Could not confirm the transfer with Paystack. Try again later.');
    }
    if (state.state === 'not_found') {
      this.logger.error(`Webhook ${event} for ${payout.reference}, but Paystack has no such transfer. Ignored.`);
      return true;
    }
    await this.applyState(payout, state);
    return true;
  }

  /**
   * Settles this shop's payouts that have been in flight too long, by asking Paystack. Run
   * before paying the shop again and when showing its money, so a lost webhook or an
   * unanswered transfer request doesn't block the shop for ever.
   */
  async reconcileStale(tenantId: string): Promise<void> {
    const stale = await this.prisma.vendorPayout.findMany({
      where: { tenantId, status: { in: IN_FLIGHT }, updatedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
    });
    for (const payout of stale) {
      const state = await this.transfers.verifyTransfer(payout.reference);
      // Paystack never got it, long after we asked: it won't go out now, so give the money back.
      if (state.state === 'not_found') await this.fail(payout.id, 'Paystack never received this transfer.');
      else if (state.state === 'success' || state.state === 'failed') await this.applyState(payout, state);
      else await this.prisma.vendorPayout.update({ where: { id: payout.id }, data: { updatedAt: new Date() } }); // check again later
    }
  }

  private async applyState(payout: { id: string }, state: Extract<TransferState, { state: 'success' | 'failed' | 'pending' }>) {
    if (state.state === 'success') await this.succeed(payout.id);
    else if (state.state === 'failed') await this.fail(payout.id, state.reason);
  }

  /**
   * Marks a payout paid. If it had been marked failed (and its amount put back), the money
   * did go out after all: take it off the balance again, so it can't be withdrawn twice.
   */
  private async succeed(payoutId: string) {
    const landed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.vendorPayout.updateMany({
        where: { id: payoutId, status: { in: IN_FLIGHT } },
        data: { status: PayoutStatus.SUCCESS, paidAt: new Date() },
      });
      if (count === 1) return tx.vendorPayout.findUniqueOrThrow({ where: { id: payoutId } });

      const reopened = await tx.vendorPayout.updateMany({
        where: { id: payoutId, status: PayoutStatus.FAILED },
        data: { status: PayoutStatus.SUCCESS, paidAt: new Date() },
      });
      if (reopened.count === 1) {
        const payout = await tx.vendorPayout.findUniqueOrThrow({ where: { id: payoutId } });
        await tx.vendorLedgerEntry.create({ data: { tenantId: payout.tenantId, type: LedgerEntryType.PAYOUT, amount: -payout.amount, payoutId } });
        this.logger.error(`Payout ${payout.reference} was marked failed but Paystack paid it: ${ghs(payout.amount)} taken off the balance again.`);
      }
      return null; // the vendor was already told it failed; an admin sorts this one out
    });
    if (landed) this.tellVendor(landed, 'paid');
  }

  /** WhatsApp the vendor that a payout landed or failed. In the background; never fails the payout. */
  private tellVendor(payout: Prisma.VendorPayoutGetPayload<object>, outcome: 'paid' | 'failed') {
    void this.prisma.tenant
      .findUnique({ where: { id: payout.tenantId } })
      .then((tenant) => tenant && (outcome === 'paid' ? this.notifications.payoutPaid(tenant, payout) : this.notifications.payoutFailed(tenant, payout)))
      .catch((err: any) => this.logger.warn(`Couldn't tell the vendor about payout ${payout.reference}: ${err?.message || err}`));
  }

  // ───────────────────────── Balances ─────────────────────────

  async balanceOf(db: Db, tenantId: string): Promise<number> {
    const { _sum } = await db.vendorLedgerEntry.aggregate({ where: { tenantId }, _sum: { amount: true } });
    return _sum.amount ?? 0;
  }

  /** The balance, and how much of it can be withdrawn now (held card earnings can't). */
  async fundsOf(db: Db, tenantId: string, now = new Date()): Promise<Funds> {
    const [balance, held] = await Promise.all([
      this.balanceOf(db, tenantId),
      db.vendorLedgerEntry.aggregate({ where: { tenantId, availableAt: { gt: now } }, _sum: { amount: true }, _min: { availableAt: true } }),
    ]);
    const onHold = held._sum.amount ?? 0;
    return { balance, available: balance - onHold, onHold, nextReleaseAt: held._min.availableAt };
  }

  /** Paid, delivered orders still waiting for the buyer to confirm (they will earn this). */
  async awaitingConfirmation(tenantId: string) {
    const orders = await this.prisma.order.findMany({
      where: {
        tenantId,
        status: { in: DELIVERED_ORDER_STATUSES },
        paystackPaidAt: { not: null },
        deliveryConfirmedAt: null,
        ledger: { none: { type: LedgerEntryType.ORDER_EARNING } },
      },
      select: { id: true, orderNumber: true, totalAmount: true, deliveryFee: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
    return {
      count: orders.length,
      amount: orders.reduce((sum, o) => sum + orderSplit(o).vendorShare, 0),
      orders: orders.map((o) => ({ id: o.id, orderNumber: o.orderNumber, vendorShare: orderSplit(o).vendorShare, deliveredAt: o.updatedAt })),
    };
  }

  /** MarketiX's Paystack balance in pesewas, or null when Paystack can't be asked. */
  paystackBalance(): Promise<number | null> {
    return this.transfers.balance();
  }

  /** Throws 404 for an unknown shop. */
  async ensureTenant(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Shop not found.');
    return tenant;
  }

  /** The status a released order must be in. */
  static readonly RELEASABLE: OrderStatus[] = DELIVERED_ORDER_STATUSES;
}
