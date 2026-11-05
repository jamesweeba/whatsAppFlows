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
import { MessageSender, Tenant, TenantStatus } from '@prisma/client';
import { MetaSignatureGuard } from '../auth/guards/meta-signature.guard.js';
import { ChatService } from '../chat/chat.service.js';
import { FlowService } from '../flow/flow.service.js';
import { isBsuid, toE164 } from '../common/phone.util.js';
import { isLive, TenantService } from '../tenant/tenant.service.js';
import { WabaService, WELCOME_BUTTON_IDS } from './waba.service.js';

interface IncomingContent {
  text: string;
  flowData?: Record<string, any>;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
}

@Controller('api/v1/webhook')
export class WabaWebhookController {
  private readonly logger = new Logger(WabaWebhookController.name);

  constructor(
    private readonly tenantService: TenantService,
    private readonly chatService: ChatService,
    private readonly wabaService: WabaService,
    private readonly flowService: FlowService,
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
        this.logFailedStatuses(value?.statuses);
        if (!value?.messages?.length) continue;

        const phoneNumberId: string | undefined = value.metadata?.phone_number_id;
        const tenant = phoneNumberId ? await this.tenantService.findByPhoneNumberId(phoneNumberId) : null;
        if (!tenant || !isLive(tenant)) {
          await this.replyShopUnavailable(phoneNumberId, tenant, value);
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
              const { text, flowData, location } = this.extractContent(message);
              await this.chatService.processIncomingMessage({
                tenantId: tenant.id,
                buyerPhone,
                text,
                flowData,
                location,
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
   * Meta accepts a send and reports delivery later as a status. A message the buyer's
   * WhatsApp cannot show (e.g. a location request on WhatsApp Web or an old app) only
   * surfaces here, so failures are logged with Meta's reason, and a failed location
   * request is retried as plain text.
   */
  private logFailedStatuses(statuses: any[] | undefined) {
    for (const status of statuses ?? []) {
      if (status?.status !== 'failed') continue;
      const reasons = (status.errors ?? [])
        .map((e: any) => `${e.code} ${e.title}${e.error_data?.details ? ` (${e.error_data.details})` : ''}`)
        .join('; ');
      const to = status.recipient_id || status.recipient_user_id || 'unknown recipient';
      this.logger.warn(`WhatsApp could not deliver message ${status.id} to ${to}: ${reasons || 'no reason given'}`);
      void this.flowService
        .handleFailedDelivery(status.id)
        .catch((err) => this.logger.warn(`Fallback after failed delivery of ${status.id} failed: ${err?.message || err}`));
    }
  }

  /**
   * Only ACTIVE shops reach the chat logic. A suspended shop, one not yet approved, or a
   * pool number no shop has yet gets a one-line reply; any other number is dropped.
   */
  private async replyShopUnavailable(phoneNumberId: string | undefined, tenant: Tenant | null, value: any) {
    if (!phoneNumberId) {
      this.logger.warn('Dropping webhook event: no phone number id.');
      return;
    }
    if (!tenant && !(await this.tenantService.findPoolNumber(phoneNumberId))) {
      this.logger.warn(`Dropping webhook event: no tenant owns phone number id "${phoneNumberId}".`);
      return;
    }

    const text =
      tenant?.status === TenantStatus.SUSPENDED
        ? `Sorry, ${tenant.name} is temporarily closed. Please check back later.`
        : "This shop isn't open on MarketiX yet. Please check back soon.";
    this.logger.log(`Shop on ${phoneNumberId} is ${tenant?.status ?? 'unassigned'}; replying that it is unavailable.`);

    for (const message of value.messages) {
      const buyerPhone = this.extractBuyerPhone(message, value.contacts ?? []);
      if (!buyerPhone) continue;
      await this.wabaService
        .sendTextMessage(phoneNumberId, buyerPhone, text)
        .catch((err) => this.logger.warn(`Unavailable-shop reply to ${buyerPhone} failed: ${err?.message || err}`));
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

    if (message.type === 'location' && message.location) {
      const { latitude, longitude, name, address } = message.location;
      if (Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))) {
        return {
          text: `📍 Location shared${name || address ? `: ${[name, address].filter(Boolean).join(', ')}` : ''} (${latitude}, ${longitude})`,
          location: {
            latitude: Number(latitude),
            longitude: Number(longitude),
            ...(name ? { name: String(name) } : {}),
            ...(address ? { address: String(address) } : {}),
          },
        };
      }
    }

    if (message.type === 'text' && message.text?.body) {
      return { text: message.text.body };
    }

    if (message.type === 'interactive') {
      const buttonReply = message.interactive?.button_reply ?? message.interactive?.list_reply;
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
