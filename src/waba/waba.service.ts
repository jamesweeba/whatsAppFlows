import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';

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

@Injectable()
export class WabaService {
  private readonly logger = new Logger(WabaService.name);

  private get apiVersion(): string {
    return process.env.META_API_VERSION || 'v21.0';
  }

  private get wabaId(): string {
    return process.env.META_WABA_ID || '';
  }

  private get accessToken(): string {
    return process.env.META_SYSTEM_USER_TOKEN || '';
  }

  private get defaultPin(): string {
    return process.env.META_DEFAULT_2FA_PIN || '123456';
  }

  private get metaBaseUrl(): string {
    return process.env.META_BASE_URL || 'https://graph.facebook.com';
  }

  private get baseUrl(): string {
    return `${this.metaBaseUrl}/${this.apiVersion}`;
  }

  /**
   * Add a tenant phone number to WABA via Meta Graph API.
   * POST /{WABA_ID}/phone_numbers
   */
  async addPhoneNumberToWaba(
    options: AddPhoneNumberOptions,
  ): Promise<{ phoneNumberId: string }> {
    const url = `${this.baseUrl}/${this.wabaId}/phone_numbers`;

    const body = {
      cc: options.countryCode,
      phone_number: options.phoneNumber,
      verified_name: options.verifiedName,
    };

    const response = await this.makeMetaRequest<{ id: string }>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(body),
    });

    this.logger.debug(`addPhoneNumberToWaba response: ${JSON.stringify(response)}`);

    return { phoneNumberId: response.id };
  }

  /**
   * Request OTP verification code (SMS or VOICE) from Meta.
   * POST /{PHONE_NUMBER_ID}/request_code
   */
  async requestVerificationCode(
    options: RequestOtpOptions,
  ): Promise<{ success: boolean }> {
    const url = `${this.baseUrl}/${options.phoneNumberId}/request_code`;

    const body = {
      code_method: options.codeMethod,
      language: options.language || 'en',
    };

    const response = await this.makeMetaRequest<{ success: boolean }>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(body),
    });

    return { success: response.success ?? true };
  }

  /**
   * Verify the OTP code and register the number on WhatsApp Cloud API.
   * POST /{PHONE_NUMBER_ID}/register
   */
  async verifyCodeAndRegister(
    options: VerifyOtpOptions,
  ): Promise<{ success: boolean }> {
    const url = `${this.baseUrl}/${options.phoneNumberId}/register`;

    const body = {
      messaging_product: 'whatsapp',
      code: options.code,
      pin: options.pin || this.defaultPin,
    };

    const response = await this.makeMetaRequest<{ success: boolean }>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(body),
    });

    return { success: response.success ?? true };
  }

  /**
   * Send a text message to a buyer via Meta WhatsApp Cloud API.
   * POST /{PHONE_NUMBER_ID}/messages
   */
  async sendTextMessage(
    phoneNumberId: string,
    toPhone: string,
    text: string,
  ): Promise<{ messageId: string }> {
    const url = `${this.baseUrl}/${phoneNumberId}/messages`;
    const recipientPhone = toPhone.replace(/^\+/, '');

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'text',
      text: { body: text },
    };

    const response = await this.makeMetaRequest<{ messages: Array<{ id: string }> }>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(body),
    });

    return { messageId: response.messages?.[0]?.id || '' };
  }

  async sendWelcomeButtons(
    phoneNumberId: string,
    toPhone: string,
    storeName: string,
  ): Promise<{ messageId: string }> {
    const url = `${this.baseUrl}/${phoneNumberId}/messages`;
    const recipientPhone = toPhone.replace(/^\+/, '');

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: `Welcome to ${storeName}` },
        body: { text: 'Hi 👋 What would you like to do today?' },
        footer: { text: 'We reply within minutes' },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: { id: 'SHOP', title: '🛍️ Shop products' },
            },
            {
              type: 'reply',
              reply: { id: 'TRACK', title: '📦 Track my order' },
            },
            {
              type: 'reply',
              reply: { id: 'HUMAN', title: '💬 Talk to us' },
            },
          ],
        },
      },
    };

    const response = await this.makeMetaRequest<{ messages: Array<{ id: string }> }>(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(body),
      },
    );

    return { messageId: response.messages?.[0]?.id || '' };
  }

  /**
   * Send an interactive WhatsApp Flow message to a buyer via Meta Cloud API.
   * POST /{PHONE_NUMBER_ID}/messages
   */
  async sendFlowMessage(options: {
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
  }): Promise<{ messageId: string }> {
    const url = `${this.baseUrl}/${options.phoneNumberId}/messages`;
    const recipientPhone = options.toPhone.replace(/^\+/, '');

    const flowAction = options.flowAction || 'navigate';
    const actionParameters: Record<string, any> = {
      flow_message_version: '3',
      mode: process.env.META_FLOW_MODE || 'draft',
      flow_token: options.flowToken,
      flow_id: options.flowId,
      flow_cta: options.flowCta || 'View Products',
      flow_action: flowAction,
    };

    if (flowAction === 'navigate') {
      const payload: Record<string, any> = {
        screen: options.screen || 'WELCOME',
      };
      if (options.data && Object.keys(options.data).length > 0) {
        payload.data = options.data;
      }
      actionParameters.flow_action_payload = payload;
    }

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'interactive',
      interactive: {
        type: 'flow',
        header: {
          type: 'text',
          text: options.headerText || 'Interactive Shop',
        },
        body: {
          text: options.bodyText || 'Tap below to open our interactive catalog and order items directly!',
        },
        footer: {
          text: options.footerText || 'Powered by Omnipotent God',
        },
        action: {
          name: 'flow',
          parameters: actionParameters,
        },
      },
    };

    const response = await this.makeMetaRequest<{ messages: Array<{ id: string }> }>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(body),
    });

    return { messageId: response.messages?.[0]?.id || '' };
  }

  /**
   * Send a typing indicator / mark incoming message as read on WhatsApp via Meta Cloud API.
   * POST /{PHONE_NUMBER_ID}/messages
   */
  async sendTypingIndicator(
    phoneNumberId: string,
    messageId: string,
  ): Promise<{ success: boolean }> {
    const url = `${this.baseUrl}/${phoneNumberId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: {
        type: 'text',
      },
    };

    try {
      await this.makeMetaRequest<{ success: boolean }>(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(body),
      });
      return { success: true };
    } catch {
      try {
        // Fallback to standard mark-as-read status if typing_indicator is unsupported
        await this.makeMetaRequest<{ success: boolean }>(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.accessToken}`,
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: messageId,
          }),
        });
        return { success: true };
      } catch (err: any) {
        this.logger.warn(
          `Failed to dispatch typing indicator for message ${messageId}: ${err?.message || err}`,
        );
        return { success: false };
      }
    }
  }


  /**
   * Helper to execute fetch requests to Meta Graph API with error handling.
   */
  private async makeMetaRequest<T>(
    url: string,
    init: RequestInit,
  ): Promise<T> {
    try {
      const res = await fetch(url, init);
      const data = await res.json();

      if (!res.ok || data.error) {
        const errorMsg =
          data?.error?.message ||
          `Meta API request failed with status ${res.status}`;
        this.logger.error(`Meta API Error: ${JSON.stringify(data)}`);
        throw new BadRequestException(`Meta WABA Error: ${errorMsg}`);
      }

      return data as T;
    } catch (err: any) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      this.logger.error(`HTTP request to Meta failed: ${err.message}`, err.stack);
      throw new InternalServerErrorException(
        `Failed to communicate with Meta API: ${err.message}`,
      );
    }
  }
}
