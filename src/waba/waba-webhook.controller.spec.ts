import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WabaWebhookController } from './waba-webhook.controller.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChatService } from '../chat/chat.service.js';

describe('WabaWebhookController', () => {
  let controller: WabaWebhookController;
  let chatService: { processIncomingMessage: ReturnType<typeof vi.fn> };
  let prismaService: { tenant: { findFirst: ReturnType<typeof vi.fn> } };

  beforeEach(async () => {
    chatService = {
      processIncomingMessage: vi.fn().mockResolvedValue({}),
    };
    prismaService = {
      tenant: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'tenant-123',
          name: 'Test Tenant',
          whatsappPhoneNumberId: '1404916169377344',
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WabaWebhookController],
      providers: [
        { provide: ChatService, useValue: chatService },
        { provide: PrismaService, useValue: prismaService },
      ],
    }).compile();

    controller = module.get<WabaWebhookController>(WabaWebhookController);
  });

  it('should use recipient_user_id (from_user_id) for buyerPhone when recipient_id is not part of payload', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '233205960861',
                  phone_number_id: '1404916169377344',
                },
                contacts: [
                  {
                    profile: { name: 'quaci', username: 'jamesweeba' },
                    user_id: 'GH.989894404158856',
                  },
                ],
                messages: [
                  {
                    from_user_id: 'GH.989894404158856',
                    id: 'wamid.HBgSR0guOTg5ODk0NDA0MTU4ODU2FRQAEhgWM0VCMDM4MjUzMzk0NjQ0NzVGNDM0RAA=',
                    timestamp: '1792498535',
                    text: {
                      body: 'Hello! I am interested in learning more about your business',
                    },
                    type: 'text',
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = await controller.handleIncomingWebhook(payload);

    expect(result).toEqual({ status: 'EVENT_RECEIVED' });
    expect(chatService.processIncomingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-123',
        buyerPhone: 'GH.989894404158856',
        text: 'Hello! I am interested in learning more about your business',
        incomingMessageId:
          'wamid.HBgSR0guOTg5ODk0NDA0MTU4ODU2FRQAEhgWM0VCMDM4MjUzMzk0NjQ0NzVGNDM0RAA=',
      }),
    );
  });

  it('should format normal phone number when from / recipient_id is present', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  phone_number_id: '1404916169377344',
                },
                messages: [
                  {
                    from: '0245655799',
                    id: 'wamid.123',
                    type: 'text',
                    text: { body: 'Hello' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await controller.handleIncomingWebhook(payload);

    expect(chatService.processIncomingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerPhone: '+233245655799',
        text: 'Hello',
      }),
    );
  });
});
