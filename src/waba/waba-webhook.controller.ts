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
  UseGuards,
} from '@nestjs/common';
import { MessageSender } from '@prisma/client';
import { MetaSignatureGuard } from '../auth/guards/meta-signature.guard.js';
import { ChatService } from '../chat/chat.service.js';
import { isBsuid, toE164 } from '../common/phone.util.js';
import { TenantService } from '../tenant/tenant.service.js';
import { WELCOME_BUTTON_IDS } from './waba.service.js';

interface IncomingContent {
  text: string;
  flowData?: Record<string, any>;
}

@Controller('api/v1/webhook')
export class WabaWebhookController {
  private readonly logger = new Logger(WabaWebhookController.name);

  constructor(
    private readonly tenantService: TenantService,
    private readonly chatService: ChatService,
  ) {}

  /**
   * GET /api/v1/webhook
   * Meta webhook verification challenge.
   */
  @Get()
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
    if (!verifyToken) {
      this.logger.error('META_WEBHOOK_VERIFY_TOKEN is not configured. Rejecting verification request.');
      throw new ForbiddenException('Webhook verification is not configured on this server');
    }

    if (mode === 'subscribe' && token === verifyToken) {
      this.logger.log('Meta webhook verified successfully.');
      return challenge;
    }

    this.logger.warn('Webhook verification failed: verify token mismatch.');
    throw new ForbiddenException('Invalid verify token');
  }

  /**
   * POST /api/v1/webhook
   * Receives WhatsApp events from the Meta Cloud API. The request is acknowledged
   * immediately; message handling (AI classification, replies) runs in the background
   * so Meta never times out and retries an already-received event.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(MetaSignatureGuard)
  handleIncomingWebhook(@Body() payload: any) {
    if (payload?.object !== 'whatsapp_business_account') {
      return { status: 'IGNORED' };
    }

    void this.processPayload(payload).catch((err) => {
      this.logger.error(`Unhandled error while processing webhook payload: ${err?.message || err}`);
    });

    return { status: 'EVENT_RECEIVED' };
  }

  /**
   * Walk the webhook payload and hand every buyer message to the chat service.
   * Public so it can be awaited directly in tests.
   */
  async processPayload(payload: any): Promise<void> {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value?.messages?.length) continue;

        const phoneNumberId: string | undefined = value.metadata?.phone_number_id;
        const tenant = phoneNumberId ? await this.tenantService.findByPhoneNumberId(phoneNumberId) : null;
        if (!tenant) {
          this.logger.warn(`Dropping webhook event: no tenant owns phone number id "${phoneNumberId}".`);
          continue;
        }

        await Promise.all(
          value.messages.map(async (message: any) => {
            try {
              const buyerPhone = this.extractBuyerPhone(message, value.contacts ?? []);
              if (!buyerPhone) {
                this.logger.warn(`Dropping message ${message.id}: no sender identifier.`);
                return;
              }
              const { text, flowData } = this.extractContent(message);
              await this.chatService.processIncomingMessage({
                tenantId: tenant.id,
                buyerPhone,
                text,
                flowData,
                sender: MessageSender.BUYER,
                incomingMessageId: message.id,
              });
            } catch (err: any) {
              this.logger.error(`Failed to process message ${message?.id}: ${err?.message || err}`);
            }
          }),
        );
      }
    }
  }

  /**
   * Resolve the buyer identifier for a message: a shared contact number, the
   * sender's phone number, or a business-scoped user id for hidden numbers.
   */
  private extractBuyerPhone(message: any, contacts: any[]): string {
    const contact =
      contacts.find(
        (c) =>
          (message.from && c.wa_id === message.from) ||
          (message.from_user_id && c.user_id === message.from_user_id),
      ) || contacts[0];

    const sharedContact =
      message.contact_request?.phone_number ||
      message.interactive?.contact_request?.phone_number ||
      (contact?.wa_id && contact.wa_id.length >= 9 ? contact.wa_id : '');
    if (sharedContact) {
      return toE164(sharedContact);
    }

    const senderId = String(message.recipient_id || message.from || contact?.wa_id || '').trim();
    if (senderId) {
      return isBsuid(senderId) ? senderId : toE164(senderId);
    }

    return String(
      message.recipient_user_id || message.from_user_id || message.user_id || contact?.user_id || '',
    ).trim();
  }

  /**
   * Turn a Cloud API message object into text and/or a Flow response payload.
   */
  private extractContent(message: any): IncomingContent {
    const sharedContactInfo =
      message.contact_request ||
      message.interactive?.contact_request ||
      message.interactive?.button_reply?.id === 'request_contact_info' ||
      message.type === 'contact_request';

    if (sharedContactInfo) {
      return { text: WELCOME_BUTTON_IDS.SHOP };
    }

    if (message.type === 'text' && message.text?.body) {
      return { text: message.text.body };
    }

    if (message.type === 'interactive') {
      const buttonReply = message.interactive?.button_reply;
      if (buttonReply) {
        return { text: buttonReply.id || buttonReply.title || '' };
      }
      const responseJson = message.interactive?.nfm_reply?.response_json;
      if (responseJson) {
        try {
          return { text: 'WhatsApp Flow Submitted', flowData: JSON.parse(responseJson) };
        } catch {
          this.logger.warn(`Could not parse Flow response for message ${message.id}`);
        }
      }
    }

    return { text: `[Media/Unsupported message type: ${message.type}]` };
  }
}
