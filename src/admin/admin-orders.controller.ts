import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/guards/roles.guard.js';
import { parsePeriod } from '../common/period.util.js';
import { parseChoice } from '../common/query.util.js';
import { AdminOrdersService, ORDER_TABS, OrderTab, OVERVIEW_SORTS } from './admin-orders.service.js';

const TABS = Object.keys(ORDER_TABS) as OrderTab[];

/** Read-only order reporting across every shop. */
@Controller('api/v1/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminOrdersController {
  constructor(private readonly orders: AdminOrdersService) {}

  /**
   * Platform tiles and one row per shop.
   * GET /admin/orders/overview?period=30d&search=ama&sort=orders&page=1&limit=10
   * (or &from=2026-10-01&to=2026-10-31 instead of period)
   */
  @Get('orders/overview')
  overview(
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit?: number,
  ) {
    return this.orders.overview({
      range: parsePeriod(period, from, to),
      search,
      sort: parseChoice(sort, OVERVIEW_SORTS, 'sort'),
      page,
      limit,
    });
  }

  /** GET /admin/orders/:id */
  @Get('orders/:id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.detail(id);
  }

  /**
   * One shop's orders.
   * GET /admin/vendors/:id/orders?tab=open&period=30d&search=0244&page=1&limit=20
   */
  @Get('vendors/:id/orders')
  shopOrders(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('tab') tab?: string,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    return this.orders.shopOrders(id, {
      tab: parseChoice(tab, TABS, 'tab'),
      range: parsePeriod(period, from, to),
      search,
      page,
      limit,
    });
  }
}
