import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PAID_ORDER_STATUSES } from '../order/order-status-groups.js';
import { PrismaService } from '../prisma/prisma.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Best sellers, buyers and recent ratings look back this far. */
export const SALES_WINDOW_DAYS = 30;
const LOW_RATING = 2;
const paid = Prisma.join(PAID_ORDER_STATUSES);

/**
 * How a shop is selling, for the vendor's Money page and the admin's shop page: the last
 * 7 days against the 7 before, best sellers and buyers over 30 days, and buyer ratings.
 * Counts paid orders (and confirmed cash orders), not cancelled ones. Amounts in pesewas.
 */
@Injectable()
export class SalesSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async forShop(tenantId: string, now = new Date()) {
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
    const twoWeeksAgo = new Date(now.getTime() - 14 * DAY_MS);
    const windowStart = new Date(now.getTime() - SALES_WINDOW_DAYS * DAY_MS);

    const [weeks, bestSellers, buyers, ratings, lowRatings] = await Promise.all([
      this.prisma.$queryRaw<{ thisSales: number; thisOrders: number; lastSales: number; lastOrders: number }[]>`
        SELECT COALESCE(ROUND(SUM("totalAmount" * 100) FILTER (WHERE "createdAt" >= ${weekAgo})), 0)::int AS "thisSales",
               COUNT(*) FILTER (WHERE "createdAt" >= ${weekAgo})::int AS "thisOrders",
               COALESCE(ROUND(SUM("totalAmount" * 100) FILTER (WHERE "createdAt" < ${weekAgo})), 0)::int AS "lastSales",
               COUNT(*) FILTER (WHERE "createdAt" < ${weekAgo})::int AS "lastOrders"
        FROM "Order"
        WHERE "tenantId" = ${tenantId} AND "status"::text IN (${paid}) AND "createdAt" >= ${twoWeeksAgo} AND "createdAt" < ${now}`,
      // Grouped by name, so a product renamed or deleted since still shows under the name it sold as.
      this.prisma.$queryRaw<{ productId: string | null; name: string; quantity: number; sales: number }[]>`
        SELECT (ARRAY_AGG(i."productId" ORDER BY o."createdAt" DESC))[1] AS "productId", i."productName" AS "name",
               SUM(i."quantity")::int AS "quantity", ROUND(SUM(i."totalPrice" * 100))::int AS "sales"
        FROM "OrderItem" i JOIN "Order" o ON o."id" = i."orderId"
        WHERE o."tenantId" = ${tenantId} AND o."status"::text IN (${paid}) AND o."createdAt" >= ${windowStart}
        GROUP BY i."productName"
        ORDER BY "sales" DESC, "quantity" DESC, "name" ASC
        LIMIT 5`,
      // A repeat buyer ordered in the window and has more than one paid order with the shop in all.
      this.prisma.$queryRaw<{ buyers: number; repeat: number }[]>`
        SELECT COUNT(*)::int AS "buyers", COUNT(*) FILTER (WHERE "allOrders" > 1)::int AS "repeat"
        FROM (
          SELECT "buyerPhone", COUNT(*) AS "allOrders", MAX("createdAt") AS "lastOrderAt"
          FROM "Order"
          WHERE "tenantId" = ${tenantId} AND "status"::text IN (${paid})
          GROUP BY "buyerPhone"
        ) b
        WHERE "lastOrderAt" >= ${windowStart}`,
      this.prisma.order.aggregate({ where: { tenantId, buyerRating: { not: null } }, _avg: { buyerRating: true }, _count: { buyerRating: true } }),
      this.prisma.order.findMany({
        where: { tenantId, buyerRating: { lte: LOW_RATING }, ratedAt: { gte: windowStart } },
        orderBy: { ratedAt: 'desc' },
        take: 5,
        select: { id: true, orderNumber: true, buyerRating: true, ratedAt: true },
      }),
    ]);

    const w = weeks[0];
    const b = buyers[0];
    const average = ratings._avg.buyerRating;
    return {
      windowDays: SALES_WINDOW_DAYS,
      /** The last 7 days, and the 7 before for comparison. */
      thisWeek: { sales: w?.thisSales ?? 0, orders: w?.thisOrders ?? 0 },
      lastWeek: { sales: w?.lastSales ?? 0, orders: w?.lastOrders ?? 0 },
      /** Top 5 over the window, by sales. */
      bestSellers,
      /** Buyers who ordered in the window; `repeat` of them have ordered more than once. */
      buyers: { total: b?.buyers ?? 0, repeat: b?.repeat ?? 0 },
      /** Buyer ratings (1-5) of delivered orders, all time; low ones from the window. */
      rating: {
        average: average === null ? null : Math.round(average * 10) / 10,
        count: ratings._count.buyerRating,
        recentLow: lowRatings.map((o) => ({ orderId: o.id, orderNumber: o.orderNumber, rating: o.buyerRating!, ratedAt: o.ratedAt! })),
      },
    };
  }
}
