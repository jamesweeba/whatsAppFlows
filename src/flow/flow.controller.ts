import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { FlowService } from './flow.service.js';
import { EncryptedFlowRequestDto, SendFlowMessageDto } from './dto/flow-request.dto.js';
import { WabaService } from '../waba/waba.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller(['api/v1/flow', 'webhook'])
export class FlowController {
  private readonly logger = new Logger(FlowController.name);

  constructor(
    private readonly flowService: FlowService,
    private readonly wabaService: WabaService,
    private readonly prisma: PrismaService,
  ) { }

  /**
   * POST /api/v1/flow
   * Synchronous Endpoint for Meta WhatsApp Flows Data Exchange.
   * Receives encrypted payload from Meta, returns encrypted base64 payload.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async handleFlowDataExchange(@Body() body: EncryptedFlowRequestDto): Promise<string> {
    this.logger.log('Incoming Meta WhatsApp Flow Data Exchange request.');
    return this.flowService.processEncryptedFlowRequest(body);
  }

  /**
   * POST /api/v1/flow/send
   * Triggers sending an interactive WhatsApp Flow message to a buyer's phone.
   */
  @Post('send')
  @HttpCode(HttpStatus.OK)
  async sendFlowToBuyer(@Body() body: SendFlowMessageDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: body.tenantId },
    });

    if (!tenant || !tenant.whatsappPhoneNumberId) {
      throw new NotFoundException(
        `Tenant with ID "${body.tenantId}" not found or does not have a registered WhatsApp phone number ID.`,
      );
    }

    const flowId = body.flowId || process.env.META_FLOW_ID;

    if (!flowId) {
      throw new NotFoundException(
        'Flow ID is required. Please pass "flowId" in request body or set META_FLOW_ID in environment variables.',
      );
    }

    const flowToken = `${tenant.id}:${body.toPhone}:${Date.now()}`;
    const screen = body.screen || process.env.META_FLOW_FIRST_SCREEN || 'PRODUCT_SELECT';
    const flowData = await this.flowService.buildFlowInitData(tenant.id, screen);

    const result = await this.wabaService.sendFlowMessage({
      phoneNumberId: tenant.whatsappPhoneNumberId,
      toPhone: body.toPhone,
      flowId,
      flowToken,
      flowCta: body.flowCta || 'Order Groceries',
      screen,
      data: flowData,
    });

    return {
      success: true,
      messageId: result.messageId,
      flowToken,
    };
  }
}
