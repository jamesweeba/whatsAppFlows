import { Injectable, Logger } from '@nestjs/common';
import { LedgerEntryType, Order, PayoutStatus, Prisma, PromoterLedgerEntryType as Entry, PromoterStatus, type Promoter, type PromoterPayout } from '@prisma/client';
import { randomUUID } from 'crypto';
import { toGhanaLocal } from '../common/phone.util.js';
import { NotificationService } from '../notification/notification.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { COMMISSION_HOLD_DAYS } from '../promoter/promoter-rules.js';
import { referralState } from '../promoter/referral-rules.js';
import { formatAccra, type Funds, ghs, IN_FLIGHT, MIN_PAYOUT, momoNetworkOf, payoutsEnabled } from './payout-math.js';
import { PaystackTransfersClient } from './paystack-transfers.client.js';
import { PayoutSettlement } from './payout-settlement.js';
import { startOfAccraDay } from './withdrawal-day.js';

/** The least a promoter can withdraw, in pesewas: GH₵ 20, so transfer fees stay small next to the payout. */
export const PROMOTER_MIN_WITHDRAWAL = 2000;

const DAY_MS = 24 * 60 * 60 * 1000;

type Db = Prisma.TransactionClient;

/** What happened when a promoter asked to withdraw. */
export type WithdrawResult =
  | { kind: 'refused'; message: string }
  /** Paid at once, on its way (Paystack will confirm), or failed and put back. */
  | { kind: 'paid' | 'processing' | 'failed'; amount: number; momoNumber: string; payoutId: string };

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
  private readonly settlement: PayoutSettlement<PromoterPayout>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly transfers: PaystackTransfersClient,
    private readonly notifications: NotificationService,
  ) {
    this.settlement = new PayoutSettlement(prisma, transfers, this.logger, {
      label: 'Promoter payout',
      table: (db) => db.promoterPayout,
      addEntry: (db, payout, type, amount) => db.promoterLedgerEntry.create({ data: { promoterId: payout.promoterId, type, amount, payoutId: payout.id } }),
      tell: (payout, outcome) => this.tellPromoter(payout, outcome),
    });
  }

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
  withdraw(promoterId: string): Promise<WithdrawResult> {
    return this.start(promoterId, null);
  }

  /**
   * An admin's "Retry": send the promoter's whole available balance now. Not limited to once
   * a day or GH₵ 20, and doesn't use up the promoter's own withdrawal for the day. The
   * promoter is told the outcome on WhatsApp.
   */
  payNow(promoterId: string, adminId: string): Promise<WithdrawResult> {
    return this.start(promoterId, adminId);
  }

  private async start(promoterId: string, adminId: string | null): Promise<WithdrawResult> {
    await this.reconcileStale(promoterId);
    if (!payoutsEnabled()) {
      return { kind: 'refused', message: adminId ? 'Payouts are turned off (PAYOUTS_ENABLED).' : 'Withdrawals aren’t available yet. Your earnings are safe and keep adding up.' };
    }
    const minimum = adminId ? MIN_PAYOUT : PROMOTER_MIN_WITHDRAWAL;

    let started: { payout: PromoterPayout; promoter: Promoter };
    try {
      started = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ppayout:${promoterId}`}))`;
        const promoter = await tx.promoter.findUnique({ where: { id: promoterId } });
        if (!promoter) throw new Refusal('We couldn’t find your account.');
        if (promoter.status !== PromoterStatus.ACTIVE) {
          throw new Refusal(adminId ? 'This promoter is not active. Reinstate them first.' : 'Your account is paused, so you can’t withdraw. Please contact MarketiX support.');
        }
        if (!promoter.momoNumber) throw new Refusal(adminId ? 'This promoter has no MoMo number.' : 'Add your MoMo number before you withdraw.');
        if (await tx.promoterPayout.count({ where: { promoterId, status: { in: IN_FLIGHT } } })) {
          throw new Refusal(adminId ? 'A payout to this promoter is already on its way.' : 'Your last withdrawal is still on its way. Please wait for it to land.');
        }
        if (!adminId) {
          const today = await tx.promoterPayout.count({
            where: { promoterId, initiatedById: null, status: { not: PayoutStatus.FAILED }, createdAt: { gte: startOfAccraDay() } },
          });
          if (today) throw new Refusal('You can withdraw once a day. Try again tomorrow.');
        }

        const funds = await this.fundsOf(tx, promoterId);
        if (funds.available < minimum) {
          const held = funds.onHold > 0 ? ` ${ghs(funds.onHold)} more is on its way: the next part is ready on ${formatAccra(funds.nextReleaseAt!)}.` : '';
          throw new Refusal(
            adminId
              ? `Nothing to pay: ${ghs(Math.max(funds.available, 0))} is available.${held}`
              : `You can withdraw once you have ${ghs(minimum)} ready. You have ${ghs(Math.max(funds.available, 0))} now.${held}`,
          );
        }
        const payout = await tx.promoterPayout.create({
          data: {
            promoterId,
            amount: funds.available,
            reference: `ppayout_${randomUUID().replace(/-/g, '')}`,
            momoNumber: promoter.momoNumber,
            momoName: promoter.momoName ?? promoter.fullName,
            initiatedById: adminId,
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

    // The bot replies to a promoter's own withdrawal; an admin's is announced here.
    const payout = await this.sendTransfer(started.payout, started.promoter, Boolean(adminId));
    const kind = payout.status === PayoutStatus.SUCCESS ? 'paid' : payout.status === PayoutStatus.FAILED ? 'failed' : 'processing';
    return { kind, amount: payout.amount, momoNumber: payout.momoNumber, payoutId: payout.id };
  }

  private async sendTransfer(payout: PromoterPayout, promoter: Promoter, notify: boolean): Promise<PromoterPayout> {
    const recipient = await this.recipientFor(promoter);
    if ('reason' in recipient) return this.settlement.fail(payout.id, recipient.reason, notify);

    const result = await this.transfers.transfer({
      amount: payout.amount,
      recipientCode: recipient.code,
      reference: payout.reference,
      reason: 'MarketiX promoter commission',
    });
    return this.settlement.afterTransfer(payout, result, notify);
  }

  /** The promoter's Paystack recipient, made once per MoMo number. */
  private async recipientFor(promoter: Promoter): Promise<{ code: string } | { reason: string }> {
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

  /** Paystack's transfer webhooks for promoter payouts. Returns false for a reference that isn't a promoter payout. */
  handleTransferEvent(event: string, data: { reference?: string } | undefined): Promise<boolean> {
    return this.settlement.handleTransferEvent(event, data);
  }

  /** Settles this promoter's payouts that have been in flight too long. */
  reconcileStale(promoterId: string): Promise<void> {
    return this.settlement.reconcileStale({ promoterId });
  }

  private tellPromoter(payout: PromoterPayout, outcome: 'paid' | 'failed') {
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
