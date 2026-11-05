import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, LedgerEntryType, PaymentMethod, PayoutStatus } from '@prisma/client';
import { DELIVERED_ORDER_STATUSES } from '../order/order-status-groups.js';
import { ghs } from '../payout/payout-math.js';
import { PayoutService } from '../payout/payout.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from './audit.service.js';

/** Admin actions on vendor payouts. Each one is written to the audit log. */
@Injectable()
export class AdminPayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payouts: PayoutService,
    private readonly audit: AuditService,
  ) {}

  /** Try a failed payout again: sends the shop's whole balance, which includes it. */
  async retry(adminId: string, payoutId: string) {
    const failed = await this.prisma.vendorPayout.findUnique({ where: { id: payoutId } });
    if (!failed) throw new NotFoundException('Payout not found.');
    if (failed.status !== PayoutStatus.FAILED) throw new ConflictException('Only a failed payout can be retried.');
    const newer = await this.prisma.vendorPayout.count({ where: { tenantId: failed.tenantId, createdAt: { gt: failed.createdAt } } });
    if (newer) throw new ConflictException('A newer payout has already been sent to this shop. Showing the latest.');

    const payout = await this.payouts.payTenant(failed.tenantId, adminId);
    await this.log(adminId, AuditAction.PAYOUT_RETRIED, failed.tenantId, `Retried ${failed.reference}: sent ${ghs(payout.amount)}.`, { payoutId: payout.id, retriedId: failed.id });
    return payout;
  }

  /** Pay the shop's balance now (e.g. after unpausing, or after fixing its MoMo number). */
  async payNow(adminId: string, tenantId: string) {
    await this.payouts.ensureTenant(tenantId);
    const payout = await this.payouts.payTenant(tenantId, adminId);
    await this.log(adminId, AuditAction.PAYOUT_SENT, tenantId, `Sent ${ghs(payout.amount)} to ${payout.momoNumber}.`, { payoutId: payout.id });
    return payout;
  }

  /** Stop or restart a shop's withdrawals (and Pay now). Money keeps accruing while paused. */
  async setPaused(adminId: string, tenantId: string, paused: boolean, reason?: string) {
    const tenant = await this.payouts.ensureTenant(tenantId);
    if (paused && !reason?.trim()) throw new BadRequestException('Say why payouts are paused.');
    if (tenant.payoutsPaused === paused) return { paused };

    await this.prisma.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id: tenantId }, data: { payoutsPaused: paused, payoutsPausedReason: paused ? reason!.trim() : null } });
      await this.audit.log(tx, {
        actorId: adminId,
        action: paused ? AuditAction.PAYOUTS_PAUSED : AuditAction.PAYOUTS_RESUMED,
        tenantId,
        details: paused ? reason!.trim() : 'Payouts resumed.',
      });
    });
    return { paused };
  }

  /**
   * Credit the vendor for a paid order that was delivered but the buyer never tapped
   * "I got my order" (e.g. after the admin checked with the buyer).
   */
  async releaseOrder(adminId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found.');
    if (order.paymentMethod === PaymentMethod.COD || !order.paystackPaidAt) {
      throw new ConflictException('Only orders paid through Paystack are paid out to the vendor.');
    }
    if (!DELIVERED_ORDER_STATUSES.includes(order.status)) throw new ConflictException('Only a delivered order can be released.');
    if (await this.prisma.vendorLedgerEntry.count({ where: { orderId, type: LedgerEntryType.ORDER_EARNING } })) {
      throw new ConflictException('This order has already been paid out to the vendor.');
    }

    await this.payouts.settleOrder(orderId, { released: true });
    await this.log(adminId, AuditAction.ORDER_RELEASED, order.tenantId, `Released ${order.orderNumber} without the buyer's confirmation.`, { orderId });
    // The vendor can now withdraw it, or an admin can "Pay now".
    return { released: true };
  }

  private log(adminId: string, action: AuditAction, tenantId: string, details: string, metadata: Record<string, string>) {
    return this.prisma.$transaction((tx) => this.audit.log(tx, { actorId: adminId, action, tenantId, details, metadata }));
  }
}
