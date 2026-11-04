import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
}
