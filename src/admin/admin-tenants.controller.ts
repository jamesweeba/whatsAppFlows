import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Request,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { TenantStatus, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { contentDisposition } from '../common/http.util.js';
import { parseChoice, parseEnumList } from '../common/query.util.js';
import { Roles, RolesGuard } from '../auth/guards/roles.guard.js';
import { ReviewDecisionDto, SuspendTenantDto, UpdateReviewChecksDto } from './dto/review-decision.dto.js';
import { PRODUCT_STOCK_FILTERS, ReviewService } from './review.service.js';

@Controller('api/v1/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminTenantsController {
  constructor(private readonly reviewService: ReviewService) {}

  /**
   * Counts for the dashboard tiles: waiting, more info, free numbers, active shops.
   * GET /admin/summary
   */
  @Get('summary')
  summary() {
    return this.reviewService.summary();
  }

  /**
   * The review queue, oldest submission first.
   * GET /admin/tenants?status=STOCKED,UNDER_REVIEW (the default)
   */
  @Get('tenants')
  queue(@Query('status') status?: string) {
    return this.reviewService.queue(parseEnumList(status, TenantStatus));
  }

  /** GET /admin/tenants/:id */
  @Get('tenants/:id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.reviewService.detail(id);
  }

  /**
   * Every product of a shop, oldest first, with photos, measures and stock tab counts.
   * GET /admin/tenants/:id/products?search=tom&stock=all|in|out&page=1&limit=20
   */
  @Get('tenants/:id/products')
  products(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('search') search?: string,
    @Query('stock') stock?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    return this.reviewService.products(id, { search, stock: parseChoice(stock, PRODUCT_STOCK_FILTERS, 'stock'), page, limit });
  }

  /** Every view is written to the audit log. GET /admin/tenants/:id/documents/:documentId/file */
  @Get('tenants/:id/documents/:documentId/file')
  async documentFile(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    const { document, stream } = await this.reviewService.openDocument(req.user.id, id, documentId);
    return new StreamableFile(stream, { type: document.mimeType, disposition: contentDisposition(document.fileName) });
  }

  /**
   * Claim a waiting shop for review (STOCKED -> UNDER_REVIEW).
   * POST /admin/tenants/:id/start-review
   */
  @Post('tenants/:id/start-review')
  @HttpCode(HttpStatus.OK)
  startReview(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.reviewService.startReview(req.user.id, id);
  }

  /**
   * Save due-diligence ticks as they are made (any subset). Only while UNDER_REVIEW.
   * PUT /admin/tenants/:id/checks { ghanaCardMatches?, momoNameMatches?, calledOwner?, productsLookGenuine? }
   */
  @Put('tenants/:id/checks')
  saveChecks(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReviewChecksDto) {
    return this.reviewService.saveChecks(req.user.id, id, dto);
  }

  /**
   * Approve (assigns a number and goes live), ask for more info, or reject.
   * POST /admin/tenants/:id/review { decision, checks, notes?, numberId?, displayName? }
   */
  @Post('tenants/:id/review')
  @HttpCode(HttpStatus.OK)
  review(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewDecisionDto) {
    return this.reviewService.decide(req.user.id, id, dto);
  }

  /** POST /admin/tenants/:id/suspend { reason } */
  @Post('tenants/:id/suspend')
  @HttpCode(HttpStatus.OK)
  suspend(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SuspendTenantDto) {
    return this.reviewService.suspend(req.user.id, id, dto.reason);
  }

  /**
   * Take the number back from a suspended shop; it cools for 7 days.
   * POST /admin/tenants/:id/release
   */
  @Post('tenants/:id/release')
  @HttpCode(HttpStatus.OK)
  release(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.reviewService.release(req.user.id, id);
  }

  /**
   * Lift a suspension: ACTIVE again if it kept its number, otherwise back to the queue.
   * POST /admin/tenants/:id/reinstate
   */
  @Post('tenants/:id/reinstate')
  @HttpCode(HttpStatus.OK)
  reinstate(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.reviewService.reinstate(req.user.id, id);
  }
}
