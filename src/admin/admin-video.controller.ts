import { Body, Controller, DefaultValuePipe, Get, Header, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Request, StreamableFile, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsDate, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/guards/roles.guard.js';
import { measureParam, videoSlot } from '../product/product.controller.js';
import { AdminVideoService } from './admin-video.service.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class ApproveVideoDto {
  /** `video.pending.uploadedAt` of the upload the admin watched; a newer upload makes this 409. */
  @Type(() => Date)
  @IsDate({ message: 'uploadedAt must be the video.pending.uploadedAt date.' })
  uploadedAt: Date;
}

export class RejectVideoDto extends ApproveVideoDto {
  /** Shown to the vendor. */
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Say why, so the vendor knows what to change.' })
  @MaxLength(500)
  reason: string;
}

export class RemoveVideoDto {
  /** Shown to the vendor. */
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Say why, so the vendor knows what to change.' })
  @MaxLength(500)
  reason: string;
}

/** Reviewing product videos. */
@Controller('api/v1/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminVideoController {
  constructor(private readonly videos: AdminVideoService) {}

  /** Videos waiting for approval, oldest first. GET /admin/videos?page=&limit= */
  @Get('videos')
  waiting(@Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number, @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number) {
    return this.videos.waiting({ page, limit });
  }

  /** GET /admin/products/:id/video (?measure=<code> for a measure's video) */
  @Get('products/:id/video')
  state(@Param('id', ParseUUIDPipe) id: string, @Query('measure') measure?: string) {
    return this.videos.state(id, measureParam(measure));
  }

  /** The pending or live video (MP4). GET /admin/products/:id/video/{pending|live} */
  @Get('products/:id/video/:slot')
  @Header('Cache-Control', 'private, no-store')
  async file(@Param('id', ParseUUIDPipe) id: string, @Param('slot') slot: string, @Query('measure') measure?: string) {
    const { mimeType, stream } = await this.videos.open(id, measureParam(measure), videoSlot(slot), 'video');
    return new StreamableFile(stream, { type: mimeType, disposition: 'inline' });
  }

  /** Its still (JPEG). GET /admin/products/:id/video/{pending|live}/poster */
  @Get('products/:id/video/:slot/poster')
  @Header('Cache-Control', 'private, no-store')
  async poster(@Param('id', ParseUUIDPipe) id: string, @Param('slot') slot: string, @Query('measure') measure?: string) {
    const { mimeType, stream } = await this.videos.open(id, measureParam(measure), videoSlot(slot), 'poster');
    return new StreamableFile(stream, { type: mimeType, disposition: 'inline' });
  }

  /** POST /admin/products/:id/video/approve { uploadedAt } (?measure=<code> for a measure's video) */
  @Post('products/:id/video/approve')
  @HttpCode(HttpStatus.OK)
  approve(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ApproveVideoDto, @Query('measure') measure?: string) {
    return this.videos.approve(req.user.id, id, measureParam(measure), dto.uploadedAt);
  }

  /** POST /admin/products/:id/video/reject { uploadedAt, reason } (?measure=<code> for a measure's video) */
  @Post('products/:id/video/reject')
  @HttpCode(HttpStatus.OK)
  reject(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectVideoDto, @Query('measure') measure?: string) {
    return this.videos.reject(req.user.id, id, measureParam(measure), dto.uploadedAt, dto.reason);
  }

  /** Take a live video down. POST /admin/products/:id/video/remove { reason } */
  @Post('products/:id/video/remove')
  @HttpCode(HttpStatus.OK)
  remove(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RemoveVideoDto, @Query('measure') measure?: string) {
    return this.videos.remove(req.user.id, id, measureParam(measure), dto.reason);
  }
}
