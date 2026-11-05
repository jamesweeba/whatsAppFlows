import { Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma, TenantStatus } from '@prisma/client';
import { DateRange } from '../common/period.util.js';
import { rangeSql, searchSql, whereSql } from '../common/search-sql.js';
import {
  CANCELLED_ORDER_STATUSES,
  DELIVERED_ORDER_STATUSES,
  OPEN_ORDER_STATUSES,
  PLACED_ORDER_STATUSES,
  UNPAID_ORDER_STATUSES,
} from '../order/order-status-groups.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { formatVendorRef } from '../tenant/vendor-ref.js';
import { MAX_PAGE_SIZE } from './vendor-directory.service.js';

/** Status tabs on a shop's order list. `placed` leaves out orders never paid. */
export const ORDER_TABS = {
  placed: PLACED_ORDER_STATUSES,
  open: OPEN_ORDER_STATUSES,
  delivered: DELIVERED_ORDER_STATUSES,
  cancelled: CANCELLED_ORDER_STATUSES,
  unpaid: UNPAID_ORDER_STATUSES,
  all: Object.values(OrderStatus),
} satisfies Record<string, OrderStatus[]>;
export type OrderTab = keyof typeof ORDER_TABS;

export const OVERVIEW_SORTS = ['orders', 'sales', 'recent'] as const;
export type OverviewSort = (typeof OVERVIEW_SORTS)[number];

interface OrderFilter {
  range: DateRange;
  search?: string;
  tenantId?: string;
}

interface Paging {
  page?: number;
  limit?: number;
}

export interface OrderSummary {
  orders: number;
  open: number;
  deliveredSales: number;
  buyers: number;
}

interface ShopRow {
  id: string;
  refNumber: number;
  name: string;
  market: string | null;
  status: TenantStatus;
  orders: number;
  cancelled: number;
  open: number;
  deliveredSales: number;
  lastOrderAt: Date;
}

const inList = (statuses: OrderStatus[]) => Prisma.sql`o."status"::text IN (${Prisma.join(statuses)})`;

/** Tiles, from orders already filtered to the placed ones. */
const SUMMARY_COLUMNS = Prisma.sql`
  COUNT(*)::int AS "orders",
  (COUNT(*) FILTER (WHERE ${inList(OPEN_ORDER_STATUSES)}))::int AS "open",
  COALESCE(SUM(o."totalAmount") FILTER (WHERE ${inList(DELIVERED_ORDER_STATUSES)}), 0)::float AS "deliveredSales",
  COUNT(DISTINCT o."buyerPhone")::int AS "buyers"`;

function paging({ page, limit }: Paging) {
  const safePage = Math.max(page ?? 1, 1);
  const safeLimit = Math.min(Math.max(limit ?? 10, 1), MAX_PAGE_SIZE);
  return { page: safePage, limit: safeLimit, offset: (safePage - 1) * safeLimit };
}

