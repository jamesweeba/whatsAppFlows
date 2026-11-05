import { Injectable } from '@nestjs/common';
import { LedgerEntryType, PayoutStatus, Prisma } from '@prisma/client';
import { searchSql, whereSql } from '../common/search-sql.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { formatVendorRef } from '../tenant/vendor-ref.js';
import { COMMISSION_PERCENT, MIN_PAYOUT } from './payout-math.js';
import { payoutsEnabled, PayoutService } from './payout.service.js';

export const PAYOUT_STATUS_FILTERS = ['all', 'pending', 'processing', 'success', 'failed'] as const;
export type PayoutStatusFilter = (typeof PAYOUT_STATUS_FILTERS)[number];

const MAX_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

const paging = (page = 1, limit = 20) => {
  const p = Math.max(page, 1);
  const l = Math.min(Math.max(limit, 1), MAX_LIMIT);
  return { page: p, limit: l, skip: (p - 1) * l };
};

/** Read-only views of the ledger and payouts, for vendors and admins. Amounts in pesewas. */
@Injectable()
export class PayoutReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payouts: PayoutService,
  ) {}

  /** A shop's money at a glance: what it's owed, what's on the way, and the totals so far. */
  async shopSummary(tenantId: string) {
    const tenant = await this.payouts.ensureTenant(tenantId);
    // Settle long-running transfers first, so the vendor isn't shown (and blocked by) a stuck one.
    await this.payouts.reconcileStale(tenantId).catch(() => undefined);
    const [balance, byType, inFlight, lastPayout, awaiting, nextWithdrawalAt] = await Promise.all([
      this.payouts.balanceOf(this.prisma, tenantId),
      this.prisma.vendorLedgerEntry.groupBy({ by: ['type'], where: { tenantId }, _sum: { amount: true } }),
      this.prisma.vendorPayout.aggregate({
        where: { tenantId, status: { in: [PayoutStatus.PENDING, PayoutStatus.PROCESSING] } },
        _sum: { amount: true },
      }),
      this.prisma.vendorPayout.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
      this.payouts.awaitingConfirmation(tenantId),
      this.payouts.nextWithdrawalAt(this.prisma, tenantId),
    ]);
    const sum = (type: LedgerEntryType) => byType.find((t) => t.type === type)?._sum.amount ?? 0;
    const commissionOnPaid = await this.commissionOnEarnings({ tenantId });

    return {
      /** Owed to the vendor now (negative: the vendor owes MarketiX commission on cash orders). */
      balance,
      /** Sent to Paystack, waiting for it to land. */
      inFlight: inFlight._sum.amount ?? 0,
      totals: {
        earned: sum(LedgerEntryType.ORDER_EARNING),
        /** MarketiX's 10% on paid orders (already taken off `earned`). */
        commissionOnPaidOrders: commissionOnPaid,
        /** MarketiX's 10% on cash orders (taken off the balance). */
        commissionOnCashOrders: -sum(LedgerEntryType.CASH_COMMISSION),
        paidOut: await this.paidOut({ tenantId }),
      },
      awaitingConfirmation: awaiting,
      lastPayout,
      payouts: {
        enabled: payoutsEnabled(),
        paused: tenant.payoutsPaused,
        pausedReason: tenant.payoutsPausedReason,
        /** Set when the vendor has withdrawn today: the next Accra midnight, when they can again. */
        nextWithdrawalAt,
      },
      momo: { number: tenant.momoNumber, name: tenant.momoName },
      commissionPercent: COMMISSION_PERCENT,
      minPayout: MIN_PAYOUT,
    };
  }

  /** The shop's ledger, newest first. */
  async shopEntries(tenantId: string, query: { page?: number; limit?: number }) {
    const { page, limit, skip } = paging(query.page, query.limit);
    const where = { tenantId };
    const [rows, total] = await Promise.all([
      this.prisma.vendorLedgerEntry.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
        include: { payout: { select: { id: true, status: true, reference: true, failureReason: true, paidAt: true } } },
      }),
      this.prisma.vendorLedgerEntry.count({ where }),
    ]);
    return { data: rows, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  /** Payouts, newest first: one shop's, or every shop's for admins. */
  async payoutList(query: { tenantId?: string; status?: PayoutStatusFilter; search?: string; page?: number; limit?: number }) {
    const { page, limit, skip } = paging(query.page, query.limit);
    const where: Prisma.VendorPayoutWhereInput = {
      ...(query.tenantId && { tenantId: query.tenantId }),
      ...(query.status && query.status !== 'all' && { status: query.status.toUpperCase() as PayoutStatus }),
      ...(query.search?.trim() && {
        OR: [
          { tenant: { name: { contains: query.search.trim(), mode: 'insensitive' } } },
          { momoNumber: { contains: query.search.replace(/\D/g, '') || query.search.trim() } },
          { reference: { contains: query.search.trim() } },
        ],
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.vendorPayout.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
        include: { tenant: { select: { id: true, name: true, refNumber: true } } },
      }),
      this.prisma.vendorPayout.count({ where }),
    ]);
    // A failed payout is resolved once a newer one exists for the shop (a retry or "Pay now").
    const latest = await this.latestPayoutIds([...new Set(rows.map((r) => r.tenantId))]);
    return {
      data: rows.map(({ tenant, ...p }) => ({
        ...p,
        superseded: latest.get(p.tenantId) !== p.id,
        tenant: { id: tenant.id, name: tenant.name, ref: formatVendorRef(tenant.refNumber) },
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  private async latestPayoutIds(tenantIds: string[]): Promise<Map<string, string>> {
    if (!tenantIds.length) return new Map();
    const rows = await this.prisma.$queryRaw<{ tenantId: string; id: string }[]>`
      SELECT DISTINCT ON ("tenantId") "tenantId", "id" FROM "VendorPayout"
      WHERE "tenantId" IN (${Prisma.join(tenantIds)})
      ORDER BY "tenantId", "createdAt" DESC, "id" DESC`;
    return new Map(rows.map((r) => [r.tenantId, r.id]));
  }

  /** Shops whose latest payout failed: money that still needs an admin. */
  async unresolvedFailures(): Promise<number> {
    const [{ count }] = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS "count" FROM (
        SELECT DISTINCT ON ("tenantId") "status" FROM "VendorPayout" ORDER BY "tenantId", "createdAt" DESC, "id" DESC
      ) latest WHERE "status" = 'FAILED'`;
    return count;
  }

  /** Every shop with money owed either way, or a payout on record: largest balance first. */
  async balances(query: { search?: string; page?: number; limit?: number }) {
    const { page, limit, skip } = paging(query.page, query.limit);
    const filter = whereSql([
      searchSql(query.search, { text: [Prisma.sql`t."name"`, Prisma.sql`t."ownerFullName"`], phones: [Prisma.sql`t."momoNumber"`], ref: Prisma.sql`t."refNumber"` }),
    ]);
    const base = Prisma.sql`
      FROM "Tenant" t
      LEFT JOIN (SELECT "tenantId", SUM("amount")::int AS "balance" FROM "VendorLedgerEntry" GROUP BY "tenantId") l ON l."tenantId" = t."id"
      LEFT JOIN (
        SELECT "tenantId",
               SUM("amount") FILTER (WHERE "status" IN ('PENDING', 'PROCESSING'))::int AS "inFlight",
               SUM("amount") FILTER (WHERE "status" = 'SUCCESS')::int AS "paidOut",
               MAX("createdAt") AS "lastPayoutAt"
        FROM "VendorPayout" GROUP BY "tenantId"
      ) p ON p."tenantId" = t."id"
      LEFT JOIN (
        SELECT DISTINCT ON ("tenantId") "tenantId", "status" AS "lastStatus", "failureReason" AS "lastFailure"
        FROM "VendorPayout" ORDER BY "tenantId", "createdAt" DESC, "id" DESC
      ) lp ON lp."tenantId" = t."id"
      WHERE ${filter} AND (l."tenantId" IS NOT NULL OR p."tenantId" IS NOT NULL)`;

    const [rows, [{ total }]] = await Promise.all([
      this.prisma.$queryRaw<
        { id: string; name: string; refNumber: number; momoNumber: string | null; payoutsPaused: boolean; balance: number | null; inFlight: number | null; paidOut: number | null; lastPayoutAt: Date | null; lastStatus: PayoutStatus | null; lastFailure: string | null }[]
      >`SELECT t."id", t."name", t."refNumber", t."momoNumber", t."payoutsPaused",
               l."balance", p."inFlight", p."paidOut", p."lastPayoutAt", lp."lastStatus", lp."lastFailure"
        ${base}
        ORDER BY COALESCE(l."balance", 0) DESC, t."name" ASC, t."id"
        LIMIT ${limit} OFFSET ${skip}`,
      this.prisma.$queryRaw<{ total: number }[]>`SELECT COUNT(*)::int AS "total" ${base}`,
    ]);

    return {
      data: rows.map(({ refNumber, ...r }) => ({
        ...r,
        ref: formatVendorRef(refNumber),
        balance: r.balance ?? 0,
        inFlight: r.inFlight ?? 0,
        paidOut: r.paidOut ?? 0,
        /** The latest payout failed and needs an admin (retry, or fix the MoMo number). */
        lastPayoutFailed: r.lastStatus === PayoutStatus.FAILED,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Tiles for the admin Payouts page. */
  async adminSummary() {
    const since = new Date(Date.now() - 30 * DAY_MS);
    const [owed, failed, cashCommission, paidOut30d, commission30d] = await Promise.all([
      this.prisma.$queryRaw<{ owedToVendors: number; owedByVendors: number }[]>`
        SELECT COALESCE(SUM(b) FILTER (WHERE b > 0), 0)::int AS "owedToVendors",
               COALESCE(-SUM(b) FILTER (WHERE b < 0), 0)::int AS "owedByVendors"
        FROM (SELECT SUM("amount") AS b FROM "VendorLedgerEntry" GROUP BY "tenantId") s`,
      this.unresolvedFailures(),
      this.prisma.vendorLedgerEntry.aggregate({ where: { type: LedgerEntryType.CASH_COMMISSION, createdAt: { gte: since } }, _sum: { amount: true } }),
      this.paidOut({ since }),
      this.commissionOnEarnings({ since }),
    ]);
    return {
      owedToVendors: owed[0]?.owedToVendors ?? 0,
      owedByVendors: owed[0]?.owedByVendors ?? 0,
      failedPayouts: failed,
      last30Days: { paidOut: paidOut30d, commission: commission30d - (cashCommission._sum.amount ?? 0) },
      payoutsEnabled: payoutsEnabled(),
      commissionPercent: COMMISSION_PERCENT,
    };
  }

  private async paidOut(where: { tenantId?: string; since?: Date }) {
    const { _sum } = await this.prisma.vendorPayout.aggregate({
      where: { status: PayoutStatus.SUCCESS, ...(where.tenantId && { tenantId: where.tenantId }), ...(where.since && { paidAt: { gte: where.since } }) },
      _sum: { amount: true },
    });
    return _sum.amount ?? 0;
  }

  /** Commission kept on paid orders, read from each earning's details. */
  private async commissionOnEarnings(where: { tenantId?: string; since?: Date }) {
    const rows = await this.prisma.$queryRaw<{ total: number }[]>`
      SELECT COALESCE(SUM(("details"->>'commission')::int), 0)::int AS "total"
      FROM "VendorLedgerEntry"
      WHERE "type" = 'ORDER_EARNING'
        ${where.tenantId ? Prisma.sql`AND "tenantId" = ${where.tenantId}` : Prisma.empty}
        ${where.since ? Prisma.sql`AND "createdAt" >= ${where.since}` : Prisma.empty}`;
    return rows[0]?.total ?? 0;
  }
}
