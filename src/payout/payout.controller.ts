import { Body, Controller, DefaultValuePipe, Get, ParseIntPipe, Post, Query, Request, UseGuards } from '@nestjs/common';
import { IsInt } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { parseChoice } from '../common/query.util.js';
import { TenantService } from '../tenant/tenant.service.js';
import { PAYOUT_STATUS_FILTERS, PayoutReportService } from './payout-report.service.js';
import { PayoutService } from './payout.service.js';
import { SalesSummaryService } from './sales-summary.service.js';

/**
 * What vendors see when a payout fails. Paystack's own reason (e.g. MarketiX's account
 * limits) is for admins only: the vendor can't act on it.
 */
export const VENDOR_FAILURE_MESSAGE = 'We couldn’t send it this time. Your money is back in your balance, and MarketiX has been told.';

/** A payout as the vendor sees it: the failure reason replaced with VENDOR_FAILURE_MESSAGE. */
export function forVendor<T extends { failureReason: string | null }>(payout: T): T;
export function forVendor<T extends { failureReason: string | null }>(payout: T | null): T | null;
export function forVendor<T extends { failureReason: string | null }>(payout: T | null): T | null {
  return payout && { ...payout, failureReason: payout.failureReason ? VENDOR_FAILURE_MESSAGE : null };
}

export class WithdrawDto {
  /** Pesewas: from GH₵ 1 (100) up to the balance. */
  @IsInt({ message: 'Enter the amount in pesewas, as a whole number.' })
  amount: number;
}

/** The vendor's own money: balance, statement, payouts, and withdrawing to MoMo. */
@Controller('api/v1/payouts')
@UseGuards(JwtAuthGuard)
export class PayoutController {
  constructor(
    private readonly reports: PayoutReportService,
    private readonly payouts: PayoutService,
    private readonly tenants: TenantService,
    private readonly sales: SalesSummaryService,
  ) {}

  /** GET /payouts/summary */
  @Get('summary')
  async summary(@Request() req: any) {
    const tenant = await this.tenants.findByUser(req.user.id);
    const summary = await this.reports.shopSummary(tenant.id);
    return { ...summary, lastPayout: forVendor(summary.lastPayout) };
  }

  /** This week's sales, best sellers, repeat buyers and ratings. GET /payouts/sales */
  @Get('sales')
  async salesSummary(@Request() req: any) {
    const tenant = await this.tenants.findByUser(req.user.id);
    return this.sales.forShop(tenant.id);
  }

  /** Send part or all of the balance to the shop's MoMo. Once per Accra day. POST /payouts/withdraw { amount } */
  @Post('withdraw')
  async withdraw(@Request() req: any, @Body() dto: WithdrawDto) {
    const tenant = await this.tenants.findByUser(req.user.id);
    return forVendor(await this.payouts.withdraw(tenant.id, req.user.id, dto.amount));
  }

  /** The ledger, newest first. GET /payouts/statement?page=1&limit=20 */
  @Get('statement')
  async statement(
    @Request() req: any,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    const tenant = await this.tenants.findByUser(req.user.id);
    const entries = await this.reports.shopEntries(tenant.id, { page, limit });
    return { ...entries, data: entries.data.map((e) => ({ ...e, payout: forVendor(e.payout) })) };
  }

  /** GET /payouts?status=failed&page=1&limit=20 */
  @Get()
  async list(
    @Request() req: any,
    @Query('status') status: string | undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    const tenant = await this.tenants.findByUser(req.user.id);
    const list = await this.reports.payoutList({ tenantId: tenant.id, status: parseChoice(status, PAYOUT_STATUS_FILTERS, 'status'), page, limit });
    return { ...list, data: list.data.map((p) => forVendor(p)) };
  }
}
