import { Body, Controller, DefaultValuePipe, Get, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Request, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/guards/roles.guard.js';
import { parseChoice } from '../common/query.util.js';
import { AdminPromotersService, PROMOTER_PAYOUT_FILTERS, PROMOTER_STATUS_FILTERS } from './admin-promoters.service.js';

export class SuspendPromoterDto {
  @IsString()
  @IsNotEmpty({ message: 'Say why the promoter is suspended.' })
  @MaxLength(500)
  reason: string;
}

/** Super admin: promoters and their payouts. */
@Controller('api/v1/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminPromotersController {
  constructor(private readonly promoters: AdminPromotersService) {}

  /** Tiles: promoters by status, owed to promoters, commission in 30 days, failed payouts. GET /admin/promoters/summary */
  @Get('promoters/summary')
  summary() {
    return this.promoters.summary();
  }

  /** GET /admin/promoters?search=&status=active|suspended|signing_up&page=&limit= */
  @Get('promoters')
  list(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    return this.promoters.list({ search, status: parseChoice(status, PROMOTER_STATUS_FILTERS, 'status'), page, limit });
  }

  /** GET /admin/promoter-payouts?status=all|failed|processing|success&search=&page=&limit= */
  @Get('promoter-payouts')
  payouts(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    return this.promoters.payoutList({ search, status: parseChoice(status, PROMOTER_PAYOUT_FILTERS, 'status'), page, limit });
  }

  /** POST /admin/promoter-payouts/:id/retry */
  @Post('promoter-payouts/:id/retry')
  @HttpCode(HttpStatus.OK)
  retry(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.promoters.retryPayout(req.user.id, id);
  }

  /** GET /admin/promoters/:id */
  @Get('promoters/:id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.promoters.detail(id);
  }

  /** POST /admin/promoters/:id/suspend { reason } */
  @Post('promoters/:id/suspend')
  @HttpCode(HttpStatus.OK)
  suspend(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SuspendPromoterDto) {
    return this.promoters.suspend(req.user.id, id, dto.reason);
  }

  /** POST /admin/promoters/:id/reinstate */
  @Post('promoters/:id/reinstate')
  @HttpCode(HttpStatus.OK)
  reinstate(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.promoters.reinstate(req.user.id, id);
  }
}
