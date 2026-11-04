import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { NumberStatus, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/guards/roles.guard.js';
import { parseEnumList } from '../common/query.util.js';
import { AddNumberDto } from './dto/add-number.dto.js';
import { ReleaseNumberDto } from './dto/review-decision.dto.js';
import { NumberPoolService } from './number-pool.service.js';
import { ReviewService } from './review.service.js';

@Controller('api/v1/admin/numbers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminNumbersController {
  constructor(
    private readonly numberPool: NumberPoolService,
    private readonly reviewService: ReviewService,
  ) {}

  /**
   * The pool. COOLING numbers released over 7 days ago are listed as FREE.
   * GET /admin/numbers?status=FREE,COOLING&quality=issues
   */
  @Get()
  list(@Query('status') status?: string, @Query('quality') quality?: string) {
    return this.numberPool.list({ statuses: parseEnumList(status, NumberStatus), qualityIssues: quality === 'issues' });
  }

  /** Tiles and filter-chip counts. GET /admin/numbers/summary */
  @Get('summary')
  summary() {
    return this.numberPool.summary();
  }

  /** POST /admin/numbers { phoneNumberId, displayNumber, wabaId?, displayName? }, checked with Meta first. */
  @Post()
  add(@Request() req: any, @Body() dto: AddNumberDto) {
    return this.numberPool.add(req.user.id, dto);
  }

  /**
   * Skip the cooling period.
   * POST /admin/numbers/:id/free
   */
  @Post(':id/free')
  @HttpCode(HttpStatus.OK)
  free(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.numberPool.free(req.user.id, id);
  }

  /**
   * Refresh every number from Meta.
   * POST /admin/numbers/refresh
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refreshAll(@Request() req: any) {
    return this.numberPool.refreshAll(req.user.id);
  }

  /**
   * Take an assigned number back; suspends the shop first if it is still open.
   * POST /admin/numbers/:id/release { reason? }
   */
  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  release(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReleaseNumberDto) {
    return this.reviewService.releaseNumber(req.user.id, id, dto.reason);
  }

  /**
   * Fetch the quality rating and messaging tier from Meta.
   * POST /admin/numbers/:id/refresh
   */
  @Post(':id/refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.numberPool.refresh(req.user.id, id);
  }
}
