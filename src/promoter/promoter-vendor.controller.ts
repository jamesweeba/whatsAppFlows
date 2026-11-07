import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { PromoterMembershipStatus } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { IsPhone } from '../common/validators.js';
import { TenantService } from '../tenant/tenant.service.js';
import { PROMOTER_RATE_MAX, PROMOTER_RATE_MIN } from './promoter-rules.js';
import { PromoterVendorService } from './promoter-vendor.service.js';

const RATE_MESSAGE = `Commission must be a whole number from ${PROMOTER_RATE_MIN}% to ${PROMOTER_RATE_MAX}%.`;
/** Products per approval or invite. */
const MAX_PRODUCTS = 50;

export class PromotionSettingsDto {
  @IsBoolean()
  @IsOptional()
  promotionsEnabled?: boolean;

  @IsBoolean()
  @IsOptional()
  acceptPromoterRequests?: boolean;

  /** Whole percent; null clears it (only while promotions are off). */
  @IsInt({ message: RATE_MESSAGE })
  @Min(PROMOTER_RATE_MIN, { message: RATE_MESSAGE })
  @Max(PROMOTER_RATE_MAX, { message: RATE_MESSAGE })
  @IsOptional()
  promoterRate?: number | null;
}

/** Which products a promoter may promote. Leave it out (or empty) for the whole shop. */
export class ProductScopeDto {
  @IsArray()
  @ArrayMaxSize(MAX_PRODUCTS)
  @IsUUID('all', { each: true })
  @IsOptional()
  productIds?: string[];
}

export class InviteDto extends ProductScopeDto {
  @IsPhone()
  phone: string;
}

export class AddLinkDto {
  /** Leave out for a whole-shop link. */
  @IsUUID('all')
  @IsOptional()
  productId?: string;
}

/** The vendor's promoters: settings, requests, invites and links. */
@Controller('api/v1/promotions')
@UseGuards(JwtAuthGuard)
export class PromoterVendorController {
  constructor(
    private readonly service: PromoterVendorService,
    private readonly tenants: TenantService,
  ) {}

  /** GET /promotions/settings */
  @Get('settings')
  async settings(@Request() req: any) {
    return this.service.settings(await this.tenants.findByUser(req.user.id));
  }

  /** PATCH /promotions/settings { promotionsEnabled?, acceptPromoterRequests?, promoterRate? } */
  @Patch('settings')
  async updateSettings(@Request() req: any, @Body() dto: PromotionSettingsDto) {
    return this.service.updateSettings(await this.tenants.findByUser(req.user.id), dto);
  }

  /** GET /promotions/promoters?status=REQUESTED */
  @Get('promoters')
  async list(@Request() req: any, @Query('status') status?: string) {
    const choice = status?.trim().toUpperCase() as PromoterMembershipStatus | undefined;
    const statuses = Object.values(PromoterMembershipStatus);
    if (choice && !statuses.includes(choice)) throw new BadRequestException(`Unknown status ${status}. Use: ${statuses.join(', ')}.`);
    return this.service.list(await this.tenants.findByUser(req.user.id), choice || undefined);
  }

  /** Orders credited to promoters, newest first. GET /promotions/sales?page=1&limit=10 */
  @Get('sales')
  async sales(
    @Request() req: any,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ) {
    return this.service.sales(await this.tenants.findByUser(req.user.id), Math.max(page, 1), Math.min(Math.max(limit, 1), 50));
  }

  /** POST /promotions/requests/:id/approve { productIds? } */
  @Post('requests/:id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ProductScopeDto) {
    return this.service.approve(await this.tenants.findByUser(req.user.id), id, dto.productIds);
  }

  /** POST /promotions/requests/:id/decline */
  @Post('requests/:id/decline')
  @HttpCode(HttpStatus.OK)
  async decline(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.decline(await this.tenants.findByUser(req.user.id), id);
  }

  /** POST /promotions/invites { phone, productIds? } → the invite, with the join link to send */
  @Post('invites')
  async invite(@Request() req: any, @Body() dto: InviteDto) {
    return this.service.invite(await this.tenants.findByUser(req.user.id), dto.phone, dto.productIds);
  }

  /** DELETE /promotions/invites/:id */
  @Delete('invites/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelInvite(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.cancelInvite(await this.tenants.findByUser(req.user.id), id);
  }

  /** POST /promotions/promoters/:id/links { productId? } */
  @Post('promoters/:id/links')
  async addLink(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddLinkDto) {
    return this.service.addLink(await this.tenants.findByUser(req.user.id), id, dto.productId);
  }

  /** DELETE /promotions/links/:id */
  @Delete('links/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeLink(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.removeLink(await this.tenants.findByUser(req.user.id), id);
  }

  /** DELETE /promotions/promoters/:id → the promoter, now REMOVED */
  @Delete('promoters/:id')
  async remove(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(await this.tenants.findByUser(req.user.id), id);
  }
}
