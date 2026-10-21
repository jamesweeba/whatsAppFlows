import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

export interface InitiateMoMoChargeParams {
  amount: number; // in GHS (e.g. 25.50)
  momoNumber: string;
  provider: string; // 'mtn' | 'telecel' | 'airteltigo'
  email: string; // Tenant user email
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

@Injectable()
export class PaystackService {
  private readonly logger = new Logger(PaystackService.name);
  private readonly baseUrl = 'https://api.paystack.co';

  /**
   * Map provider strings from WhatsApp Flow to Paystack provider codes:
   * MTN -> 'mtn'
   * Telecel (Vodafone) -> 'vod'
   * AirtelTigo -> 'tgo'
   */
  mapProvider(provider: string): 'mtn' | 'vod' | 'tgo' {
    const lower = (provider || '').toLowerCase().trim();
    if (lower.includes('telecel') || lower.includes('vod')) {
      return 'vod';
    }
    if (lower.includes('airtel') || lower.includes('tigo') || lower.includes('tgo')) {
      return 'tgo';
    }
    return 'mtn';
  }

  /**
   * Normalize Ghanaian phone number to 10-digit local format (e.g. 0244123456)
   * which Paystack Ghana Mobile Money expects.
   */
  normalizeGhanaPhone(raw: string): string {
    let clean = (raw || '').replace(/[^\d+]/g, '');
    if (clean.startsWith('+233')) {
      clean = '0' + clean.slice(4);
    } else if (clean.startsWith('233') && clean.length === 12) {
      clean = '0' + clean.slice(3);
    } else if (!clean.startsWith('0') && clean.length === 9) {
      clean = '0' + clean;
    }
    return clean;
  }

  /**
   * Initiate a direct USSD Mobile Money push charge via Paystack Charge API.
   * Prompts the buyer directly on their mobile phone to input their MoMo PIN.
   */
  async initiateMoMoCharge(params: InitiateMoMoChargeParams): Promise<PaystackChargeResult> {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    const cleanPhone = this.normalizeGhanaPhone(params.momoNumber);
    const providerCode = this.mapProvider(params.provider);
    const amountInPesewas = Math.round(params.amount * 100);

    // If PAYSTACK_SECRET_KEY is not configured, simulate successful charge initiation
    if (!secretKey) {
      this.logger.warn(
        `PAYSTACK_SECRET_KEY is not set. Simulating MoMo charge prompt for ${cleanPhone} (${providerCode}) - ₵${params.amount.toFixed(2)}.`,
      );
      return {
        success: true,
        status: 'pay_offline',
        reference: params.reference,
        message: 'Prompt simulated (set PAYSTACK_SECRET_KEY in .env for live integration)',
        displayText: `Please authorize the prompt on ${cleanPhone}`,
      };
    }

    if (secretKey.startsWith('pk_')) {
      this.logger.error(
        `PAYSTACK_SECRET_KEY is set to a Public Key (${secretKey.slice(0, 8)}...). The Paystack Charge API requires the Secret Key starting with "sk_test_" or "sk_live_".`,
      );
      return {
        success: false,
        status: 'failed',
        reference: params.reference,
        message: 'A Public Key (pk_...) was used instead of the Secret Key (sk_...). Please update PAYSTACK_SECRET_KEY in .env to your Secret Key.',
      };
    }

    const payload = {
      amount: amountInPesewas,
      email: params.email || 'customer@orders.marketix.app',
      currency: 'GHS',
      reference: params.reference,
      mobile_money: {
        phone: cleanPhone,
        provider: providerCode,
      },
      metadata: {
        ...params.metadata,
        orderNumber: params.reference,
        cleanPhone,
        provider: providerCode,
      },
    };

    try {
      this.logger.log(
        `Sending Paystack MoMo charge for reference ${params.reference} (${cleanPhone}, ${providerCode}, ₵${params.amount.toFixed(2)}) using tenant email: ${params.email}`,
      );

      const response = await fetch(`${this.baseUrl}/charge`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data: any = await response.json();
      this.logger.log(`Paystack Charge response: ${JSON.stringify(data)}`);

      if (!response.ok || !data.status) {
        return {
          success: false,
          status: 'failed',
          reference: params.reference,
          message: data.data?.message || data.message || 'Payment initiation failed',
          rawResponse: data,
        };
      }

      const chargeStatus = data.data?.status || 'pending';
      const displayText = data.data?.display_text || 'Please complete authorization on your mobile phone.';

      // Paystack Mobile Money in Ghana returns 'send_otp', 'pay_offline', 'pending', or 'send_pin' upon prompt dispatch
      const isSuccess =
        chargeStatus === 'send_otp' ||
        chargeStatus === 'pay_offline' ||
        chargeStatus === 'pending' ||
        chargeStatus === 'send_pin' ||
        chargeStatus === 'success';

      return {
        success: isSuccess,
        status: isSuccess ? (chargeStatus as any) : 'failed',
        reference: data.data?.reference || params.reference,
        message: isSuccess ? 'Charge initiated' : (data.data?.gateway_response || data.message || 'Payment initiation failed'),
        displayText,
        rawResponse: data.data,
      };
    } catch (error: any) {
      this.logger.error(`Error calling Paystack charge endpoint: ${error.message || error}`);
      return {
        success: false,
        status: 'failed',
        reference: params.reference,
        message: error.message || 'Network error communicating with Paystack',
      };
    }
  }

  /**
   * Initialize a standard Paystack transaction to get an authorization/checkout URL for card payments.
   */
  async initializeCardPayment(params: {
    amount: number;
    email: string;
    reference: string;
    callbackUrl?: string;
  }): Promise<{ success: boolean; authorizationUrl?: string; message?: string }> {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    const amountInPesewas = Math.round(params.amount * 100);

    if (!secretKey || secretKey.startsWith('pk_')) {
      return {
        success: true,
        authorizationUrl: `https://checkout.paystack.com/${params.reference}`,
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/transaction/initialize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: amountInPesewas,
          email: params.email || 'customer@orders.marketix.app',
          reference: params.reference,
          currency: 'GHS',
          callback_url: params.callbackUrl,
        }),
      });

      const data: any = await response.json();
      if (!response.ok || !data.status) {
        return {
          success: false,
          message: data.message || 'Payment initialization failed',
        };
      }

      return {
        success: true,
        authorizationUrl: data.data?.authorization_url,
      };
    } catch (err: any) {
      return {
        success: false,
        message: err.message || 'Error initializing card payment',
      };
    }
  }

  /**
   * Verify HMAC SHA-512 webhook signature from Paystack (x-paystack-signature header).
   */
  verifyWebhookSignature(rawBody: string | Buffer, signature: string): boolean {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey) {
      this.logger.warn('PAYSTACK_SECRET_KEY is not configured. Webhook signature verification bypassed.');
      return true;
    }

    if (!signature) {
      return false;
    }

    try {
      const hash = crypto
        .createHmac('sha512', secretKey)
        .update(rawBody)
        .digest('hex');

      return hash === signature;
    } catch (e: any) {
      this.logger.error(`Signature verification failed: ${e?.message || e}`);
      return false;
    }
  }
}
