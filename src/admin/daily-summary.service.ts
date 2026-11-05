import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CANCELLED_ORDER_STATUSES, PAID_ORDER_STATUSES } from '../order/order-status-groups.js';
import { PayoutReportService } from '../payout/payout-report.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { REVIEWABLE } from './review.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const inList = (statuses: string[]) => Prisma.join(statuses);

/** "2026-11-04" in Accra (GMT all year, so the UTC date). */
const dayOf = (date: Date) => date.toISOString().slice(0, 10);

/**
 * One day of MarketiX at a glance for admins: sales, commission, payouts and new shops on
 * that day (Accra time), plus what needs an admin right now. Amounts are pesewas.
 */
@Injectable()
export class DailySummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payoutReports: PayoutReportService,
  ) {}

  /** `date` is yyyy-mm-dd; defaults to yesterday. */
  async summary(date?: string, now = new Date()) {
    const today = dayOf(now);
    const day = date?.trim() || dayOf(new Date(now.getTime() - DAY_MS));
    const from = new Date(`${day}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(from.getTime()) || dayOf(from) !== day) {
      throw new BadRequestException('date must be a day like 2026-11-04.');
    }
    if (day > today) throw new BadRequestException("That day hasn't happened yet.");
    const to = new Date(from.getTime() + DAY_MS);

    const [orders, topShops, ledger, paidOut, newShops, failedPayouts, pendingBanners, waitingForReview] = await Promise.all([
      this.prisma.$queryRaw<{ placed: number; sales: number; paidOnline: number; cash: number; cancelled: number }[]>`
        SELECT COUNT(*) FILTER (WHERE "status"::text IN (${inList(PAID_ORDER_STATUSES)}))::int AS "placed",
               COALESCE(ROUND(SUM("totalAmount" * 100) FILTER (WHERE "status"::text IN (${inList(PAID_ORDER_STATUSES)}))), 0)::int AS "sales",
               COUNT(*) FILTER (WHERE "status"::text IN (${inList(PAID_ORDER_STATUSES)}) AND "paystackPaidAt" IS NOT NULL)::int AS "paidOnline",
               COUNT(*) FILTER (WHERE "status"::text IN (${inList(PAID_ORDER_STATUSES)}) AND "paymentMethod" = 'COD')::int AS "cash",
               COUNT(*) FILTER (WHERE "status"::text IN (${inList(CANCELLED_ORDER_STATUSES)}))::int AS "cancelled"
        FROM "Order" WHERE "createdAt" >= ${from} AND "createdAt" < ${to}`,
      this.prisma.$queryRaw<{ id: string; name: string; orders: number; sales: number }[]>`
        SELECT t."id", t."name", COUNT(*)::int AS "orders", ROUND(SUM(o."totalAmount" * 100))::int AS "sales"
        FROM "Order" o JOIN "Tenant" t ON t."id" = o."tenantId"
        WHERE o."createdAt" >= ${from} AND o."createdAt" < ${to} AND o."status"::text IN (${inList(PAID_ORDER_STATUSES)})
        GROUP BY t."id", t."name" ORDER BY "sales" DESC, "orders" DESC LIMIT 3`,
      // Commission is counted when it's earned: a paid order once the buyer confirms, a cash order once delivered.
      this.prisma.$queryRaw<{ commission: number; vendorEarnings: number; confirmedOrders: number }[]>`
        SELECT COALESCE(SUM(("details"->>'commission')::int) FILTER (WHERE "type" IN ('ORDER_EARNING', 'CASH_COMMISSION')), 0)::int AS "commission",
               COALESCE(SUM("amount") FILTER (WHERE "type" = 'ORDER_EARNING'), 0)::int AS "vendorEarnings",
               COUNT(*) FILTER (WHERE "type" IN ('ORDER_EARNING', 'CASH_COMMISSION'))::int AS "confirmedOrders"
        FROM "VendorLedgerEntry" WHERE "createdAt" >= ${from} AND "createdAt" < ${to}`,
      this.prisma.vendorPayout.aggregate({ where: { status: 'SUCCESS', paidAt: { gte: from, lt: to } }, _sum: { amount: true }, _count: true }),
      this.prisma.tenant.count({ where: { createdAt: { gte: from, lt: to } } }),
      this.payoutReports.unresolvedFailures(),
      this.prisma.tenant.count({ where: { bannerPendingAt: { not: null } } }),
      this.prisma.tenant.count({ where: { status: { in: REVIEWABLE } } }),
    ]);

    const o = orders[0];
    const l = ledger[0];
    return {
      date: day,
      previousDate: dayOf(new Date(from.getTime() - DAY_MS)),
      nextDate: day < today ? dayOf(to) : null,
      orders: { placed: o?.placed ?? 0, sales: o?.sales ?? 0, paidOnline: o?.paidOnline ?? 0, cash: o?.cash ?? 0, cancelled: o?.cancelled ?? 0 },
      commission: l?.commission ?? 0,
      vendorEarnings: l?.vendorEarnings ?? 0,
      confirmedOrders: l?.confirmedOrders ?? 0,
      paidOut: { amount: paidOut._sum.amount ?? 0, count: paidOut._count },
      newShops,
      topShops,
      /** Right now, whatever day is shown. */
      needsAttention: { failedPayouts, pendingBanners, waitingForReview },
    };
  }
}
