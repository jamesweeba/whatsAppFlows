import { Injectable } from '@nestjs/common';
import { Prisma, TenantStatus } from '@prisma/client';
import { searchSql, whereSql } from '../common/search-sql.js';
import { PAID_ORDER_STATUSES } from '../order/order-status-groups.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { formatVendorRef } from '../tenant/vendor-ref.js';

/** Tabs on the Vendors page and the shop states each one shows. */
export const VENDOR_TABS = {
  all: Object.values(TenantStatus),
  not_submitted: [TenantStatus.PENDING],
  pending_review: [TenantStatus.STOCKED, TenantStatus.UNDER_REVIEW],
  more_info: [TenantStatus.MORE_INFO],
  active: [TenantStatus.ACTIVE],
  suspended: [TenantStatus.SUSPENDED],
  rejected: [TenantStatus.REJECTED],
} satisfies Record<string, TenantStatus[]>;

export type VendorTab = keyof typeof VENDOR_TABS;

export const VENDOR_SORTS = ['newest', 'orders'] as const;
export type VendorSort = (typeof VENDOR_SORTS)[number];

const ORDER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_PAGE_SIZE = 50;

export interface VendorListQuery {
  tab?: VendorTab;
  search?: string;
  market?: string;
  sort?: VendorSort;
  page?: number;
  limit?: number;
}

interface VendorRow {
  id: string;
  refNumber: number;
  name: string;
  ownerFullName: string | null;
  ownerPhone: string | null;
  market: string | null;
  status: TenantStatus;
  whatsappNumber: string | null;
  createdAt: Date;
  orders30d: number;
  lastOrderAt: Date | null;
  noteCount: number;
}

/** The super admin's directory of every shop on the platform. */
@Injectable()
export class VendorDirectoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One page of shops plus the count for every tab. Search and market narrow the counts
   * too, so the tab badges always match what clicking the tab would show.
   */
  async list(query: VendorListQuery = {}) {
    const tab = query.tab ?? 'all';
    const sort = query.sort ?? 'newest';
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 10, 1), MAX_PAGE_SIZE);
    const filter = this.filterSql(query);

    const [rows, counts] = await Promise.all([
      this.prisma.$queryRaw<VendorRow[]>`
        SELECT t."id", t."refNumber", t."name", t."ownerFullName", t."ownerPhone", t."market", t."status",
               t."whatsappNumber", t."createdAt",
               COALESCE(o."orders30d", 0)::int AS "orders30d", o."lastOrderAt",
               (SELECT COUNT(*)::int FROM "VendorNote" n WHERE n."tenantId" = t."id") AS "noteCount"
        FROM "Tenant" t
        LEFT JOIN (
          SELECT "tenantId",
                 COUNT(*) FILTER (WHERE "createdAt" >= ${new Date(Date.now() - ORDER_WINDOW_MS)}) AS "orders30d",
                 MAX("createdAt") AS "lastOrderAt"
          FROM "Order"
          WHERE "status"::text IN (${Prisma.join(PAID_ORDER_STATUSES)})
          GROUP BY "tenantId"
        ) o ON o."tenantId" = t."id"
        WHERE ${filter} AND t."status"::text IN (${Prisma.join(VENDOR_TABS[tab])})
        ORDER BY ${sort === 'orders' ? Prisma.sql`"orders30d" DESC, t."name" ASC` : Prisma.sql`t."createdAt" DESC`}, t."id"
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      this.prisma.$queryRaw<{ status: TenantStatus; count: number }[]>`
        SELECT t."status", COUNT(*)::int AS "count" FROM "Tenant" t WHERE ${filter} GROUP BY t."status"`,
    ]);

    const byStatus = new Map(counts.map((c) => [c.status, c.count]));
    const tabCounts = Object.fromEntries(
      Object.entries(VENDOR_TABS).map(([key, statuses]) => [key, statuses.reduce((sum, s) => sum + (byStatus.get(s) ?? 0), 0)]),
    ) as Record<VendorTab, number>;
    const total = tabCounts[tab];

    return {
      data: rows.map(({ refNumber, ...row }) => ({ ...row, ref: formatVendorRef(refNumber) })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      counts: tabCounts,
    };
  }

  /** Markets for the filter dropdown, busiest first. */
  async markets() {
    const rows = await this.prisma.$queryRaw<{ market: string; count: number }[]>`
      SELECT MIN(TRIM("market")) AS "market", COUNT(*)::int AS "count"
      FROM "Tenant"
      WHERE NULLIF(TRIM("market"), '') IS NOT NULL
      GROUP BY LOWER(TRIM("market"))
      ORDER BY "count" DESC, "market" ASC`;
    return rows;
  }

  /** Search (shop, owner, phone, WhatsApp number or ref) and market, shared by the page and the counts. */
  private filterSql({ search, market }: VendorListQuery): Prisma.Sql {
    return whereSql([
      searchSql(search, {
        text: [Prisma.sql`t."name"`, Prisma.sql`t."ownerFullName"`],
        phones: [Prisma.sql`t."ownerPhone"`, Prisma.sql`t."whatsappNumber"`],
        ref: Prisma.sql`t."refNumber"`,
      }),
      market?.trim() ? Prisma.sql`LOWER(TRIM(t."market")) = ${market.trim().toLowerCase()}` : null,
    ]);
  }
}
