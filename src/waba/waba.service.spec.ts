import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WabaService } from './waba.service.js';

describe('WabaService', () => {
  let service: WabaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WabaService],
    }).compile();

    service = module.get<WabaService>(WabaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('addPhoneNumberToWaba', () => {
    it('should call Meta Graph API to add a phone number and return the phoneNumberId', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: '1092837465' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await service.addPhoneNumberToWaba({
        countryCode: '233',
        phoneNumber: '241234567',
        verifiedName: 'Test Store',
      });

      expect(result).toEqual({ phoneNumberId: '1092837465' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('requestVerificationCode', () => {
    it('should call Meta Graph API to request an OTP code', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await service.requestVerificationCode({
        phoneNumberId: '1092837465',
        codeMethod: 'SMS',
      });

      expect(result).toEqual({ success: true });
    });
  });

  describe('verifyCodeAndRegister', () => {
    it('should submit OTP code and 2FA PIN to register number on Cloud API', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await service.verifyCodeAndRegister({
        phoneNumberId: '1092837465',
        code: '123456',
        pin: '654321',
      });

      expect(result).toEqual({ success: true });
    });
  });

  describe('sendWelcomeButtons', () => {
    it('sends the welcome interactive reply buttons using the store name', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [{ id: 'wamid-welcome' }] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await service.sendWelcomeButtons(
        '1092837465',
        '+233240000000',
        'SuperStore',
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(result).toEqual({ messageId: 'wamid-welcome' });
      expect(requestBody.to).toBe('233240000000');
      expect(requestBody.interactive).toEqual({
        type: 'button',
        header: { type: 'text', text: 'Welcome to SuperStore' },
        body: { text: 'Hi 👋 What would you like to do today?' },
        footer: { text: 'We reply within minutes' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'SHOP', title: '🛍️ Shop products' } },
            { type: 'reply', reply: { id: 'TRACK', title: '📦 Track my order' } },
            { type: 'reply', reply: { id: 'HUMAN', title: '💬 Talk to us' } },
          ],
        },
      });
    });
  });

  describe('sendFlowMessage', () => {
    it('sends Flow messages in draft mode (META_FLOW_MODE default)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [{ id: 'wamid.test' }] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await service.sendFlowMessage({
        phoneNumberId: '1092837465',
        toPhone: '233241234567',
        flowId: 'flow-123',
        flowToken: 'tenant-123:timestamp',
        flowCta: 'View Products',
        screen: 'PRODUCT_SELECT',
        data: {
          categories: [{ id: 'all', title: 'All Products' }],
          category_prefill: 'all',
          products: [{ id: 'prod-1', title: 'Tomatoes', description: '₵2.00 · Per KG' }],
          pre_selected: [],
          page_label: 'Page 1 of 1 · 1 products',
          selection_note: 'Your basket is empty',
          search_prefill: ' ',
          page_options: [{ id: '1', title: 'Page 1' }],
          page_prefill: '1',
          notice: ' ',
          show_notice: false,
        },
      });

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(result).toEqual({ messageId: 'wamid.test' });
      expect(requestBody.interactive.action.parameters.mode).toBe('draft');
      expect(requestBody.interactive.action.parameters.flow_message_version).toBe('3');
      expect(requestBody.interactive.action.parameters.flow_action_payload.data.products).toEqual([
        { id: 'prod-1', title: 'Tomatoes', description: '₵2.00 · Per KG' },
      ]);
    });
  });

  describe('sendRequestContactInfo', () => {
    it('sends Flow message to hidden-number buyer using recipient instead of to', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [{ id: 'wamid.hidden.test' }] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await service.sendRequestContactInfo({
        phoneNumberId: '1092837465',
        toPhone: 'GH.989894404158856',
        flowId: 'flow-hidden-123',
        flowToken: 'tenant-123:GH.989894404158856:12345678',
        flowCta: 'Browse & Order',
        screen: 'PRODUCT_SELECT',
        headerText: 'Hidden Store',
        bodyText: 'Welcome! Tap below to open catalog:',
        data: {
          products: [{ id: 'prod-1', title: 'Tomatoes', description: '₵2.00 · Per KG' }],
        },
      });

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(result).toEqual({ messageId: 'wamid.hidden.test' });
      // Crucial requirement: hidden numbers must use "recipient" and not "to"
      expect(requestBody.recipient).toBe('GH.989894404158856');
      expect(requestBody.to).toBeUndefined();
      expect(requestBody.recipient_type).toBe('individual');
      expect(requestBody.type).toBe('interactive');
      expect(requestBody.interactive.type).toBe('flow');
      expect(requestBody.interactive.header.text).toBe('Hidden Store');
      expect(requestBody.interactive.body.text).toBe('Welcome! Tap below to open catalog:');
      expect(requestBody.interactive.action.name).toBe('flow');
      expect(requestBody.interactive.action.parameters.flow_id).toBe('flow-hidden-123');
      expect(requestBody.interactive.action.parameters.flow_cta).toBe('Browse & Order');
      expect(requestBody.interactive.action.parameters.flow_action_payload.screen).toBe('PRODUCT_SELECT');
      expect(requestBody.interactive.action.parameters.flow_action_payload.data.products).toHaveLength(1);
    });
  });

  describe('sendTypingIndicator', () => {
    it('sends status read and typing indicator to Meta Graph API', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await service.sendTypingIndicator(
        '1092837465',
        'wamid.HBgLMjMz',
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(result).toEqual({ success: true });
      expect(requestBody).toEqual({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: 'wamid.HBgLMjMz',
        typing_indicator: {
          type: 'text',
        },
      });
    });
  });

  describe('formatRecipientPhone', () => {
    it('formats local Ghanaian numbers into international format without plus', () => {
      expect(service.formatRecipientPhone('0245655799')).toBe('233245655799');
      expect(service.formatRecipientPhone('+233245655799')).toBe('233245655799');
    });

    it('preserves WhatsApp BSUID intact', () => {
      expect(service.formatRecipientPhone('GH.989894404158856')).toBe('GH.989894404158856');
    });
  });
});
