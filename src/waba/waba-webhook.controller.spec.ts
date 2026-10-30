import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from '../chat/chat.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { WabaWebhookController } from './waba-webhook.controller.js';

describe('WabaWebhookController', () => {
  let controller: WabaWebhookController;
  let chatService: { processIncomingMessage: ReturnType<typeof vi.fn> };
  let tenantService: { findByPhoneNumberId: ReturnType<typeof vi.fn> };

  const envelope = (value: Record<string, any>) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA_ID', changes: [{ field: 'messages', value }] }],
  });

  beforeEach(async () => {
    chatService = { processIncomingMessage: vi.fn().mockResolvedValue({}) };
    tenantService = {
      findByPhoneNumberId: vi.fn().mockResolvedValue({
        id: 'tenant-123',
        name: 'Test Tenant',
        whatsappPhoneNumberId: '1404916169377344',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WabaWebhookController],
      providers: [
        { provide: ChatService, useValue: chatService },
        { provide: TenantService, useValue: tenantService },
      ],
    }).compile();

    controller = module.get<WabaWebhookController>(WabaWebhookController);
  });

  it('acknowledges the event immediately and processes it in the background', async () => {
    const payload = envelope({
      metadata: { phone_number_id: '1404916169377344' },
      messages: [{ from: '0245655799', id: 'wamid.1', type: 'text', text: { body: 'Hello' } }],
    });

    const result = controller.handleIncomingWebhook(payload);
    expect(result).toEqual({ status: 'EVENT_RECEIVED' });

    await vi.waitFor(() => expect(chatService.processIncomingMessage).toHaveBeenCalledTimes(1));
  });

  it('ignores payloads that are not WhatsApp business account events', () => {
    expect(controller.handleIncomingWebhook({ object: 'page' })).toEqual({ status: 'IGNORED' });
    expect(chatService.processIncomingMessage).not.toHaveBeenCalled();
  });

  it('uses the business-scoped user id as buyerPhone for hidden numbers', async () => {
    await controller.processPayload(
      envelope({
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '233205960861', phone_number_id: '1404916169377344' },
        contacts: [{ profile: { name: 'quaci', username: 'jamesweeba' }, user_id: 'GH.989894404158856' }],
        messages: [
          {
            from_user_id: 'GH.989894404158856',
            id: 'wamid.HBgSR0guOTg5ODk0NDA0MTU4ODU2FRQAEhgWM0VCMDM4MjUzMzk0NjQ0NzVGNDM0RAA=',
            timestamp: '1792498535',
            text: { body: 'Hello! I am interested in learning more about your business' },
            type: 'text',
          },
        ],
      }),
    );

    expect(chatService.processIncomingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-123',
        buyerPhone: 'GH.989894404158856',
        text: 'Hello! I am interested in learning more about your business',
        incomingMessageId: 'wamid.HBgSR0guOTg5ODk0NDA0MTU4ODU2FRQAEhgWM0VCMDM4MjUzMzk0NjQ0NzVGNDM0RAA=',
      }),
    );
  });

  it('normalises a local sender number to E.164', async () => {
    await controller.processPayload(
      envelope({
        metadata: { phone_number_id: '1404916169377344' },
        messages: [{ from: '0245655799', id: 'wamid.123', type: 'text', text: { body: 'Hello' } }],
      }),
    );

    expect(chatService.processIncomingMessage).toHaveBeenCalledWith(
      expect.objectContaining({ buyerPhone: '+233245655799', text: 'Hello' }),
    );
  });

  it('parses Flow submissions into flowData', async () => {
    await controller.processPayload(
      envelope({
        metadata: { phone_number_id: '1404916169377344' },
        messages: [
          {
            from: '233245655799',
            id: 'wamid.flow',
            type: 'interactive',
            interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{"order_ref":"MX-1"}' } },
          },
        ],
      }),
    );

    expect(chatService.processIncomingMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'WhatsApp Flow Submitted', flowData: { order_ref: 'MX-1' } }),
    );
  });

  it('drops events for phone number ids that no tenant owns instead of guessing', async () => {
    tenantService.findByPhoneNumberId.mockResolvedValue(null);

    await controller.processPayload(
      envelope({
        metadata: { phone_number_id: 'unknown' },
        messages: [{ from: '0245655799', id: 'wamid.x', type: 'text', text: { body: 'Hello' } }],
      }),
    );

    expect(chatService.processIncomingMessage).not.toHaveBeenCalled();
  });

  it('keeps processing other messages when one fails', async () => {
    chatService.processIncomingMessage.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({});

    await expect(
      controller.processPayload(
        envelope({
          metadata: { phone_number_id: '1404916169377344' },
          messages: [
            { from: '0245655799', id: 'wamid.a', type: 'text', text: { body: 'one' } },
            { from: '0245655798', id: 'wamid.b', type: 'text', text: { body: 'two' } },
          ],
        }),
      ),
    ).resolves.toBeUndefined();

    expect(chatService.processIncomingMessage).toHaveBeenCalledTimes(2);
  });
});
