import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/guards/roles.guard.js';
import { DailySummaryService } from './daily-summary.service.js';

@Controller('api/v1/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminDailySummaryController {
  constructor(private readonly daily: DailySummaryService) {}

  /** One day at a glance (default yesterday). GET /admin/daily-summary?date=2026-11-04 */
  @Get('daily-summary')
  summary(@Query('date') date?: string) {
    return this.daily.summary(date);
  }
}
