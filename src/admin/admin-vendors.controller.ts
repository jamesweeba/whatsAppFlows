import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/guards/roles.guard.js';
import { parseChoice } from '../common/query.util.js';
import { VENDOR_SORTS, VENDOR_TABS, VendorDirectoryService, VendorTab } from './vendor-directory.service.js';

const TABS = Object.keys(VENDOR_TABS) as VendorTab[];

@Controller('api/v1/admin/vendors')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminVendorsController {
  constructor(private readonly directory: VendorDirectoryService) {}

  /**
   * Every shop on the platform, with tab counts.
   * GET /admin/vendors?tab=active&search=ama&market=Kejetia,%20Kumasi&banner=pending&sort=orders&page=1&limit=10
   */
  @Get()
  list(
    @Query('tab') tab?: string,
    @Query('search') search?: string,
    @Query('market') market?: string,
    @Query('sort') sort?: string,
    @Query('banner') banner?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit?: number,
  ) {
    return this.directory.list({ tab: parseChoice(tab, TABS, 'tab'), search, market,
      bannerPending: parseChoice(banner, ['pending'] as const, 'banner') === 'pending',
      sort: parseChoice(sort, VENDOR_SORTS, 'sort'), page, limit });
  }

  /** Markets for the filter dropdown. GET /admin/vendors/markets */
  @Get('markets')
  markets() {
    return this.directory.markets();
  }
}
