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
    return process.env.META_API_VERSION || 'v25.0';
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
  /**
   * Format recipient phone number into E.164 international format without '+' or leading local '0'.
   * Meta WhatsApp Business API requires numbers in international format (e.g. 233245655799).
   * Local Ghana numbers like "0245655799" are converted to "233245655799".
   */
  formatRecipientPhone(phone: string): string {
    if (!phone) return '';
    const trimmed = phone.trim();

    // If it's a Meta WhatsApp BSUID (e.g. GH.989894404158856), retain it intact
    if (/^[A-Za-z]{2}\./.test(trimmed)) {
      return trimmed;
    }

    let clean = trimmed.replace(/[^\d+]/g, '');
    if (clean.startsWith('+')) {
      clean = clean.slice(1);
    }

    // If local Ghana number starting with 0 (e.g. 0245655799 -> 233245655799)
    if (clean.startsWith('0') && clean.length === 10) {
      clean = '233' + clean.slice(1);
    } else if (!clean.startsWith('0') && clean.length === 9) {
      clean = '233' + clean;
    }
    return clean;
  }

  async sendTextMessage(
    phoneNumberId: string,
    toPhone: string,
    text: string,
  ): Promise<{ messageId: string }> {
    const url = `${this.baseUrl}/${phoneNumberId}/messages`;
    const recipientPhone = this.formatRecipientPhone(toPhone);
    this.logger.log(`Dispatching text message to WhatsApp recipient: "${recipientPhone}"`);

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
    const recipientPhone = this.formatRecipientPhone(toPhone);
    this.logger.log(`Dispatching welcome buttons to WhatsApp recipient: "${recipientPhone}"`);

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
   * Send an interactive button message (up to 3 buttons) to a buyer.
   */
  async sendInteractiveButtons(options: {
    phoneNumberId: string;
    toPhone: string;
    bodyText: string;
    buttons: Array<{ id: string; title: string }>;
    headerText?: string;
    footerText?: string;
  }): Promise<{ messageId: string }> {
    const url = `${this.baseUrl}/${options.phoneNumberId}/messages`;
    const recipientPhone = this.formatRecipientPhone(options.toPhone);
    this.logger.log(`Dispatching interactive buttons to WhatsApp recipient: "${recipientPhone}"`);

    const interactivePayload: Record<string, any> = {
      type: 'button',
      body: { text: options.bodyText },
      action: {
        buttons: options.buttons.slice(0, 3).map((btn) => ({
          type: 'reply',
          reply: {
            id: btn.id,
            title: btn.title.slice(0, 20),
          },
        })),
      },
    };

    if (options.headerText) {
      interactivePayload.header = { type: 'text', text: options.headerText };
    }
    if (options.footerText) {
      interactivePayload.footer = { text: options.footerText };
    }

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'interactive',
      interactive: interactivePayload,
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
   * Send an interactive list message (sections and rows) to a buyer.
   */
  async sendInteractiveList(options: {
    phoneNumberId: string;
    toPhone: string;
    bodyText: string;
    buttonText: string;
    sections: Array<{
      title: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>;
    headerText?: string;
    footerText?: string;
  }): Promise<{ messageId: string }> {
    const url = `${this.baseUrl}/${options.phoneNumberId}/messages`;
    const recipientPhone = this.formatRecipientPhone(options.toPhone);
    this.logger.log(`Dispatching interactive list to WhatsApp recipient: "${recipientPhone}"`);

    const interactivePayload: Record<string, any> = {
      type: 'list',
      body: { text: options.bodyText },
      action: {
        button: options.buttonText.slice(0, 20),
        sections: options.sections.map((section) => ({
          title: section.title.slice(0, 24),
          rows: section.rows.slice(0, 10).map((row) => ({
            id: row.id,
            title: row.title.slice(0, 24),
            description: row.description ? row.description.slice(0, 72) : undefined,
          })),
        })),
      },
    };

    if (options.headerText) {
      interactivePayload.header = { type: 'text', text: options.headerText };
    }
    if (options.footerText) {
      interactivePayload.footer = { text: options.footerText };
    }

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'interactive',
      interactive: interactivePayload,
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
   * Send an interactive CTA URL button (e.g. for Paystack card checkout) to a buyer.
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
    const requestUrl = `${this.baseUrl}/${options.phoneNumberId}/messages`;
    const recipientPhone = this.formatRecipientPhone(options.toPhone);
    this.logger.log(`Dispatching CTA URL button to WhatsApp recipient: "${recipientPhone}"`);

    const interactivePayload: Record<string, any> = {
      type: 'cta_url',
      body: { text: options.bodyText },
      action: {
        name: 'cta_url',
        parameters: {
          display_text: options.displayText.slice(0, 20),
          url: options.url,
        },
      },
    };

    if (options.headerText) {
      interactivePayload.header = { type: 'text', text: options.headerText };
    }
    if (options.footerText) {
      interactivePayload.footer = { text: options.footerText };
    }

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'interactive',
      interactive: interactivePayload,
    };

    try {
      const response = await this.makeMetaRequest<{ messages: Array<{ id: string }> }>(requestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(body),
      });
      return { messageId: response.messages?.[0]?.id || '' };
    } catch {
      return this.sendTextMessage(
        options.phoneNumberId,
        options.toPhone,
        `${options.bodyText}\n\n👉 Pay securely: ${options.url}`,
      );
    }
  }

  /**
   * Send an interactive WhatsApp Flow message to a hidden-number / BSUID buyer via Meta Cloud API.
   * Keeps logic separate from sendFlowMessage and uses "recipient" instead of "to" in Meta payload.
   * POST /{PHONE_NUMBER_ID}/messages
   */
  async sendRequestContactInfo(options: {
    phoneNumberId: string;
    toPhone: string;
    flowId?: string;
    flowToken?: string;
    flowCta?: string;
    screen?: string;
    headerText?: string;
    bodyText?: string;
    footerText?: string;
    data?: Record<string, any>;
    flowAction?: 'navigate' | 'data_exchange';
  }): Promise<{ messageId: string }> {
    const url = `${this.baseUrl}/${options.phoneNumberId}/messages`;
    const recipientPhone = this.formatRecipientPhone(options.toPhone);
    this.logger.log(`Dispatching flow to hidden-number WhatsApp recipient (BSUID): "${recipientPhone}"`);

    const flowAction = options.flowAction || 'navigate';
    const flowId = options.flowId || process.env.META_FLOW_ID || '';
    const actionParameters: Record<string, any> = {
      flow_message_version: '3',
      mode: process.env.META_FLOW_MODE || 'draft',
      flow_token: options.flowToken || `${options.toPhone}:${Date.now()}`,
      flow_id: flowId,
      flow_cta: options.flowCta || 'View Products',
      flow_action: flowAction,
    };

    if (flowAction === 'navigate') {
      const payload: Record<string, any> = {
        screen: options.screen || process.env.META_FLOW_FIRST_SCREEN || 'PRODUCT_SELECT',
      };
      if (options.data && Object.keys(options.data).length > 0) {
        payload.data = options.data;
      }
      actionParameters.flow_action_payload = payload;
    }

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      recipient: recipientPhone,
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
    const recipientPhone = this.formatRecipientPhone(options.toPhone);

    this.logger.log(`Dispatching flow message to WhatsApp recipient: "${recipientPhone}"`);

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


    console.log(body);
    console.log("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")

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
