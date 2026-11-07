import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { LedgerEntryType, Order, PayoutStatus, Prisma, PromoterLedgerEntryType as Entry, PromoterStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { toGhanaLocal } from '../common/phone.util.js';
import { NotificationService } from '../notification/notification.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { COMMISSION_HOLD_DAYS } from '../promoter/promoter-rules.js';
import { referralState } from '../promoter/referral-rules.js';
import { formatAccra, type Funds, ghs, IN_FLIGHT, momoNetworkOf, payoutsEnabled, STALE_AFTER_MS } from './payout-math.js';
import { PaystackTransfersClient, type TransferState } from './paystack-transfers.client.js';
import { startOfAccraDay } from './withdrawal-day.js';

/** The least a promoter can withdraw, in pesewas: GH₵ 20, so transfer fees stay small next to the payout. */
export const PROMOTER_MIN_WITHDRAWAL = 2000;

const DAY_MS = 24 * 60 * 60 * 1000;

type Db = Prisma.TransactionClient;
type Payout = Prisma.PromoterPayoutGetPayload<object>;

/** What happened when a promoter asked to withdraw. */
export type WithdrawResult =
  | { kind: 'refused'; message: string }
  /** Paid at once, on its way (Paystack will confirm), or failed and put back. */
  | { kind: 'paid' | 'processing' | 'failed'; amount: number; momoNumber: string };

/** A reason not to withdraw, thrown inside the transaction so nothing is written. */
class Refusal extends Error {}

/**
 * Promoters' money, mirroring vendor payouts (see PayoutService):
 * - When a paid order a promoter brought in is settled for the vendor, the commission comes
 *   off the vendor's earning and onto the promoter's balance, withdrawable after
 *   COMMISSION_HOLD_DAYS.
 * - The promoter withdraws everything available (at least GH₵ 20) from the bot, once per
 *   Accra day, to the MoMo number they signed up with.
 * - Transfers that get no clear answer stay in flight until Paystack confirms; failures go
 *   back to the balance; webhooks only prompt a check with Paystack.
 */
@Injectable()
export class PromoterPayoutService {
  private readonly logger = new Logger(PromoterPayoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transfers: PaystackTransfersClient,
    private readonly notifications: NotificationService,
  ) {}

  // ───────────────────────── Commission ─────────────────────────

  /**
   * Pay the promoter who brought in this order, if it earns: called when the vendor's earning
   * for it is recorded. The commission comes off the vendor's earning (never more than
   * `vendorCredited`) and is held like it. Safe to call more than once.
   */
  async creditCommission(order: Order, vendorCredited: number, vendorAvailableAt: Date | null): Promise<void> {
    const referral = await this.prisma.referral.findUnique({
      where: { orderId: order.id },
      include: { promoter: true, tenant: { select: { name: true } } },
    });
    if (!referral) return;
    const { state, reason } = referralState(referral, order, referral.promoter);
    if (state !== 'EARNED') {
      if (state === 'NO_COMMISSION') this.logger.log(`${order.orderNumber}: no promoter commission (${reason}).`);
      return;
    }
    const amount = Math.min(referral.commissionAmount ?? 0, vendorCredited);
    if (amount <= 0) return;

    const now = Date.now();
    const promoterAvailableAt = new Date(Math.max(now + COMMISSION_HOLD_DAYS * DAY_MS, vendorAvailableAt?.getTime() ?? 0));
    const credited = await this.prisma.$transaction(async (tx) => {
      // Held with the vendor's earning, so a held card earning isn't spent early through this.
      const { count } = await tx.vendorLedgerEntry.createMany({
        data: [
          {
            tenantId: order.tenantId,
            type: LedgerEntryType.PROMOTER_COMMISSION,
            amount: -amount,
            orderId: order.id,
            orderNumber: order.orderNumber,
            details: { promoterId: referral.promoterId, promoterName: referral.promoter.fullName, linkCode: referral.linkCode, ratePercent: referral.ratePercent, base: referral.baseAmount },
            availableAt: vendorAvailableAt,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) return false; // already paid
      await tx.promoterLedgerEntry.create({
        data: {
          promoterId: referral.promoterId,
          type: Entry.COMMISSION,
          amount,
          orderId: order.id,
          orderNumber: order.orderNumber,
          tenantId: order.tenantId,
          shopName: referral.tenant.name,
          availableAt: promoterAvailableAt,
        },
      });
      return true;
    });
    if (!credited) return;

    this.logger.log(`${order.orderNumber}: promoter ${referral.promoterId} earned ${ghs(amount)} from ${referral.tenant.name}.`);
    void this.notifications.toPromoter(
      referral.promoter.phone,
      `💰 You earned *${ghs(amount)}* from *${referral.tenant.name}* (order ${order.orderNumber}). ` +
        `You can withdraw it from ${formatAccra(promoterAvailableAt)}. Send *EARNINGS* to see your balance.`,
    );
  }

  // ───────────────────────── Balance ─────────────────────────

  async fundsOf(db: Db, promoterId: string, now = new Date()): Promise<Funds> {
    const [total, held] = await Promise.all([
      db.promoterLedgerEntry.aggregate({ where: { promoterId }, _sum: { amount: true } }),
      db.promoterLedgerEntry.aggregate({ where: { promoterId, availableAt: { gt: now } }, _sum: { amount: true }, _min: { availableAt: true } }),
    ]);
    const balance = total._sum.amount ?? 0;
    const onHold = held._sum.amount ?? 0;
    return { balance, available: balance - onHold, onHold, nextReleaseAt: held._min.availableAt };
  }

  /** Everything the EARNINGS reply shows. */
  async summary(promoterId: string) {
    await this.reconcileStale(promoterId);
    const [funds, earned, inFlight, recent] = await Promise.all([
      this.fundsOf(this.prisma, promoterId),
      this.prisma.promoterLedgerEntry.aggregate({ where: { promoterId, type: Entry.COMMISSION }, _sum: { amount: true } }),
      this.prisma.promoterPayout.aggregate({ where: { promoterId, status: { in: IN_FLIGHT } }, _sum: { amount: true } }),
      this.prisma.promoterLedgerEntry.findMany({ where: { promoterId, type: Entry.COMMISSION }, orderBy: { createdAt: 'desc' }, take: 5 }),
    ]);
    return { ...funds, earned: earned._sum.amount ?? 0, inFlight: inFlight._sum.amount ?? 0, recent, minWithdrawal: PROMOTER_MIN_WITHDRAWAL };
  }

  // ───────────────────────── Withdrawals ─────────────────────────

  /** Send everything available to the promoter's MoMo. The bot tells them the result. */
  async withdraw(promoterId: string): Promise<WithdrawResult> {
    await this.reconcileStale(promoterId);
    if (!payoutsEnabled()) return { kind: 'refused', message: 'Withdrawals aren’t available yet. Your earnings are safe and keep adding up.' };

    let started: { payout: Payout; promoter: Prisma.PromoterGetPayload<object> };
    try {
      started = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ppayout:${promoterId}`}))`;
        const promoter = await tx.promoter.findUnique({ where: { id: promoterId } });
        if (!promoter) throw new Refusal('We couldn’t find your account.');
        if (promoter.status !== PromoterStatus.ACTIVE) throw new Refusal('Your account is paused, so you can’t withdraw. Please contact MarketiX support.');
        if (!promoter.momoNumber) throw new Refusal('Add your MoMo number before you withdraw.');
        if (await tx.promoterPayout.count({ where: { promoterId, status: { in: IN_FLIGHT } } })) {
          throw new Refusal('Your last withdrawal is still on its way. Please wait for it to land.');
        }
        const today = await tx.promoterPayout.count({ where: { promoterId, status: { not: PayoutStatus.FAILED }, createdAt: { gte: startOfAccraDay() } } });
        if (today) throw new Refusal('You can withdraw once a day. Try again tomorrow.');

        const funds = await this.fundsOf(tx, promoterId);
        if (funds.available < PROMOTER_MIN_WITHDRAWAL) {
          const held = funds.onHold > 0 ? ` ${ghs(funds.onHold)} more is on its way: the next part is ready on ${formatAccra(funds.nextReleaseAt!)}.` : '';
          throw new Refusal(`You can withdraw once you have ${ghs(PROMOTER_MIN_WITHDRAWAL)} ready. You have ${ghs(Math.max(funds.available, 0))} now.${held}`);
        }
        const payout = await tx.promoterPayout.create({
          data: {
            promoterId,
            amount: funds.available,
            reference: `ppayout_${randomUUID().replace(/-/g, '')}`,
            momoNumber: promoter.momoNumber,
            momoName: promoter.momoName ?? promoter.fullName,
          },
        });
        // Off the balance now, so it can't be sent twice; put back if the transfer fails.
        await tx.promoterLedgerEntry.create({ data: { promoterId, type: Entry.PAYOUT, amount: -payout.amount, payoutId: payout.id } });
        return { payout, promoter };
      });
    } catch (err) {
      if (err instanceof Refusal) return { kind: 'refused', message: err.message };
      throw err;
    }

    const payout = await this.sendTransfer(started.payout, started.promoter);
    const kind = payout.status === PayoutStatus.SUCCESS ? 'paid' : payout.status === PayoutStatus.FAILED ? 'failed' : 'processing';
    return { kind, amount: payout.amount, momoNumber: payout.momoNumber };
  }

  private async sendTransfer(payout: Payout, promoter: Prisma.PromoterGetPayload<object>): Promise<Payout> {
    const recipient = await this.recipientFor(promoter);
    if ('reason' in recipient) return this.fail(payout.id, recipient.reason, false);

    const result = await this.transfers.transfer({
      amount: payout.amount,
      recipientCode: recipient.code,
      reference: payout.reference,
      reason: 'MarketiX promoter commission',
    });
    if (!result.ok && result.unknown) {
      this.logger.warn(`Promoter payout ${payout.reference}: no clear answer from Paystack (${result.reason}); left in flight until Paystack confirms.`);
      return this.prisma.promoterPayout.update({ where: { id: payout.id }, data: { status: PayoutStatus.PROCESSING } });
    }
    if (!result.ok) return this.fail(payout.id, result.reason, false);

    this.logger.log(`Promoter payout ${payout.reference}: ${ghs(payout.amount)} accepted by Paystack (${result.status}).`);
    if (result.status !== 'success') {
      return this.prisma.promoterPayout.update({ where: { id: payout.id }, data: { status: PayoutStatus.PROCESSING, transferCode: result.transferCode } });
    }
    await this.prisma.promoterPayout.updateMany({ where: { id: payout.id, status: { in: IN_FLIGHT } }, data: { transferCode: result.transferCode } });
    await this.succeed(payout.id, false);
    return this.prisma.promoterPayout.findUniqueOrThrow({ where: { id: payout.id } });
  }

  /** The promoter's Paystack recipient, made once per MoMo number. */
  private async recipientFor(promoter: Prisma.PromoterGetPayload<object>): Promise<{ code: string } | { reason: string }> {
    const momo = promoter.momoNumber!;
    if (this.transfers.fakeMode) return { code: 'RCP_FAKE' };
    if (promoter.paystackRecipientCode && promoter.paystackRecipientFor === momo) return { code: promoter.paystackRecipientCode };

    const network = promoter.momoNetwork ?? momoNetworkOf(momo);
    if (!network) return { reason: `Can't tell the MoMo network of ${momo}.` };
    const created = await this.transfers.createMomoRecipient({ name: promoter.momoName || promoter.fullName || 'MarketiX promoter', momoNumber: momo, network });
    if (!created.ok) return { reason: created.reason };
    await this.prisma.promoter.update({ where: { id: promoter.id }, data: { paystackRecipientCode: created.code, paystackRecipientFor: momo } });
    return { code: created.code };
  }

  /** Marks a payout failed and puts its amount back (once). `notify`: message the promoter (not when the bot is replying anyway). */
  private async fail(payoutId: string, reason: string, notify = true): Promise<Payout> {
    const { payout, changed } = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.promoterPayout.updateMany({
        where: { id: payoutId, status: { not: PayoutStatus.FAILED } },
        data: { status: PayoutStatus.FAILED, failureReason: reason.slice(0, 500) },
      });
      const payout = await tx.promoterPayout.findUniqueOrThrow({ where: { id: payoutId } });
      if (count === 1) {
        await tx.promoterLedgerEntry.create({ data: { promoterId: payout.promoterId, type: Entry.PAYOUT_REVERSAL, amount: payout.amount, payoutId } });
        this.logger.warn(`Promoter payout ${payout.reference} failed: ${reason}`);
      }
      return { payout, changed: count === 1 };
    });
    if (changed && notify) this.tellPromoter(payout, 'failed');
    return payout;
  }

  /** Marks a payout paid; if it had been marked failed, takes it off the balance again. */
  private async succeed(payoutId: string, notify = true) {
    const landed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.promoterPayout.updateMany({
        where: { id: payoutId, status: { in: IN_FLIGHT } },
        data: { status: PayoutStatus.SUCCESS, paidAt: new Date() },
      });
      if (count === 1) return tx.promoterPayout.findUniqueOrThrow({ where: { id: payoutId } });

      const reopened = await tx.promoterPayout.updateMany({ where: { id: payoutId, status: PayoutStatus.FAILED }, data: { status: PayoutStatus.SUCCESS, paidAt: new Date() } });
      if (reopened.count === 1) {
        const payout = await tx.promoterPayout.findUniqueOrThrow({ where: { id: payoutId } });
        await tx.promoterLedgerEntry.create({ data: { promoterId: payout.promoterId, type: Entry.PAYOUT, amount: -payout.amount, payoutId } });
        this.logger.error(`Promoter payout ${payout.reference} was marked failed but Paystack paid it: ${ghs(payout.amount)} taken off the balance again.`);
      }
      return null;
    });
    if (landed && notify) this.tellPromoter(landed, 'paid');
  }

  /**
   * Paystack's transfer webhooks for promoter payouts. Like vendor payouts, the event only
   * prompts a check with Paystack. Returns false for a reference that isn't a promoter payout.
   */
  async handleTransferEvent(event: string, data: { reference?: string } | undefined): Promise<boolean> {
    const payout = data?.reference ? await this.prisma.promoterPayout.findUnique({ where: { reference: data.reference } }) : null;
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

  /** Settles this promoter's payouts that have been in flight too long, by asking Paystack. */
  async reconcileStale(promoterId: string): Promise<void> {
    const stale = await this.prisma.promoterPayout.findMany({
      where: { promoterId, status: { in: IN_FLIGHT }, updatedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
    });
    for (const payout of stale) {
      const state = await this.transfers.verifyTransfer(payout.reference);
      if (state.state === 'not_found') await this.fail(payout.id, 'Paystack never received this transfer.');
      else if (state.state === 'success' || state.state === 'failed') await this.applyState(payout, state);
      else await this.prisma.promoterPayout.update({ where: { id: payout.id }, data: { updatedAt: new Date() } });
    }
  }

  private async applyState(payout: { id: string }, state: Extract<TransferState, { state: 'success' | 'failed' | 'pending' }>) {
    if (state.state === 'success') await this.succeed(payout.id);
    else if (state.state === 'failed') await this.fail(payout.id, state.reason);
  }

  private tellPromoter(payout: Payout, outcome: 'paid' | 'failed') {
    void this.prisma.promoter
      .findUnique({ where: { id: payout.promoterId } })
      .then((promoter) => {
        if (!promoter) return;
        const text =
          outcome === 'paid'
            ? `✅ ${ghs(payout.amount)} has been sent to your MoMo (${toGhanaLocal(payout.momoNumber)}). Thanks for promoting with MarketiX!`
            : `⚠️ Your withdrawal of ${ghs(payout.amount)} didn't go through. The money is back in your balance and our team has been told. Send *WITHDRAW* to try again.`;
        return this.notifications.toPromoter(promoter.phone, text);
      })
      .catch((err: any) => this.logger.warn(`Couldn't tell the promoter about payout ${payout.reference}: ${err?.message || err}`));
  }
}