/** Read-only order reporting for super admins, across every shop. */
@Injectable()
export class AdminOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The Orders page: platform-wide tiles and one row per shop with placed orders in the
   * period. Search narrows the orders, so the tiles and rows always agree.
   */
  async overview(filter: OrderFilter & Paging & { sort?: OverviewSort }) {
    const { page, limit, offset } = paging(filter);
    const where = Prisma.sql`${this.filterSql(filter)} AND ${inList(PLACED_ORDER_STATUSES)}`;
    const orderBy = {
      orders: Prisma.sql`"orders" DESC, "lastOrderAt" DESC`,
      sales: Prisma.sql`"deliveredSales" DESC, "orders" DESC`,
      recent: Prisma.sql`"lastOrderAt" DESC`,
    }[filter.sort ?? 'orders'];

    const [[summary], rows, [{ total }]] = await Promise.all([
      this.prisma.$queryRaw<OrderSummary[]>`
        SELECT ${SUMMARY_COLUMNS} FROM "Order" o JOIN "Tenant" t ON t."id" = o."tenantId" WHERE ${where}`,
      this.prisma.$queryRaw<ShopRow[]>`
        SELECT t."id", t."refNumber", t."name", t."market", t."status",
               COUNT(*)::int AS "orders",
               (COUNT(*) FILTER (WHERE ${inList(CANCELLED_ORDER_STATUSES)}))::int AS "cancelled",
               (COUNT(*) FILTER (WHERE ${inList(OPEN_ORDER_STATUSES)}))::int AS "open",
               COALESCE(SUM(o."totalAmount") FILTER (WHERE ${inList(DELIVERED_ORDER_STATUSES)}), 0)::float AS "deliveredSales",
               MAX(o."createdAt") AS "lastOrderAt"
        FROM "Order" o JOIN "Tenant" t ON t."id" = o."tenantId"
        WHERE ${where}
        GROUP BY t."id"
        ORDER BY ${orderBy}, t."name" ASC
        LIMIT ${limit} OFFSET ${offset}`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT COUNT(DISTINCT o."tenantId")::int AS "total" FROM "Order" o JOIN "Tenant" t ON t."id" = o."tenantId" WHERE ${where}`,
    ]);

    return {
      summary,
      data: rows.map(({ refNumber, ...row }) => ({ ...row, ref: formatVendorRef(refNumber) })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** One shop's orders, newest first, with the same tiles and a count for every status tab. */
  async shopOrders(tenantId: string, filter: Omit<OrderFilter, 'tenantId'> & Paging & { tab?: OrderTab }) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, refNumber: true, name: true, market: true, status: true, whatsappNumber: true },
    });
    if (!tenant) {
      throw new NotFoundException('Shop not found.');
    }

    const { page, limit, offset } = paging(filter);
    const base = this.filterSql({ ...filter, tenantId });
    const statuses = ORDER_TABS[filter.tab ?? 'placed'];

    const [[summary], byStatus, ids] = await Promise.all([
      this.prisma.$queryRaw<OrderSummary[]>`
        SELECT ${SUMMARY_COLUMNS} FROM "Order" o JOIN "Tenant" t ON t."id" = o."tenantId"
        WHERE ${base} AND ${inList(PLACED_ORDER_STATUSES)}`,
      this.prisma.$queryRaw<{ status: OrderStatus; count: number }[]>`
        SELECT o."status", COUNT(*)::int AS "count" FROM "Order" o JOIN "Tenant" t ON t."id" = o."tenantId"
        WHERE ${base} GROUP BY o."status"`,
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT o."id" FROM "Order" o JOIN "Tenant" t ON t."id" = o."tenantId"
        WHERE ${base} AND ${inList(statuses)}
        ORDER BY o."createdAt" DESC, o."id"
        LIMIT ${limit} OFFSET ${offset}`,
    ]);

    const orders = await this.prisma.order.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        customerName: true,
        buyerPhone: true,
        totalAmount: true,
        deliveryFee: true,
        paymentMethod: true,
        fulfillment: true,
        deliveryArea: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { items: true } },
      },
    });
    const byId = new Map(orders.map(({ _count, ...o }) => [o.id, { ...o, itemCount: _count.items }]));

    const counted = new Map(byStatus.map((c) => [c.status, c.count]));
    const counts = Object.fromEntries(
      Object.entries(ORDER_TABS).map(([tab, list]) => [tab, list.reduce((sum, s) => sum + (counted.get(s) ?? 0), 0)]),
    ) as Record<OrderTab, number>;
    const total = counts[filter.tab ?? 'placed'];

    const { refNumber, ...shop } = tenant;
    return {
      shop: { ...shop, ref: formatVendorRef(refNumber) },
      summary,
      counts,
      data: ids.map((r) => byId.get(r.id)).filter(Boolean),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Everything about one order: items, delivery, pin location and payment. */
  async detail(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { orderBy: { createdAt: 'asc' } },
        tenant: { select: { id: true, refNumber: true, name: true, market: true, status: true, whatsappNumber: true } },
        ledger: { select: { type: true, amount: true, createdAt: true } },
      },
    });
    if (!order) {
      throw new NotFoundException('Order not found.');
    }
    const { refNumber, ...tenant } = order.tenant;
    const { ledger, ...rest } = order;
    // What the order did to the vendor's balance: their earning (paid orders) or the commission they owe (cash).
    return { ...rest, tenant: { ...tenant, ref: formatVendorRef(refNumber) }, settlement: ledger[0] ?? null };
  }

  /**
   * Period, shop and search. Search matches the shop (name or MX-V ref) or the order
   * (order number, customer name, buyer / contact / MoMo phone).
   */
  private filterSql({ range, search, tenantId }: OrderFilter): Prisma.Sql {
    return whereSql([
      tenantId ? Prisma.sql`o."tenantId" = ${tenantId}` : null,
      ...rangeSql(Prisma.sql`o."createdAt"`, range),
      searchSql(search, {
        text: [Prisma.sql`t."name"`, Prisma.sql`o."orderNumber"`, Prisma.sql`o."customerName"`],
        phones: [Prisma.sql`o."buyerPhone"`, Prisma.sql`o."contactPhone"`, Prisma.sql`o."paymentPhone"`],
        ref: Prisma.sql`t."refNumber"`,
      }),
    ]);
  }
}
