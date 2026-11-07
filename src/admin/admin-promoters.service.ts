import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, PayoutStatus, Prisma, PromoterLedgerEntryType, PromoterMembershipStatus, PromoterStatus } from '@prisma/client';
import { toGhanaLocal } from '../common/phone.util.js';
import { NotificationService } from '../notification/notification.service.js';
import { ghs } from '../payout/payout-math.js';
import { PromoterPayoutService } from '../payout/promoter-payout.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { referralState } from '../promoter/referral-rules.js';
import { AuditService } from './audit.service.js';
import { MAX_PAGE_SIZE } from './vendor-directory.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const PROMOTER_STATUS_FILTERS = ['active', 'suspended', 'signing_up'] as const;
export const PROMOTER_PAYOUT_FILTERS = ['all', 'failed', 'processing', 'success'] as const;

const ORDER_FACTS = { id: true, orderNumber: true, createdAt: true, status: true, paymentMethod: true, paystackPaidAt: true, buyerPhone: true, paymentPhone: true } as const;

interface Page {
  page?: number;
  limit?: number;
}

const pageOf = ({ page = 1, limit = 20 }: Page) => {
  const take = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);
  return { take, skip: (Math.max(page, 1) - 1) * take, page: Math.max(page, 1) };
};

/** A search box for promoters: name, or phone/MoMo digits typed in any format. */
function promoterSearch(search?: string): Prisma.PromoterWhereInput {
  const text = search?.trim();
  if (!text) return {};
  const digits = text.replace(/\D/g, '').replace(/^0/, '');
  return {
    OR: [
      { fullName: { contains: text, mode: 'insensitive' } },
      ...(digits.length >= 3 ? [{ phone: { contains: digits } }, { momoNumber: { contains: digits } }] : []),
    ],
  };
}

