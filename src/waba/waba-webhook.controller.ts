import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { MessageSender } from '@prisma/client';
import { ChatService } from '../chat/chat.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('api/v1/webhook')
export class WabaWebhookController {
  private readonly logger = new Logger(WabaWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chatService: ChatService,
  ) { }

  /**
   * GET /api/v1/webhook
   * Meta Webhook Verification Challenge handler.
   */
  @Get()
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
    if (!verifyToken) {
      this.logger.error('META_WEBHOOK_VERIFY_TOKEN is not configured. Rejecting all verification requests.');
      throw new ForbiddenException('Webhook verification is not configured on this server');
    }

    if (mode === 'subscribe' && token === verifyToken) {
      this.logger.log('Meta Webhook verified successfully!');
      return challenge;
    }

    this.logger.warn(
      `Webhook verification failed. Token mismatch: expected "${verifyToken}", got "${token}"`,
    );
    throw new ForbiddenException('Invalid verify token');
  }

  /**
   * POST /api/v1/webhook
   * Handles incoming WhatsApp events and buyer messages from Meta Cloud API.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async handleIncomingWebhook(@Body() payload: any) {
    // this.logger.log(`Received Webhook Payload: ${JSON.stringify(payload)}`);

    if (payload?.object !== 'whatsapp_business_account') {
      return { status: 'IGNORED' };
    }




    const entries = payload.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value;
        if (!value || !value.messages) continue;

        const phoneNumberId = value.metadata?.phone_number_id;

        // Find tenant by matching whatsappPhoneNumberId or fallback to first tenant
        let tenant = phoneNumberId
          ? await this.prisma.tenant.findFirst({
            where: { whatsappPhoneNumberId: phoneNumberId },
          })
          : null;

        if (!tenant) {
          tenant = await this.prisma.tenant.findFirst();
          if (tenant) {
            this.logger.warn(
              `No tenant found matching WhatsApp Phone Number ID: ${phoneNumberId}. Falling back to tenant: ${tenant.name} (${tenant.id})`,
            );
          }
        }

        if (!tenant) {
          this.logger.warn(
            `No tenant found in database to process incoming WhatsApp message for Phone Number ID: ${phoneNumberId}`,
          );
          continue;
        }

        // Process all incoming messages in parallel for throughput
        await Promise.all(
          value.messages.map(async (message: any) => {
            const rawPhone = message.from || '';
            const buyerPhone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;

            let messageText = '';
            let flowData: Record<string, any> | undefined;

            if (message.type === 'text' && message.text?.body) {
              messageText = message.text.body;
            } else if (message.type === 'interactive') {
              if (message.interactive?.button_reply) {
                messageText =
                  message.interactive.button_reply.id ||
                  message.interactive.button_reply.title;
              } else if (message.interactive?.nfm_reply?.response_json) {
                try {
                  flowData = JSON.parse(message.interactive.nfm_reply.response_json);
                  messageText = 'WhatsApp Flow Submitted';
                } catch { }
              }
            }

            if (!messageText && !flowData) {
              messageText = `[Media/Unsupported message type: ${message.type}]`;
            }

            // Process incoming message: intent classification + auto response + WhatsApp dispatch
            await this.chatService.processIncomingMessage({
              tenantId: tenant.id,
              buyerPhone,
              text: messageText,
              flowData,
              sender: MessageSender.BUYER,
              incomingMessageId: message.id,
            });
          }),);
      }
    }

    return { status: 'EVENT_RECEIVED' };
  }
}
