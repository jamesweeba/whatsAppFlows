import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from '../chat/chat.service.js';
import { FlowService } from '../flow/flow.service.js';
import { PromoterBotService } from '../promoter/promoter-bot.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { WabaService } from './waba.service.js';
import { WabaWebhookController } from './waba-webhook.controller.js';

describe('WabaWebhookController', () => {
  let controller: WabaWebhookController;
  let chatService: { processIncomingMessage: ReturnType<typeof vi.fn> };
  let tenantService: { findByPhoneNumberId: ReturnType<typeof vi.fn>; findPoolNumber: ReturnType<typeof vi.fn> };
  let wabaService: { sendTextMessage: ReturnType<typeof vi.fn> };
  let flowService: { handleFailedDelivery: ReturnType<typeof vi.fn> };
  let promoterBot: { handle: ReturnType<typeof vi.fn> };

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
        status: 'ACTIVE',
        whatsappPhoneNumberId: '1404916169377344',
      }),
      findPoolNumber: vi.fn().mockResolvedValue(null),
    };
    wabaService = { sendTextMessage: vi.fn().mockResolvedValue({ messageId: 'wamid.reply' }) };
    flowService = { handleFailedDelivery: vi.fn().mockResolvedValue(false) };
    promoterBot = { handle: vi.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WabaWebhookController],
      providers: [
        { provide: ChatService, useValue: chatService },
        { provide: TenantService, useValue: tenantService },
        { provide: WabaService, useValue: wabaService },
        { provide: FlowService, useValue: flowService },
        { provide: PromoterBotService, useValue: promoterBot },
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

  it('hands failed deliveries to the pin fallback, and ignores other statuses', async () => {
    await controller.processPayload(
      envelope({
        metadata: { phone_number_id: '1404916169377344' },
        statuses: [
          { id: 'wamid.loc', status: 'failed', recipient_user_id: 'GH.1', errors: [{ code: 131026, title: 'Message undeliverable' }] },
          { id: 'wamid.ok', status: 'delivered', recipient_id: '233245655799' },
        ],
      }),
    );

    expect(flowService.handleFailedDelivery).toHaveBeenCalledTimes(1);
    expect(flowService.handleFailedDelivery).toHaveBeenCalledWith('wamid.loc');
    expect(chatService.processIncomingMessage).not.toHaveBeenCalled();
  });

  it("keeps a shop's messages with the shop even if PLATFORM_PHONE_NUMBER_ID is set to its number", async () => {
    vi.stubEnv('PLATFORM_PHONE_NUMBER_ID', '1404916169377344');
    try {
      await controller.processPayload(
        envelope({
          metadata: { phone_number_id: '1404916169377344' },
          messages: [{ from: '0245655799', id: 'wamid.shop', type: 'text', text: { body: 'Hello' } }],
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
    expect(chatService.processIncomingMessage).toHaveBeenCalledTimes(1);
    expect(promoterBot.handle).not.toHaveBeenCalled();
  });

  it('sends messages on the platform number to the promoter bot, not the shop chat', async () => {
    tenantService.findByPhoneNumberId.mockResolvedValue(null);
    vi.stubEnv('PLATFORM_PHONE_NUMBER_ID', 'PLATFORM_ID');
    try {
      await controller.processPayload(
        envelope({
          metadata: { phone_number_id: 'PLATFORM_ID' },
          contacts: [{ wa_id: '233244111222' }],
          messages: [
            { from: '233244111222', id: 'wamid.p1', type: 'text', text: { body: 'I want to promote' } },
            { from: '233244111222', id: 'wamid.p2', type: 'interactive', interactive: { button_reply: { id: 'promoter:start', title: 'Become a promoter' } } },
          ],
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }

    expect(promoterBot.handle).toHaveBeenCalledWith({ phone: '+233244111222', text: 'I want to promote', messageId: 'wamid.p1' });
    expect(promoterBot.handle).toHaveBeenCalledWith({ phone: '+233244111222', text: 'promoter:start', messageId: 'wamid.p2' });
    expect(chatService.processIncomingMessage).not.toHaveBeenCalled();
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
            interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{"order_id":"MX-1"}' } },
          },
        ],
      }),
    );

    expect(chatService.processIncomingMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'WhatsApp Flow Submitted', flowData: { order_id: 'MX-1' } }),
    );
  });

  it('passes the id of a list choice (e.g. a rating) through as the text', async () => {
    await controller.processPayload(
      envelope({
        metadata: { phone_number_id: '1404916169377344' },
        messages: [
          {
            from: '233245655799',
            id: 'wamid.rate',
            type: 'interactive',
            interactive: { type: 'list_reply', list_reply: { id: 'rate_order:MX-1:5', title: '⭐⭐⭐⭐⭐' } },
          },
        ],
      }),
    );

    expect(chatService.processIncomingMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'rate_order:MX-1:5' }));
  });

  it('passes shared location pins through to the chat service', async () => {
    await controller.processPayload(
      envelope({
        metadata: { phone_number_id: '1404916169377344' },
        messages: [
          {
            from: '233245655799',
            id: 'wamid.loc',
            type: 'location',
            location: { latitude: 6.6745, longitude: -1.5716, name: 'Unity Hall' },
          },
        ],
      }),
    );

    expect(chatService.processIncomingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '📍 Location shared: Unity Hall (6.6745, -1.5716)',
        location: { latitude: 6.6745, longitude: -1.5716, name: 'Unity Hall' },
      }),
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
    expect(wabaService.sendTextMessage).not.toHaveBeenCalled();
  });

  const hello = (phoneNumberId: string) =>
    envelope({
      metadata: { phone_number_id: phoneNumberId },
      messages: [{ from: '0245655799', id: 'wamid.h', type: 'text', text: { body: 'Hello' } }],
    });

  it('tells buyers a suspended shop is temporarily closed, without running the chat', async () => {
    tenantService.findByPhoneNumberId.mockResolvedValue({ id: 'tenant-123', name: 'Ama Groceries', status: 'SUSPENDED' });

    await controller.processPayload(hello('1404916169377344'));

    expect(chatService.processIncomingMessage).not.toHaveBeenCalled();
    expect(wabaService.sendTextMessage).toHaveBeenCalledWith(
      '1404916169377344',
      '+233245655799',
      'Sorry, Ama Groceries is temporarily closed. Please check back later.',
    );
  });

  it('tells buyers a shop that is not approved yet is not open', async () => {
    tenantService.findByPhoneNumberId.mockResolvedValue({ id: 'tenant-123', name: 'New Shop', status: 'UNDER_REVIEW' });

    await controller.processPayload(hello('1404916169377344'));

    expect(chatService.processIncomingMessage).not.toHaveBeenCalled();
    expect(wabaService.sendTextMessage).toHaveBeenCalledWith('1404916169377344', '+233245655799', expect.stringContaining("isn't open"));
  });

  it('replies from a pool number that no shop has yet (free or cooling)', async () => {
    tenantService.findByPhoneNumberId.mockResolvedValue(null);
    tenantService.findPoolNumber.mockResolvedValue({ id: 'n1', status: 'COOLING' });

    await controller.processPayload(hello('999000999'));

    expect(wabaService.sendTextMessage).toHaveBeenCalledWith('999000999', '+233245655799', expect.stringContaining("isn't open"));
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
