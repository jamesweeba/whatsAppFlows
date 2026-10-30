import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { MetaSignatureGuard } from '../auth/guards/meta-signature.guard.js';
import { TenantService } from '../tenant/tenant.service.js';
import { EncryptedFlowRequestDto, SendFlowMessageDto } from './dto/flow-request.dto.js';
import { FlowService } from './flow.service.js';

@Controller(['api/v1/flow', 'webhook'])
export class FlowController {
  private readonly logger = new Logger(FlowController.name);

  constructor(
    private readonly flowService: FlowService,
    private readonly tenantService: TenantService,
  ) {}

  /**
   * POST /api/v1/flow
   * Synchronous endpoint for Meta WhatsApp Flows data exchange.
   * Meta signs the request with the app secret; the guard rejects anything else.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(MetaSignatureGuard)
  async handleFlowDataExchange(@Body() body: EncryptedFlowRequestDto): Promise<string> {
    this.logger.log('Incoming Meta WhatsApp Flow data exchange request.');
    return this.flowService.processEncryptedFlowRequest(body);
  }

  /**
   * POST /api/v1/flow/send
   * Lets the authenticated vendor push the ordering Flow to one of their buyers.
   */
  @Post('send')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async sendFlowToBuyer(@Request() req: any, @Body() body: SendFlowMessageDto) {
    const tenant = await this.tenantService.findByUser(req.user.id);
    if (!tenant.whatsappPhoneNumberId) {
      throw new BadRequestException('Complete WhatsApp onboarding before sending Flow messages.');
    }

    const result = await this.flowService.dispatchFlow({
      tenant,
      toPhone: body.toPhone,
      cta: body.flowCta || 'Browse & Order',
      bodyText: body.bodyText || `Tap below to browse products from *${tenant.name}* and place your order.`,
    });

    return { success: true, messageId: result.messageId };
  }
}
