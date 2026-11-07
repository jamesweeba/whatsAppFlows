import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { PayoutStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { ghs, IN_FLIGHT, STALE_AFTER_MS } from './payout-math.js';
import { PaystackTransfersClient, type TransferOutcome, type TransferState } from './paystack-transfers.client.js';

type Db = Prisma.TransactionClient;

/** The fields settlement needs from a vendor or promoter payout row. */
export interface PayoutRow {
  id: string;
  reference: string;
  amount: number;
}

/** The Prisma calls settlement makes on a payout table (vendorPayout or promoterPayout). */
interface PayoutTable<P> {
  findUnique(args: { where: { reference: string } }): Promise<P | null>;
  findUniqueOrThrow(args: { where: { id: string } }): Promise<P>;
  findMany(args: { where: object }): Promise<P[]>;
  update(args: { where: { id: string }; data: object }): Promise<P>;
  updateMany(args: { where: object; data: object }): Promise<{ count: number }>;
}

/** How one kind of payout (a shop's or a promoter's) is stored and announced. */
export interface PayoutBook<P extends PayoutRow> {
  /** Starts log lines, e.g. "Payout" or "Promoter payout". */
  label: string;
  /** The payout table, e.g. `db.vendorPayout`. */
  table(db: Db): PayoutTable<P>;
  /** Adds a ledger entry for this payout: PAYOUT takes money off the balance, PAYOUT_REVERSAL puts it back. */
  addEntry(db: Db, payout: P, type: 'PAYOUT' | 'PAYOUT_REVERSAL', amount: number): Promise<unknown>;
  /** Messages the payee that the payout landed or failed. In the background; never fails the payout. */
  tell(payout: P, outcome: 'paid' | 'failed'): void;
}

/**
 * Settles MoMo payouts with Paystack, the same way for shops and promoters. A payout's
 * amount comes off the balance when it starts; this puts it back when the transfer fails and
 * takes it off again if a "failed" transfer turns out to have been paid. Paystack's API, not
 * a webhook's body, decides the outcome, so a replayed or out-of-order webhook can't refund
 * a paid transfer. Every change is conditional, so the payee is told once.
 */
export class PayoutSettlement<P extends PayoutRow> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transfers: PaystackTransfersClient,
    private readonly logger: Logger,
    private readonly book: PayoutBook<P>,
  ) {}

  /**
   * Records what Paystack said to a transfer request. With no clear answer, Paystack may
   * have sent it: refunding could pay twice, so it stays in flight (blocking further payouts)
   * until a webhook or reconcileStale() settles it. `notify`: tell the payee the outcome.
   */
  async afterTransfer(payout: P, result: TransferOutcome, notify = true): Promise<P> {
    const table = this.book.table(this.prisma);
    if (!result.ok && result.unknown) {
      this.logger.warn(`${this.book.label} ${payout.reference}: no clear answer from Paystack (${result.reason}); left in flight until Paystack confirms.`);
      return table.update({ where: { id: payout.id }, data: { status: PayoutStatus.PROCESSING } });
    }
    if (!result.ok) return this.fail(payout.id, result.reason, notify);

    this.logger.log(`${this.book.label} ${payout.reference}: ${ghs(payout.amount)} accepted by Paystack (${result.status}).`);
    if (result.status !== 'success') {
      return table.update({ where: { id: payout.id }, data: { status: PayoutStatus.PROCESSING, transferCode: result.transferCode } });
    }
    // Conditional, like succeed(): a webhook that already settled it wins.
    await table.updateMany({ where: { id: payout.id, status: { in: IN_FLIGHT } }, data: { transferCode: result.transferCode } });
    await this.succeed(payout.id, notify);
    return table.findUniqueOrThrow({ where: { id: payout.id } });
  }

  /** Marks a payout failed and puts its amount back in the balance (once). */
  async fail(payoutId: string, reason: string, notify = true): Promise<P> {
    const { payout, changed } = await this.prisma.$transaction(async (tx) => {
      const table = this.book.table(tx);
      const { count } = await table.updateMany({
        where: { id: payoutId, status: { not: PayoutStatus.FAILED } },
        data: { status: PayoutStatus.FAILED, failureReason: reason.slice(0, 500) },
      });
      const payout = await table.findUniqueOrThrow({ where: { id: payoutId } });
      if (count === 1) {
        await this.book.addEntry(tx, payout, 'PAYOUT_REVERSAL', payout.amount);
        this.logger.warn(`${this.book.label} ${payout.reference} failed: ${reason}`);
      }
      return { payout, changed: count === 1 };
    });
    if (changed && notify) this.book.tell(payout, 'failed');
    return payout;
  }

  /**
   * Marks a payout paid. If it had been marked failed (and its amount put back), the money
   * did go out after all: take it off the balance again, so it can't be withdrawn twice.
   */
  private async succeed(payoutId: string, notify = true): Promise<void> {
    const landed = await this.prisma.$transaction(async (tx) => {
      const table = this.book.table(tx);
      const paid = { status: PayoutStatus.SUCCESS, paidAt: new Date() };
      const { count } = await table.updateMany({ where: { id: payoutId, status: { in: IN_FLIGHT } }, data: paid });
      if (count === 1) return table.findUniqueOrThrow({ where: { id: payoutId } });

      const reopened = await table.updateMany({ where: { id: payoutId, status: PayoutStatus.FAILED }, data: paid });
      if (reopened.count === 1) {
        const payout = await table.findUniqueOrThrow({ where: { id: payoutId } });
        await this.book.addEntry(tx, payout, 'PAYOUT', -payout.amount);
        this.logger.error(`${this.book.label} ${payout.reference} was marked failed but Paystack paid it: ${ghs(payout.amount)} taken off the balance again.`);
      }
      return null; // the payee was already told it failed; an admin sorts this one out
    });
    if (landed && notify) this.book.tell(landed, 'paid');
  }

  /**
   * Paystack's transfer.success / transfer.failed / transfer.reversed webhooks (the
   * signature is checked by the caller). The event only prompts a check with Paystack.
   * Returns false for a reference that isn't in this book. Throws 503 when Paystack can't be
   * asked, so Paystack sends the webhook again later.
   */
  async handleTransferEvent(event: string, data: { reference?: string } | undefined): Promise<boolean> {
    const payout = data?.reference ? await this.book.table(this.prisma).findUnique({ where: { reference: data.reference } }) : null;
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
   * Settles the payouts matching `owner` (e.g. `{ tenantId }`) that have been in flight too
   * long, by asking Paystack, so a lost webhook or unanswered request doesn't block the payee
   * for ever.
   */
  async reconcileStale(owner: object): Promise<void> {
    const table = this.book.table(this.prisma);
    const stale = await table.findMany({ where: { ...owner, status: { in: IN_FLIGHT }, updatedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } } });
    for (const payout of stale) {
      const state = await this.transfers.verifyTransfer(payout.reference);
      // Paystack never got it, long after we asked: it won't go out now, so give the money back.
      if (state.state === 'not_found') await this.fail(payout.id, 'Paystack never received this transfer.');
      else if (state.state === 'success' || state.state === 'failed') await this.applyState(payout, state);
      else await table.update({ where: { id: payout.id }, data: { updatedAt: new Date() } }); // check again later
    }
  }

  private async applyState(payout: P, state: Extract<TransferState, { state: 'success' | 'failed' | 'pending' }>) {
    if (state.state === 'success') await this.succeed(payout.id);
    else if (state.state === 'failed') await this.fail(payout.id, state.reason);
  }
}
