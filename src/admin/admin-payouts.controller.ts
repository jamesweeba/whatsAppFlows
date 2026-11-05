import { Body, Controller, DefaultValuePipe, Get, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Request, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/guards/roles.guard.js';
import { parseChoice } from '../common/query.util.js';
import { PAYOUT_STATUS_FILTERS, PayoutReportService } from '../payout/payout-report.service.js';
import { AdminPayoutsService } from './admin-payouts.service.js';

export class PausePayoutsDto {
  @IsBoolean()
  paused: boolean;

  /** Required when pausing. */
  @IsString()
  @MaxLength(500)
  @IsOptional()
  reason?: string;
}

@Controller('api/v1/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminPayoutsController {
  constructor(
    private readonly reports: PayoutReportService,
    private readonly actions: AdminPayoutsService,
  ) {}

  /** Tiles: owed to and by vendors, paid out and commission in 30 days, failed payouts. GET /admin/payouts/summary */
  @Get('payouts/summary')
  summary() {
    return this.reports.adminSummary();
  }

  /** Shops with money owed or payouts on record, largest balance first. GET /admin/payouts/balances?search=&page=&limit= */
  @Get('payouts/balances')
  balances(
    @Query('search') search?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    return this.reports.balances({ search, page, limit });
  }

  /** GET /admin/payouts?status=failed&search=&page=&limit= */
  @Get('payouts')
  list(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    return this.reports.payoutList({ status: parseChoice(status, PAYOUT_STATUS_FILTERS, 'status'), search, page, limit });
  }

  /** POST /admin/payouts/:id/retry */
  @Post('payouts/:id/retry')
  @HttpCode(HttpStatus.OK)
  retry(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.actions.retry(req.user.id, id);
  }

  /** One shop's money: balance, totals, waiting orders. GET /admin/tenants/:id/payouts/summary */
  @Get('tenants/:id/payouts/summary')
  shopSummary(@Param('id', ParseUUIDPipe) id: string) {
    return this.reports.shopSummary(id);
  }

  /** GET /admin/tenants/:id/payouts/statement?page=&limit= */
  @Get('tenants/:id/payouts/statement')
  shopStatement(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    return this.reports.shopEntries(id, { page, limit });
  }

  /** POST /admin/tenants/:id/payouts/pay-now */
  @Post('tenants/:id/payouts/pay-now')
  @HttpCode(HttpStatus.OK)
  payNow(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.actions.payNow(req.user.id, id);
  }

  /** POST /admin/tenants/:id/payouts/pause { paused, reason? } */
  @Post('tenants/:id/payouts/pause')
  @HttpCode(HttpStatus.OK)
  pause(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PausePayoutsDto) {
    return this.actions.setPaused(req.user.id, id, dto.paused, dto.reason);
  }

  /** Pay the vendor for a delivered order the buyer never confirmed. POST /admin/orders/:id/release */
  @Post('orders/:id/release')
  @HttpCode(HttpStatus.OK)
  release(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.actions.releaseOrder(req.user.id, id);
  }
}
