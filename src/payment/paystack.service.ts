import { Injectable, Logger } from '@nestjs/common';
import { hmacHex, safeEqual } from '../common/crypto.util.js';
import { toGhanaLocal } from '../common/phone.util.js';

export interface InitiateMoMoChargeParams {
  amount: number; // in GHS (e.g. 25.50)
  momoNumber: string;
  provider: string; // 'mtn' | 'telecel' | 'airteltigo'
  email: string;
  reference: string;
  metadata?: Record<string, any>;
}

export interface PaystackChargeResult {
  success: boolean;
  status: 'pending' | 'pay_offline' | 'success' | 'failed' | 'send_otp' | 'send_pin';
  reference: string;
  message: string;
  displayText?: string;
  rawResponse?: any;
}

export interface CardPaymentResult {
  success: boolean;
  authorizationUrl?: string;
  message?: string;
}

/** Charge statuses Paystack returns once a Ghana mobile-money prompt has been dispatched. */
const INITIATED_STATUSES = new Set(['send_otp', 'pay_offline', 'pending', 'send_pin', 'success']);

export const DEFAULT_CUSTOMER_EMAIL = 'customer@orders.marketix.app';

@Injectable()
export class PaystackService {
  private readonly logger = new Logger(PaystackService.name);
  private readonly baseUrl = 'https://api.paystack.co';

  /**
   * Map provider strings from WhatsApp to Paystack provider codes:
   * MTN -> 'mtn', Telecel (Vodafone) -> 'vod', AirtelTigo -> 'tgo'
   */
  mapProvider(provider: string): 'mtn' | 'vod' | 'tgo' {
    const lower = (provider || '').toLowerCase().trim();
    if (lower.includes('telecel') || lower.includes('vod')) return 'vod';
    if (lower.includes('airtel') || lower.includes('tigo') || lower.includes('tgo')) return 'tgo';
    return 'mtn';
  }

  /** Normalise to the 10-digit local format Paystack Ghana Mobile Money expects. */
  normalizeGhanaPhone(raw: string): string {
    return toGhanaLocal(raw);
  }

  /**
   * Initiate a direct USSD Mobile Money push charge via the Paystack Charge API.
   * Prompts the buyer on their phone to enter their MoMo PIN.
   */
  async initiateMoMoCharge(params: InitiateMoMoChargeParams): Promise<PaystackChargeResult> {
    const failed = (message: string, rawResponse?: any): PaystackChargeResult => ({
      success: false,
      status: 'failed',
      reference: params.reference,
      message,
      rawResponse,
    });

    const keyError = this.secretKeyError();
    if (keyError) return failed(keyError);

    const cleanPhone = this.normalizeGhanaPhone(params.momoNumber);
    const providerCode = this.mapProvider(params.provider);

    const payload = {
      amount: this.toPesewas(params.amount),
      email: params.email || DEFAULT_CUSTOMER_EMAIL,
      currency: 'GHS',
      reference: params.reference,
      mobile_money: { phone: cleanPhone, provider: providerCode },
      metadata: {
        ...params.metadata,
        orderNumber: params.reference,
        cleanPhone,
        provider: providerCode,
      },
    };

    this.logger.log(`Initiating Paystack MoMo charge ${params.reference} (${providerCode}, ₵${params.amount.toFixed(2)})`);

    const { ok, data, error } = await this.post('/charge', payload);
    if (error) return failed(error);
    if (!ok || !data.status) {
      return failed(data.data?.message || data.message || 'Payment initiation failed', data);
    }

    const chargeStatus = data.data?.status || 'pending';
    const initiated = INITIATED_STATUSES.has(chargeStatus);
    this.logger.log(`Paystack charge ${params.reference} status: ${chargeStatus}`);

    return {
      success: initiated,
      status: initiated ? (chargeStatus as PaystackChargeResult['status']) : 'failed',
      reference: data.data?.reference || params.reference,
      message: initiated
        ? 'Charge initiated'
        : data.data?.gateway_response || data.message || 'Payment initiation failed',
      displayText: data.data?.display_text || 'Please complete authorization on your mobile phone.',
      rawResponse: data.data,
    };
  }

  /**
   * Initialise a standard Paystack transaction and return the hosted checkout URL for card payments.
   */
  async initializeCardPayment(params: {
    amount: number;
    email: string;
    reference: string;
    callbackUrl?: string;
  }): Promise<CardPaymentResult> {
    const keyError = this.secretKeyError();
    if (keyError) return { success: false, message: keyError };

    const { ok, data, error } = await this.post('/transaction/initialize', {
      amount: this.toPesewas(params.amount),
      email: params.email || DEFAULT_CUSTOMER_EMAIL,
      reference: params.reference,
      currency: 'GHS',
      callback_url: params.callbackUrl,
    });

    if (error) return { success: false, message: error };
    if (!ok || !data.status || !data.data?.authorization_url) {
      return { success: false, message: data.message || 'Payment initialization failed' };
    }
    return { success: true, authorizationUrl: data.data.authorization_url };
  }

  /**
   * Verify the HMAC SHA-512 webhook signature Paystack sends in `x-paystack-signature`.
   * Fails closed when the secret key is not configured.
   */
  verifyWebhookSignature(rawBody: string | Buffer, signature: string | undefined): boolean {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey) {
      this.logger.error('PAYSTACK_SECRET_KEY is not configured. Rejecting webhook.');
      return false;
    }
    if (!signature) return false;
    return safeEqual(hmacHex('sha512', secretKey, rawBody), signature);
  }

  private toPesewas(amount: number): number {
    return Math.round(amount * 100);
  }

  /** Returns a human-readable error when the secret key is missing or is a public key. */
  private secretKeyError(): string | null {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey) {
      this.logger.error('PAYSTACK_SECRET_KEY is not set. Payments cannot be initiated.');
      return 'Payment gateway is not configured.';
    }
    if (secretKey.startsWith('pk_')) {
      this.logger.error('PAYSTACK_SECRET_KEY is a public key (pk_...). The Charge API needs the secret key (sk_...).');
      return 'Payment gateway is misconfigured.';
    }
    return null;
  }

  private async post(path: string, payload: Record<string, any>): Promise<{ ok: boolean; data: any; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const data: any = await response.json();
      return { ok: response.ok, data };
    } catch (err: any) {
      this.logger.error(`Paystack request to ${path} failed: ${err?.message || err}`);
      return { ok: false, data: null, error: err?.message || 'Network error communicating with Paystack' };
    }
  }
}
