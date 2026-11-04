import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  Post,
  Request,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { TenantService } from './tenant.service.js';
import { MAX_BANNER_BYTES, ShopBannerService } from './shop-banner.service.js';
import { MAX_DOCUMENT_BYTES, OnboardingService } from './onboarding.service.js';
import { CreateTenantDto } from './dto/create-tenant.dto.js';
import { UpdateTenantDto } from './dto/update-tenant.dto.js';
import { UploadDocumentDto } from './dto/upload-document.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { contentDisposition } from '../common/http.util.js';

@Controller('api/v1/tenants')
@UseGuards(JwtAuthGuard)
export class TenantController {
  constructor(
    private readonly tenantService: TenantService,
    private readonly onboardingService: OnboardingService,
    private readonly bannerService: ShopBannerService,
  ) {}

  @Post()
  async create(@Request() req: any, @Body() dto: CreateTenantDto) {
    return this.tenantService.create(req.user.id, dto);
  }

  @Get('')
  async findMine(@Request() req: any) {
    return this.tenantService.findByUser(req.user.id);
  }

  @Put('')
  async updateMine(@Request() req: any, @Body() dto: UpdateTenantDto) {
    return this.tenantService.update(req.user.id, dto);
  }

  /**
   * Onboarding state and the steps still to do, for the dashboard.
   * GET /tenants/status
   */
  @Get('status')
  async status(@Request() req: any) {
    return this.onboardingService.status(req.user.id);
  }

  /**
   * Send the shop back for review after "more info" or a rejection.
   * POST /tenants/resubmit
   */
  @Post('resubmit')
  @HttpCode(HttpStatus.OK)
  async resubmit(@Request() req: any) {
    return this.onboardingService.resubmit(req.user.id);
  }

  /**
   * Upload a KYC document. Multipart form: `file` (JPEG, PNG, WebP or PDF, max 5 MB) and
   * `type` (GHANA_CARD_FRONT, GHANA_CARD_BACK, STALL_PHOTO, BUSINESS_REG).
   * POST /tenants/documents
   */
  @Post('documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_DOCUMENT_BYTES } }))
  async uploadDocument(@Request() req: any, @UploadedFile() file: Express.Multer.File, @Body() dto: UploadDocumentDto) {
    if (!file) {
      throw new BadRequestException('Attach the document as the "file" field.');
    }
    return this.onboardingService.uploadDocument(req.user.id, dto.type, file);
  }

  /** GET /tenants/documents */
  @Get('documents')
  async listDocuments(@Request() req: any) {
    return this.onboardingService.listDocuments(req.user.id);
  }

  /** GET /tenants/documents/:id/file */
  @Get('documents/:id/file')
  async documentFile(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const { document, stream } = await this.onboardingService.openOwnDocument(req.user.id, id);
    return new StreamableFile(stream, { type: document.mimeType, disposition: contentDisposition(document.fileName) });
  }

  /** The shop banner: the approved one, an upload waiting for approval, and any rejection reason. GET /tenants/banner */
  @Get('banner')
  async banner(@Request() req: any) {
    return this.bannerService.state(req.user.id);
  }

  /**
   * Upload a banner (multipart `file`: JPEG, PNG or WebP, max 5 MB, at least 300 px each side).
   * It waits for an admin's approval before buyers see it. POST /tenants/banner
   */
  @Post('banner')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BANNER_BYTES } }))
  async uploadBanner(@Request() req: any, @UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('Attach the image as the "file" field.');
    }
    return this.bannerService.upload(req.user.id, file);
  }

  /** The vendor's own upload that is waiting for approval. GET /tenants/banner/pending */
  @Get('banner/pending')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async pendingBanner(@Request() req: any) {
    return new StreamableFile(await this.bannerService.openOwnPending(req.user.id), { type: 'image/jpeg', disposition: 'inline' });
  }

  /** Withdraw the upload waiting for approval. DELETE /tenants/banner/pending */
  @Delete('banner/pending')
  async cancelPendingBanner(@Request() req: any) {
    return this.bannerService.cancelPending(req.user.id);
  }

  /** Take the approved banner down; buyers stop seeing it at once. DELETE /tenants/banner */
  @Delete('banner')
  async removeBanner(@Request() req: any) {
    return this.bannerService.removeLive(req.user.id);
  }
}

/** The approved banner is public: buyers' browsers load it without a token. */
@Controller('api/v1/shops')
export class ShopBannerController {
  constructor(private readonly bannerService: ShopBannerService) {}

  /** The URL carries a version (`?v=`), so it can be cached for good. GET /shops/:id/banner */
  @Get(':id/banner')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  @Header('X-Content-Type-Options', 'nosniff')
  async banner(@Param('id', ParseUUIDPipe) id: string) {
    return new StreamableFile(await this.bannerService.openLive(id), { type: 'image/jpeg', disposition: 'inline' });
  }
}
