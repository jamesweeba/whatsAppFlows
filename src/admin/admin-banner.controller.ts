import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Request, StreamableFile, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/guards/roles.guard.js';
import { AdminBannerService } from './admin-banner.service.js';
import { ApproveBannerDto, RejectBannerDto, RemoveBannerDto } from './dto/banner-review.dto.js';

/** Approving, rejecting and removing shop banners. The current state is in GET /admin/tenants/:id (`banner`). */
@Controller('api/v1/admin/tenants/:id/banner')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminBannerController {
  constructor(private readonly banners: AdminBannerService) {}

  /** The upload waiting for approval. GET /admin/tenants/:id/banner/pending */
  @Get('pending')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async pending(@Param('id', ParseUUIDPipe) id: string) {
    return new StreamableFile(await this.banners.openPending(id), { type: 'image/jpeg', disposition: 'inline' });
  }

  /** POST /admin/tenants/:id/banner/approve { pendingAt } */
  @Post('approve')
  @HttpCode(HttpStatus.OK)
  approve(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ApproveBannerDto) {
    return this.banners.approve(req.user.id, id, dto.pendingAt);
  }

  /** POST /admin/tenants/:id/banner/reject { pendingAt, reason } */
  @Post('reject')
  @HttpCode(HttpStatus.OK)
  reject(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectBannerDto) {
    return this.banners.reject(req.user.id, id, dto.pendingAt, dto.reason);
  }

  /** Take the live banner down. POST /admin/tenants/:id/banner/remove { reason } */
  @Post('remove')
  @HttpCode(HttpStatus.OK)
  remove(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RemoveBannerDto) {
    return this.banners.remove(req.user.id, id, dto.reason);
  }
}
