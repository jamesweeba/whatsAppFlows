import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaystackService } from './paystack.service.js';

describe('PaystackService', () => {
  let service: PaystackService;

  beforeEach(() => {
    service = new PaystackService();
    vi.restoreAllMocks();
  });

  describe('mapProvider', () => {
    it('maps MTN properly', () => {
      expect(service.mapProvider('mtn')).toBe('mtn');
      expect(service.mapProvider('MTN MoMo')).toBe('mtn');
    });

    it('maps Telecel / Vodafone to vod', () => {
      expect(service.mapProvider('telecel')).toBe('vod');
      expect(service.mapProvider('vodafone')).toBe('vod');
    });

    it('maps AirtelTigo to tgo', () => {
      expect(service.mapProvider('airteltigo')).toBe('tgo');
      expect(service.mapProvider('tigo')).toBe('tgo');
    });
  });

  describe('normalizeGhanaPhone', () => {
    it('normalizes +233 prefix to 10-digit 0XXXXXXXXX', () => {
      expect(service.normalizeGhanaPhone('+233241234567')).toBe('0241234567');
    });

    it('normalizes 233 prefix to 10-digit 0XXXXXXXXX', () => {
      expect(service.normalizeGhanaPhone('233241234567')).toBe('0241234567');
    });

    it('adds leading 0 if 9 digits provided', () => {
      expect(service.normalizeGhanaPhone('241234567')).toBe('0241234567');
    });

    it('preserves valid 10-digit phone', () => {
      expect(service.normalizeGhanaPhone('0241234567')).toBe('0241234567');
    });
  });

  describe('initiateMoMoCharge', () => {
    it('simulates charge if PAYSTACK_SECRET_KEY is missing', async () => {
      delete process.env.PAYSTACK_SECRET_KEY;

      const result = await service.initiateMoMoCharge({
        amount: 25.5,
        momoNumber: '0241234567',
        provider: 'mtn',
        email: 'tenant@marketix.app',
        reference: 'MX-9001',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('pay_offline');
      expect(result.reference).toBe('MX-9001');
      expect(result.displayText).toContain('0241234567');
    });

    it('calls Paystack API with amount in pesewas and returns result', async () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_fake_key';

      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          status: true,
          message: 'Charge attempted',
          data: {
            status: 'pay_offline',
            reference: 'MX-9001',
            display_text: 'Please complete the authorization process',
          },
        }),
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

      const result = await service.initiateMoMoCharge({
        amount: 20.0,
        momoNumber: '+233241234567',
        provider: 'telecel',
        email: 'tenant@marketix.app',
        reference: 'MX-9001',
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.paystack.co/charge',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk_test_fake_key',
          }),
          body: JSON.stringify({
            amount: 2000,
            email: 'tenant@marketix.app',
            currency: 'GHS',
            reference: 'MX-9001',
            mobile_money: {
              phone: '0241234567',
              provider: 'vod',
            },
            metadata: {
              orderNumber: 'MX-9001',
              cleanPhone: '0241234567',
              provider: 'vod',
            },
          }),
        }),
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe('pay_offline');
    });

    it('treats send_otp as successful initiation for Ghana Mobile Money', async () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_fake_key';

      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          status: true,
          message: 'Charge attempted',
          data: {
            status: 'send_otp',
            reference: 'MX-9002',
            display_text: 'Please complete authorization',
          },
        }),
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

      const result = await service.initiateMoMoCharge({
        amount: 75.0,
        momoNumber: '0598402862',
        provider: 'mtn',
        email: 'tenant@marketix.app',
        reference: 'MX-9002',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('send_otp');
      expect(result.message).toBe('Charge initiated');
    });
  });

  describe('verifyWebhookSignature', () => {
    it('verifies valid HMAC SHA512 signature', () => {
      process.env.PAYSTACK_SECRET_KEY = 'test_secret';
      const body = JSON.stringify({ event: 'charge.success' });
      const crypto = require('crypto');
      const validSig = crypto.createHmac('sha512', 'test_secret').update(body).digest('hex');

      expect(service.verifyWebhookSignature(body, validSig)).toBe(true);
      expect(service.verifyWebhookSignature(body, 'invalid_sig')).toBe(false);
    });
  });
});