/** Super admin: every promoter, their money and payouts, and suspending the ones who cheat. Actions go to the audit log. */
@Injectable()
export class AdminPromotersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payouts: PromoterPayoutService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  /** Tiles for the Promoters page. Amounts in pesewas. */
  async summary() {
    const since = new Date(Date.now() - 30 * DAY_MS);
    const [byStatus, owed, commission30d, failed] = await Promise.all([
      this.prisma.promoter.groupBy({ by: ['status'], _count: true }),
      this.prisma.promoterLedgerEntry.aggregate({ _sum: { amount: true } }),
      this.prisma.promoterLedgerEntry.aggregate({ where: { type: PromoterLedgerEntryType.COMMISSION, createdAt: { gte: since } }, _sum: { amount: true } }),
      this.unresolvedFailures(),
    ]);
    const count = (status: PromoterStatus) => byStatus.find((s) => s.status === status)?._count ?? 0;
    return {
      promoters: { active: count(PromoterStatus.ACTIVE), suspended: count(PromoterStatus.SUSPENDED), signingUp: count(PromoterStatus.SIGNING_UP) },
      owedToPromoters: owed._sum.amount ?? 0,
      commissionLast30Days: commission30d._sum.amount ?? 0,
      failedPayouts: failed,
    };
  }

  /** Promoters with their shops, money and orders, newest first. */
  async list(query: Page & { search?: string; status?: (typeof PROMOTER_STATUS_FILTERS)[number] }) {
    const { take, skip, page } = pageOf(query);
    const where: Prisma.PromoterWhereInput = {
      ...promoterSearch(query.search),
      ...(query.status && { status: query.status.toUpperCase() as PromoterStatus }),
    };
    const [promoters, total] = await Promise.all([
      this.prisma.promoter.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.promoter.count({ where }),
    ]);
    const ids = promoters.map((p) => p.id);
    const now = new Date();
    const [ledger, held, shops, referrals] = await Promise.all([
      this.prisma.promoterLedgerEntry.groupBy({ by: ['promoterId', 'type'], where: { promoterId: { in: ids } }, _sum: { amount: true } }),
      this.prisma.promoterLedgerEntry.groupBy({ by: ['promoterId'], where: { promoterId: { in: ids }, availableAt: { gt: now } }, _sum: { amount: true } }),
      this.prisma.promoterMembership.groupBy({ by: ['promoterId'], where: { promoterId: { in: ids }, status: PromoterMembershipStatus.APPROVED }, _count: true }),
      this.prisma.referral.findMany({ where: { promoterId: { in: ids } }, include: { order: { select: ORDER_FACTS } } }),
    ]);

    const data = promoters.map((p) => {
      const sum = (type?: PromoterLedgerEntryType) =>
        ledger.filter((l) => l.promoterId === p.id && (!type || l.type === type)).reduce((total, l) => total + (l._sum.amount ?? 0), 0);
      const balance = sum();
      const onHold = held.find((h) => h.promoterId === p.id)?._sum.amount ?? 0;
      const theirs = referrals.filter((r) => r.promoterId === p.id);
      const states = theirs.map((r) => referralState(r, r.order, p));
      return {
        id: p.id,
        fullName: p.fullName,
        phone: toGhanaLocal(p.phone),
        status: p.status,
        suspendedReason: p.suspendedReason,
        createdAt: p.createdAt,
        momo: { number: p.momoNumber, name: p.momoName, verified: Boolean(p.momoVerifiedAt) },
        shops: shops.find((s) => s.promoterId === p.id)?._count ?? 0,
        buyers: new Set(theirs.map((r) => r.buyerPhone)).size,
        orders: theirs.filter((r, i) => r.order && states[i].reason !== 'CANCELLED').length,
        /** Orders where the buyer or payer was the promoter: worth a look. */
        ownNumberOrders: states.filter((s) => s.reason === 'OWN_NUMBER').length,
        earned: sum(PromoterLedgerEntryType.COMMISSION),
        balance,
        available: balance - onHold,
      };
    });
    return { data, meta: { total, page, limit: take, totalPages: Math.ceil(total / take) } };
  }

  /** One promoter: shops and links, money, recent orders, payouts and ledger. */
  async detail(id: string) {
    const promoter = await this.prisma.promoter.findUnique({
      where: { id },
      include: {
        memberships: {
          include: {
            tenant: { select: { id: true, name: true, status: true } },
            links: { include: { product: { select: { name: true } } }, orderBy: { createdAt: 'asc' } },
          },
          orderBy: { requestedAt: 'desc' },
        },
      },
    });
    if (!promoter) throw new NotFoundException('Promoter not found.');

    const [funds, earned, referrals, payouts, ledger] = await Promise.all([
      this.payouts.fundsOf(this.prisma, id),
      this.prisma.promoterLedgerEntry.aggregate({ where: { promoterId: id, type: PromoterLedgerEntryType.COMMISSION }, _sum: { amount: true } }),
      this.prisma.referral.findMany({
        where: { promoterId: id },
        include: { order: { select: ORDER_FACTS }, tenant: { select: { id: true, name: true } } },
        orderBy: { tappedAt: 'desc' },
        take: 20,
      }),
      this.prisma.promoterPayout.findMany({ where: { promoterId: id }, orderBy: { createdAt: 'desc' }, take: 10 }),
      this.prisma.promoterLedgerEntry.findMany({ where: { promoterId: id }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);

    return {
      id: promoter.id,
      fullName: promoter.fullName,
      phone: toGhanaLocal(promoter.phone),
      status: promoter.status,
      suspendedReason: promoter.suspendedReason,
      signupStep: promoter.signupStep,
      createdAt: promoter.createdAt,
      termsAcceptedAt: promoter.termsAcceptedAt,
      momo: { number: promoter.momoNumber, network: promoter.momoNetwork, name: promoter.momoName, verified: Boolean(promoter.momoVerifiedAt) },
      money: { ...funds, earned: earned._sum.amount ?? 0 },
      shops: promoter.memberships.map((m) => ({
        id: m.id,
        status: m.status,
        tenant: m.tenant,
        requestedAt: m.requestedAt,
        decidedAt: m.decidedAt,
        links: m.links.map((l) => ({ id: l.id, code: l.code, productName: l.product?.name ?? null, active: l.active })),
      })),
      referrals: referrals.map((r) => {
        const { state, reason } = referralState(r, r.order, promoter);
        return {
          id: r.id,
          tenant: r.tenant,
          buyerPhone: toGhanaLocal(r.buyerPhone),
          linkCode: r.linkCode,
          productName: r.productName,
          ratePercent: r.ratePercent,
          tappedAt: r.tappedAt,
          order: r.order && { id: r.order.id, orderNumber: r.order.orderNumber, status: r.order.status, createdAt: r.order.createdAt },
          commissionAmount: r.commissionAmount,
          state,
          reason: reason ?? null,
        };
      }),
      payouts: payouts.map((p) => this.payoutRow(p, null, false)),
      ledger: ledger.map((e) => ({ id: e.id, type: e.type, amount: e.amount, orderNumber: e.orderNumber, shopName: e.shopName, availableAt: e.availableAt, createdAt: e.createdAt })),
    };
  }

  /** Stop a promoter: their links stop counting, new orders aren't credited, and they can't withdraw. */
  async suspend(adminId: string, id: string, reason: string) {
    const text = reason?.trim();
    if (!text) throw new BadRequestException('Say why the promoter is suspended.');
    const promoter = await this.find(id);
    if (promoter.status === PromoterStatus.SUSPENDED) throw new ConflictException('This promoter is already suspended.');

    await this.prisma.$transaction(async (tx) => {
      await tx.promoter.update({ where: { id }, data: { status: PromoterStatus.SUSPENDED, suspendedReason: text } });
      await this.audit.log(tx, { actorId: adminId, action: AuditAction.PROMOTER_SUSPENDED, details: `${this.name(promoter)}: ${text}`, metadata: { promoterId: id } });
    });
    void this.notifications.toPromoter(
      promoter.phone,
      'Your MarketiX promoter account has been paused. Your links won’t earn and you can’t withdraw while it’s paused. Please contact MarketiX support.',
    );
    return this.detail(id);
  }

  /** Undo a suspension. Someone suspended halfway through sign-up goes back to finishing it. */
  async reinstate(adminId: string, id: string) {
    const promoter = await this.find(id);
    if (promoter.status !== PromoterStatus.SUSPENDED) throw new ConflictException('Only a suspended promoter can be reinstated.');
    const status = promoter.signupStep ? PromoterStatus.SIGNING_UP : PromoterStatus.ACTIVE;

    await this.prisma.$transaction(async (tx) => {
      await tx.promoter.update({ where: { id }, data: { status, suspendedReason: null } });
      await this.audit.log(tx, { actorId: adminId, action: AuditAction.PROMOTER_REINSTATED, details: `${this.name(promoter)} reinstated.`, metadata: { promoterId: id } });
    });
    void this.notifications.toPromoter(promoter.phone, '✅ Your MarketiX promoter account is active again. Send *LINKS* to get your links.');
    return this.detail(id);
  }

  /** Promoter payouts, newest first. */
  async payoutList(query: Page & { search?: string; status?: (typeof PROMOTER_PAYOUT_FILTERS)[number] }) {
    const { take, skip, page } = pageOf(query);
    const status = query.status && query.status !== 'all' ? (query.status.toUpperCase() as PayoutStatus) : undefined;
    const search = query.search?.trim();
    const where: Prisma.PromoterPayoutWhereInput = {
      ...(status && { status: status === PayoutStatus.PROCESSING ? { in: [PayoutStatus.PENDING, PayoutStatus.PROCESSING] } : status }),
      ...(search && { OR: [{ reference: { contains: search } }, { promoter: promoterSearch(search) }] }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.promoterPayout.findMany({ where, include: { promoter: true }, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.promoterPayout.count({ where }),
    ]);
    const newer = await this.newerPayoutExists(rows);
    return { data: rows.map((p) => this.payoutRow(p, p.promoter, newer.has(p.id))), meta: { total, page, limit: take, totalPages: Math.ceil(total / take) } };
  }

  /** Try a failed payout again: sends the promoter's whole available balance, which includes it. */
  async retryPayout(adminId: string, payoutId: string) {
    const failed = await this.prisma.promoterPayout.findUnique({ where: { id: payoutId }, include: { promoter: true } });
    if (!failed) throw new NotFoundException('Payout not found.');
    if (failed.status !== PayoutStatus.FAILED) throw new ConflictException('Only a failed payout can be retried.');
    if (await this.prisma.promoterPayout.count({ where: { promoterId: failed.promoterId, createdAt: { gt: failed.createdAt } } })) {
      throw new ConflictException('A newer payout has already been sent to this promoter. Showing the latest.');
    }

    const result = await this.payouts.payNow(failed.promoterId, adminId);
    if (result.kind === 'refused') throw new ConflictException(result.message);
    await this.prisma.$transaction((tx) =>
      this.audit.log(tx, {
        actorId: adminId,
        action: AuditAction.PROMOTER_PAYOUT_RETRIED,
        details: `${this.name(failed.promoter)}: retried ${failed.reference}, sent ${ghs(result.amount)} (${result.kind}).`,
        metadata: { promoterId: failed.promoterId, payoutId: result.payoutId, retriedId: failed.id },
      }),
    );
    const payout = await this.prisma.promoterPayout.findUniqueOrThrow({ where: { id: result.payoutId }, include: { promoter: true } });
    return this.payoutRow(payout, payout.promoter, false);
  }

  // ───────────────────────── Helpers ─────────────────────────

  private async find(id: string) {
    const promoter = await this.prisma.promoter.findUnique({ where: { id } });
    if (!promoter) throw new NotFoundException('Promoter not found.');
    return promoter;
  }

  private name(promoter: { fullName: string | null; phone: string }) {
    return `${promoter.fullName ?? 'Promoter'} (${toGhanaLocal(promoter.phone)})`;
  }

  private payoutRow(
    p: Prisma.PromoterPayoutGetPayload<object>,
    promoter: { id: string; fullName: string | null; phone: string } | null,
    superseded: boolean,
  ) {
    return {
      id: p.id,
      createdAt: p.createdAt,
      amount: p.amount,
      status: p.status,
      reference: p.reference,
      momoNumber: p.momoNumber,
      momoName: p.momoName,
      failureReason: p.failureReason,
      paidAt: p.paidAt,
      /** Sent by an admin (a retry), not withdrawn by the promoter. */
      byAdmin: Boolean(p.initiatedById),
      /** A failed payout with a newer one after it: nothing left to retry. */
      superseded,
      promoter: promoter && { id: promoter.id, fullName: promoter.fullName, phone: toGhanaLocal(promoter.phone) },
    };
  }

  /** Which of these payouts have a newer payout to the same promoter. */
  private async newerPayoutExists(rows: { id: string; promoterId: string; createdAt: Date }[]): Promise<Set<string>> {
    const latest = await this.prisma.promoterPayout.groupBy({ by: ['promoterId'], where: { promoterId: { in: rows.map((r) => r.promoterId) } }, _max: { createdAt: true } });
    const newest = new Map(latest.map((l) => [l.promoterId, l._max.createdAt?.getTime() ?? 0]));
    return new Set(rows.filter((r) => r.createdAt.getTime() < (newest.get(r.promoterId) ?? 0)).map((r) => r.id));
  }

  /** Failed payouts with nothing sent to the promoter since. */
  private async unresolvedFailures(): Promise<number> {
    const failed = await this.prisma.promoterPayout.findMany({ where: { status: PayoutStatus.FAILED }, select: { id: true, promoterId: true, createdAt: true } });
    const superseded = await this.newerPayoutExists(failed);
    return failed.filter((f) => !superseded.has(f.id)).length;
  }
}
