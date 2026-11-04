import { Controller, DefaultValuePipe, Get, ParseIntPipe, ParseUUIDPipe, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { AuditAction, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/guards/roles.guard.js';
import { contentDisposition } from '../common/http.util.js';
import { parsePeriod } from '../common/period.util.js';
import { parseEnumList } from '../common/query.util.js';
import { AuditQuery, AuditService } from './audit.service.js';

/** The admin audit log: read and export only; entries are never edited or deleted. */
@Controller('api/v1/admin/audit-log')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminAuditController {
  constructor(private readonly audit: AuditService) {}

  /**
   * GET /admin/audit-log?search=ama&action=APPROVED,SUSPENDED&adminId=uuid&period=30d&page=1&limit=25
   * (or &from=2026-10-01&to=2026-10-31 instead of period)
   */
  @Get()
  list(
    @Query('search') search?: string,
    @Query('action') action?: string,
    @Query('adminId', new ParseUUIDPipe({ optional: true })) adminId?: string,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit?: number,
  ) {
    return this.audit.list({ ...this.query(search, action, adminId, period, from, to), page, limit });
  }

  /** The Admin filter options. GET /admin/audit-log/admins */
  @Get('admins')
  admins() {
    return this.audit.admins();
  }

  /** Every matching entry as CSV (up to 10,000), same filters as the list. GET /admin/audit-log/export */
  @Get('export')
  async export(
    @Query('search') search?: string,
    @Query('action') action?: string,
    @Query('adminId', new ParseUUIDPipe({ optional: true })) adminId?: string,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const csv = await this.audit.exportCsv(this.query(search, action, adminId, period, from, to));
    const fileName = `marketix-audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    return new StreamableFile(csv, { type: 'text/csv; charset=utf-8', disposition: contentDisposition(fileName, 'attachment') });
  }

  private query(search?: string, action?: string, adminId?: string, period?: string, from?: string, to?: string): AuditQuery {
    return {
      range: parsePeriod(period, from, to),
      search,
      actions: parseEnumList(action, AuditAction, 'action'),
      actorId: adminId,
    };
  }
}
