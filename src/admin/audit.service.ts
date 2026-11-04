import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma, UserRole } from '@prisma/client';
import { DateRange } from '../common/period.util.js';
import { rangeSql, searchSql, whereSql } from '../common/search-sql.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { formatVendorRef } from '../tenant/vendor-ref.js';
import { MAX_PAGE_SIZE } from './vendor-directory.service.js';

/** How each action reads on the audit log page and in the CSV. */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  REVIEW_STARTED: 'Review started',
  CHECKLIST_UPDATED: 'Checklist updated',
  APPROVED: 'Approved',
  MORE_INFO_REQUESTED: 'More info requested',
  REJECTED: 'Rejected',
  SUSPENDED: 'Suspended',
  NUMBER_RELEASED: 'Number released',
  REINSTATED: 'Reinstated',
  NUMBER_ADDED: 'Number added',
  NUMBER_FREED: 'Number freed early',
  NUMBER_REFRESHED: 'Number refreshed',
  DOCUMENT_VIEWED: 'Document viewed',
  NOTE_ADDED: 'Note added',
  NOTE_EDITED: 'Note edited',
  NOTE_DELETED: 'Note deleted',
  BANNER_APPROVED: 'Banner approved',
  BANNER_REJECTED: 'Banner rejected',
  BANNER_REMOVED: 'Banner removed',
};

/** The most rows one CSV export returns. */
export const MAX_EXPORT_ROWS = 10_000;

export interface AuditEntry {
  actorId: string;
  action: AuditAction;
  tenantId?: string | null;
  numberId?: string | null;
  details?: string | null;
  metadata?: Prisma.InputJsonObject;
}

export interface AuditQuery {
  range: DateRange;
  search?: string;
  actions?: AuditAction[];
  actorId?: string;
}

interface AuditRow {
  id: string;
  createdAt: Date;
  action: AuditAction;
  actorId: string;
  actorName: string;
  tenantId: string | null;
  tenantName: string | null;
  refNumber: number | null;
  numberId: string | null;
  displayNumber: string | null;
  details: string | null;
  metadata: Prisma.JsonValue;
}

/** CSV cell: quoted, and a leading = + - @ neutralised so spreadsheets never run it as a formula. */
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^\+?[\d ]+$/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

/** Writes and reads the append-only admin audit log. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record one admin action. Pass the action's transaction so the entry is written only if
   * the action itself commits. Names are copied in, so the entry still reads correctly
   * after a shop is renamed or deleted.
   */
  async log(tx: Prisma.TransactionClient, entry: AuditEntry) {
    const [actor, tenant, number] = await Promise.all([
      tx.user.findUnique({ where: { id: entry.actorId }, select: { firstName: true, lastName: true } }),
      entry.tenantId ? tx.tenant.findUnique({ where: { id: entry.tenantId }, select: { name: true } }) : null,
      entry.numberId ? tx.whatsappNumber.findUnique({ where: { id: entry.numberId }, select: { displayNumber: true } }) : null,
    ]);
    return tx.auditLog.create({
      data: {
        actorId: entry.actorId,
        actorName: actor ? `${actor.firstName} ${actor.lastName}`.trim() : 'Unknown admin',
        action: entry.action,
        tenantId: entry.tenantId ?? null,
        tenantName: tenant?.name ?? null,
        numberId: entry.numberId ?? null,
        displayNumber: number?.displayNumber ?? null,
        details: entry.details?.trim() || null,
        ...(entry.metadata && { metadata: entry.metadata }),
      },
    });
  }

  /** Newest first. `tenant.exists` is false once the shop has been deleted (show it unlinked). */
  async list(query: AuditQuery & { page?: number; limit?: number }) {
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 25, 1), MAX_PAGE_SIZE);
    const where = this.filterSql(query);

    const [rows, [{ total }]] = await Promise.all([
      this.rows(where, limit, (page - 1) * limit),
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT COUNT(*)::int AS "total" FROM "AuditLog" a LEFT JOIN "Tenant" t ON t."id" = a."tenantId" WHERE ${where}`,
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        action: row.action,
        actionLabel: AUDIT_ACTION_LABELS[row.action],
        actor: { id: row.actorId, name: row.actorName },
        tenant: row.tenantId
          ? { id: row.tenantId, name: row.tenantName, ref: row.refNumber === null ? null : formatVendorRef(row.refNumber), exists: row.refNumber !== null }
          : null,
        number: row.numberId ? { id: row.numberId, displayNumber: row.displayNumber } : null,
        details: row.details,
        metadata: row.metadata,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Every matching entry (up to MAX_EXPORT_ROWS) as a CSV that opens cleanly in Excel. */
  async exportCsv(query: AuditQuery): Promise<Buffer> {
    const rows = await this.rows(this.filterSql(query), MAX_EXPORT_ROWS, 0);
    const lines = [
      ['When (UTC)', 'Admin', 'Action', 'Shop', 'Shop ref', 'Number', 'Details'],
      ...rows.map((r) => [
        r.createdAt.toISOString(),
        r.actorName,
        AUDIT_ACTION_LABELS[r.action],
        r.tenantName,
        r.refNumber === null ? '' : formatVendorRef(r.refNumber),
        r.displayNumber,
        r.details,
      ]),
    ].map((cells) => cells.map(csvCell).join(','));
    // The BOM makes Excel read the file as UTF-8 (GH₵, accented names).
    return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
  }

  /** The Admin filter: current super admins plus anyone who appears in the log. */
  async admins() {
    const [current, logged] = await Promise.all([
      this.prisma.user.findMany({
        where: { role: UserRole.SUPER_ADMIN },
        select: { id: true, firstName: true, lastName: true, email: true },
      }),
      this.prisma.$queryRaw<{ id: string; name: string }[]>`
        SELECT DISTINCT ON ("actorId") "actorId" AS "id", "actorName" AS "name"
        FROM "AuditLog" ORDER BY "actorId", "createdAt" DESC`,
    ]);
    const admins = new Map<string, { id: string; name: string; email: string | null; current: boolean }>(
      current.map((u) => [u.id, { id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), email: u.email, current: true }]),
    );
    for (const actor of logged) {
      if (!admins.has(actor.id)) admins.set(actor.id, { id: actor.id, name: actor.name, email: null, current: false });
    }
    return [...admins.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private rows(where: Prisma.Sql, limit: number, offset: number) {
    return this.prisma.$queryRaw<AuditRow[]>`
      SELECT a."id", a."createdAt", a."action", a."actorId", a."actorName", a."tenantId", a."tenantName",
             t."refNumber", a."numberId", a."displayNumber", a."details", a."metadata"
      FROM "AuditLog" a LEFT JOIN "Tenant" t ON t."id" = a."tenantId"
      WHERE ${where}
      ORDER BY a."createdAt" DESC, a."id"
      LIMIT ${limit} OFFSET ${offset}`;
  }

  /** Period, actions, admin, and search over shop (name or ref), number, admin name and details. */
  private filterSql({ range, search, actions, actorId }: AuditQuery): Prisma.Sql {
    return whereSql([
      ...rangeSql(Prisma.sql`a."createdAt"`, range),
      actions?.length ? Prisma.sql`a."action"::text IN (${Prisma.join(actions)})` : null,
      actorId ? Prisma.sql`a."actorId" = ${actorId}` : null,
      searchSql(search, {
        text: [Prisma.sql`a."tenantName"`, Prisma.sql`a."actorName"`, Prisma.sql`a."details"`],
        phones: [Prisma.sql`a."displayNumber"`],
        ref: Prisma.sql`t."refNumber"`,
      }),
    ]);
  }
}
