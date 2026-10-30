import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { isBsuid, toInternationalDigits } from '../common/phone.util.js';

export interface AddPhoneNumberOptions {
  countryCode: string;
  phoneNumber: string;
  verifiedName: string;
}

export interface RequestOtpOptions {
  phoneNumberId: string;
  codeMethod: 'SMS' | 'VOICE';
  language?: string;
}

export interface VerifyOtpOptions {
  phoneNumberId: string;
  code: string;
  pin?: string;
}

export interface ReplyButton {
  id: string;
  title: string;
}

export interface FlowMessageOptions {
  phoneNumberId: string;
  toPhone: string;
  flowId: string;
  flowToken: string;
  flowCta: string;
  screen: string;
  headerText?: string;
  bodyText?: string;
  footerText?: string;
  data?: Record<string, any>;
  flowAction?: 'navigate' | 'data_exchange';
}

/** Reply-button ids used by the welcome message; the chat layer maps them to intents. */
export const WELCOME_BUTTON_IDS = {
  SHOP: 'SHOP',
  TRACK: 'TRACK',
  HUMAN: 'HUMAN',
} as const;

export const WELCOME_BODY_TEXT = 'Hi 👋 What would you like to do today?';

/** WhatsApp caps interactive reply-button titles and CTA labels at 20 characters. */
const BUTTON_TITLE_MAX = 20;
const REPLY_BUTTON_LIMIT = 3;

type MessagesResponse = { messages?: Array<{ id: string }> };

@Injectable()
export class WabaService {
  private readonly logger = new Logger(WabaService.name);

  private get baseUrl(): string {
    const host = process.env.META_BASE_URL || 'https://graph.facebook.com';
    const version = process.env.META_API_VERSION || 'v25.0';
    return `${host}/${version}`;
  }

  private get accessToken(): string {
    return process.env.META_SYSTEM_USER_TOKEN || '';
  }

  // ───────────────────────── Onboarding (WABA registration) ─────────────────────────

  /**
   * Add a tenant phone number to the WABA. POST /{WABA_ID}/phone_numbers
   */
  async addPhoneNumberToWaba(options: AddPhoneNumberOptions): Promise<{ phoneNumberId: string }> {
    const wabaId = process.env.META_WABA_ID || '';
    const response = await this.post<{ id: string }>(`${this.baseUrl}/${wabaId}/phone_numbers`, {
      cc: options.countryCode,
      phone_number: options.phoneNumber,
      verified_name: options.verifiedName,
    });
    return { phoneNumberId: response.id };
  }

  /**
   * Request an OTP verification code (SMS or VOICE). POST /{PHONE_NUMBER_ID}/request_code
   */
  async requestVerificationCode(options: RequestOtpOptions): Promise<{ success: boolean }> {
    const response = await this.post<{ success: boolean }>(
      `${this.baseUrl}/${options.phoneNumberId}/request_code`,
      { code_method: options.codeMethod, language: options.language || 'en' },
    );
    return { success: response.success ?? true };
  }

  /**
   * Verify the OTP code and register the number on the Cloud API. POST /{PHONE_NUMBER_ID}/register
   */
  async verifyCodeAndRegister(options: VerifyOtpOptions): Promise<{ success: boolean }> {
    const response = await this.post<{ success: boolean }>(
      `${this.baseUrl}/${options.phoneNumberId}/register`,
      {
        messaging_product: 'whatsapp',
        code: options.code,
        pin: options.pin || process.env.META_DEFAULT_2FA_PIN || '123456',
      },
    );
    return { success: response.success ?? true };
  }

  // ───────────────────────── Outbound messages ─────────────────────────

  /**
   * Format a recipient for the Cloud API: international digits without `+`.
   * Business-scoped user ids (hidden numbers) are passed through unchanged.
   */
  formatRecipientPhone(phone: string): string {
    return toInternationalDigits(phone);
  }

  async sendTextMessage(phoneNumberId: string, toPhone: string, text: string): Promise<{ messageId: string }> {
    return this.sendMessage(phoneNumberId, toPhone, { type: 'text', text: { body: text } });
  }

  /**
   * Send an interactive reply-button message (up to three buttons).
   */
  async sendInteractiveButtons(options: {
    phoneNumberId: string;
    toPhone: string;
    bodyText: string;
    buttons: ReplyButton[];
    headerText?: string;
    footerText?: string;
  }): Promise<{ messageId: string }> {
    const interactive: Record<string, any> = {
      type: 'button',
      body: { text: options.bodyText },
      action: {
        buttons: options.buttons.slice(0, REPLY_BUTTON_LIMIT).map((btn) => ({
          type: 'reply',
          reply: { id: btn.id, title: btn.title.slice(0, BUTTON_TITLE_MAX) },
        })),
      },
    };
    this.applyHeaderFooter(interactive, options.headerText, options.footerText);

    return this.sendMessage(options.phoneNumberId, options.toPhone, { type: 'interactive', interactive });
  }

  /**
   * Welcome message with the three standard quick actions.
   */
  sendWelcomeButtons(phoneNumberId: string, toPhone: string, storeName: string): Promise<{ messageId: string }> {
    return this.sendInteractiveButtons({
      phoneNumberId,
      toPhone,
      headerText: `Welcome to ${storeName}`,
      bodyText: WELCOME_BODY_TEXT,
      footerText: 'We reply within minutes',
      buttons: [
        { id: WELCOME_BUTTON_IDS.SHOP, title: '🛍️ Shop products' },
        { id: WELCOME_BUTTON_IDS.TRACK, title: '📦 Track my order' },
        { id: WELCOME_BUTTON_IDS.HUMAN, title: '💬 Talk to us' },
      ],
    });
  }

  /**
   * Send a call-to-action URL button (e.g. a Paystack checkout link).
   * Falls back to a plain text message with the link if the interactive type is rejected.
   */
  async sendInteractiveCtaUrl(options: {
    phoneNumberId: string;
    toPhone: string;
    bodyText: string;
    displayText: string;
    url: string;
    headerText?: string;
    footerText?: string;
  }): Promise<{ messageId: string }> {
    const interactive: Record<string, any> = {
      type: 'cta_url',
      body: { text: options.bodyText },
      action: {
        name: 'cta_url',
        parameters: { display_text: options.displayText.slice(0, BUTTON_TITLE_MAX), url: options.url },
      },
    };
    this.applyHeaderFooter(interactive, options.headerText, options.footerText);

    try {
      return await this.sendMessage(options.phoneNumberId, options.toPhone, { type: 'interactive', interactive });
    } catch {
      return this.sendTextMessage(
        options.phoneNumberId,
        options.toPhone,
        `${options.bodyText}\n\n👉 Pay securely: ${options.url}`,
      );
    }
  }

  /**
   * Send an interactive WhatsApp Flow message.
   * Hidden-number buyers (BSUIDs) are addressed with `recipient` instead of `to`.
   */
  async sendFlowMessage(options: FlowMessageOptions): Promise<{ messageId: string }> {
    const flowAction = options.flowAction || 'navigate';
    const parameters: Record<string, any> = {
      flow_message_version: '3',
      mode: process.env.META_FLOW_MODE || 'draft',
      flow_token: options.flowToken,
      flow_id: options.flowId,
      flow_cta: (options.flowCta || 'View Products').slice(0, BUTTON_TITLE_MAX),
      flow_action: flowAction,
    };

    if (flowAction === 'navigate') {
      const payload: Record<string, any> = { screen: options.screen || 'PRODUCT_SELECT' };
      if (options.data && Object.keys(options.data).length > 0) {
        payload.data = options.data;
      }
      parameters.flow_action_payload = payload;
    }

    const interactive: Record<string, any> = {
      type: 'flow',
      header: { type: 'text', text: options.headerText || 'Interactive Shop' },
      body: { text: options.bodyText || 'Tap below to open our catalog and order directly.' },
      action: { name: 'flow', parameters },
    };
    if (options.footerText) {
      interactive.footer = { text: options.footerText };
    }

    return this.sendMessage(options.phoneNumberId, options.toPhone, { type: 'interactive', interactive });
  }

  /**
   * Mark an incoming message as read and show a typing indicator.
   * Falls back to a plain read receipt if typing indicators are unsupported.
   */
  async sendTypingIndicator(phoneNumberId: string, messageId: string): Promise<{ success: boolean }> {
    const url = this.messagesUrl(phoneNumberId);
    const base = { messaging_product: 'whatsapp', status: 'read', message_id: messageId };
    try {
      await this.post(url, { ...base, typing_indicator: { type: 'text' } });
      return { success: true };
    } catch {
      try {
        await this.post(url, base);
        return { success: true };
      } catch (err: any) {
        this.logger.warn(`Failed to send read receipt for ${messageId}: ${err?.message || err}`);
        return { success: false };
      }
    }
  }

  // ───────────────────────── Internals ─────────────────────────

  private messagesUrl(phoneNumberId: string): string {
    return `${this.baseUrl}/${phoneNumberId}/messages`;
  }

  private applyHeaderFooter(interactive: Record<string, any>, headerText?: string, footerText?: string) {
    if (headerText) interactive.header = { type: 'text', text: headerText };
    if (footerText) interactive.footer = { text: footerText };
  }

  /**
   * Common envelope for every outbound message: resolves the recipient, picks the
   * `to` / `recipient` field, posts to the Cloud API and returns the message id.
   */
  private async sendMessage(
    phoneNumberId: string,
    toPhone: string,
    message: Record<string, any>,
  ): Promise<{ messageId: string }> {
    const recipient = this.formatRecipientPhone(toPhone);
    this.logger.log(`Sending ${message.type} message to "${recipient}"`);

    const addressAsRecipient = isBsuid(recipient) && message.interactive?.type === 'flow';
    const body: Record<string, any> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      ...(addressAsRecipient ? { recipient } : { to: recipient }),
      ...message,
    };

    const response = await this.post<MessagesResponse>(this.messagesUrl(phoneNumberId), body);
    return { messageId: response.messages?.[0]?.id || '' };
  }

  /**
   * Authenticated JSON POST to the Graph API with uniform error handling.
   */
  private async post<T>(url: string, body: Record<string, any>): Promise<T> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        const message = data?.error?.message || `Meta API request failed with status ${res.status}`;
        this.logger.error(`Meta API error: ${JSON.stringify(data?.error ?? data)}`);
        throw new BadRequestException(`Meta WABA Error: ${message}`);
      }
      return data as T;
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(`HTTP request to Meta failed: ${err.message}`);
      throw new InternalServerErrorException(`Failed to communicate with Meta API: ${err.message}`);
    }
  }
}
