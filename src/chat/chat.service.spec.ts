import { Test, TestingModule } from '@nestjs/testing';
import { BuyerIntent, MessageSender, MessageSource } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiClassifierService } from './ai-classifier.service.js';
import { ChatService } from './chat.service.js';
import { parseFlowToText } from './utils/flow-parser.util.js';
import { FlowService } from '../flow/flow.service.js';
import { WabaService } from '../waba/waba.service.js';
import { OrderService } from '../order/order.service.js';

describe('ChatModule', () => {
  let chatService: ChatService;
  let aiClassifierService: AiClassifierService;

  const mockPrismaService = {
    chatSession: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    chatMessage: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    tenant: {
      findUnique: vi.fn(),
    },
    product: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  };

  const mockWabaService = {
    sendTextMessage: vi.fn().mockResolvedValue({ messageId: 'wamid-123' }),
    sendWelcomeButtons: vi.fn().mockResolvedValue({ messageId: 'wamid-welcome' }),
    sendFlowMessage: vi.fn().mockResolvedValue({ messageId: 'wamid-flow' }),
    sendTypingIndicator: vi.fn().mockResolvedValue({ success: true }),
  };

  const mockFlowService = {
    buildFlowInitData: vi.fn().mockImplementation(async (tenantId: string) => {
      const products = (await mockPrismaService.product.findMany()) || [];
      const count = (await mockPrismaService.product.count()) || products.length;
      const totalPages = Math.ceil(count / 5) || 1;
      return {
        categories: [{ id: 'all', title: 'All Products' }],
        category_prefill: 'all',
        products: products.map((p: any) => ({
          id: p.id,
          title: p.name,
          description: `₵${p.price.toFixed(2)}`,
        })),
        pre_selected: [],
        page_label: `Page 1 of ${totalPages} · ${count} products`,
        selection_note: 'Your basket is empty',
        search_prefill: ' ',
        page_options: Array.from({ length: totalPages }, (_, i) => ({
          id: `${i + 1}`,
          title: `Page ${i + 1}`,
        })),
        page_prefill: '1',
        notice: ' ',
        show_notice: false,
      };
    }),
  };

  const mockOrderService = {
    createOrder: vi.fn().mockResolvedValue({ id: 'order-1' }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        AiClassifierService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: WabaService,
          useValue: mockWabaService,
        },
        {
          provide: FlowService,
          useValue: mockFlowService,
        },
        {
          provide: OrderService,
          useValue: mockOrderService,
        },
      ],
    }).compile();

    chatService = module.get<ChatService>(ChatService);
    aiClassifierService = module.get<AiClassifierService>(AiClassifierService);

    vi.clearAllMocks();
  });

  describe('parseFlowToText', () => {
    it('should correctly format WhatsApp flow JSON into human-readable text', () => {
      const flowPayload = {
        action: 'select_item',
        product_name: 'Sneakers',
        quantity: 2,
      };

      const result = parseFlowToText(flowPayload);
      expect(result).toBe('Flow Selection: Action: select_item | Selected Product: "Sneakers" (Qty: 2)');
    });
  });

  describe('AiClassifierService', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('should classify greetings correctly via fallback when API key is unconfigured', async () => {
      vi.spyOn(aiClassifierService as any, 'apiKey', 'get').mockReturnValue('');
      const result = await aiClassifierService.classifyMessage('Hello, good morning!');
      expect(result.intent).toBe(BuyerIntent.GREETING);
    });

    it('should classify product questions correctly via fallback', async () => {
      vi.spyOn(aiClassifierService as any, 'apiKey', 'get').mockReturnValue('');
      const result = await aiClassifierService.classifyMessage('How much does this cost?');
      expect(result.intent).toBe(BuyerIntent.PRODUCT_INQUIRY);
    });

    it('should parse JSON correctly when AI response contains conversational preamble', async () => {
      vi.spyOn(aiClassifierService as any, 'apiKey', 'get').mockReturnValue('test-api-key');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'Here\'s the classification:\n{"intent": "ORDER_INTENT", "confidence": 0.95, "extractedEntities": {"productName": "Shoes", "quantity": 1}, "isOutOfBounds": false, "reasoning": "Buyer wants to buy shoes"}',
              },
            },
          ],
        }),
      }));

      const result = await aiClassifierService.classifyMessage('I want to buy shoes');
      expect(result.intent).toBe(BuyerIntent.ORDER_INTENT);
      expect(result.extractedEntities.productName).toBe('Shoes');
      expect(result.extractedEntities.quantity).toBe(1);
    });

    it('should parse JSON correctly when AI response is inside markdown codeblock', async () => {
      vi.spyOn(aiClassifierService as any, 'apiKey', 'get').mockReturnValue('test-api-key');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '```json\n{"intent": "HUMAN_SUPPORT", "confidence": 0.88, "extractedEntities": {}, "isOutOfBounds": false, "reasoning": "Agent requested"}\n```',
              },
            },
          ],
        }),
      }));

      const result = await aiClassifierService.classifyMessage('Can I talk to a human?');
      expect(result.intent).toBe(BuyerIntent.HUMAN_SUPPORT);
    });
  });

  describe('ChatService', () => {
    it('sends the product Flow when the buyer selects Shop products', async () => {
      vi.spyOn(aiClassifierService as any, 'apiKey', 'get').mockReturnValue('');
      const mockSession = {
        id: 'session-123',
        tenantId: 'tenant-abc',
        buyerPhone: '+233240000000',
        lastIntent: null,
      };

      const previousFlowId = process.env.META_FLOW_ID;
      process.env.META_FLOW_ID = 'flow-123';
      mockPrismaService.chatSession.findUnique.mockResolvedValue(mockSession);
      mockPrismaService.chatMessage.findMany.mockResolvedValue([]);
      mockPrismaService.chatMessage.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'msg-1', ...data }),
      );
      mockPrismaService.chatSession.update.mockResolvedValue({
        ...mockSession,
        lastIntent: BuyerIntent.VIEW_CATALOG,
      });
      mockPrismaService.tenant.findUnique.mockResolvedValue({
        id: 'tenant-abc',
        name: 'SuperStore',
        whatsappPhoneNumberId: 'phone-number-id',
      });
      mockPrismaService.product.findMany.mockResolvedValue([
        { id: 'p1', name: 'Tomatoes', price: 2 },
        { id: 'p2', name: 'Onions', price: 1.5 },
      ]);
      mockPrismaService.product.count.mockResolvedValue(7);

      const result = await chatService.processIncomingMessage({
        tenantId: 'tenant-abc',
        buyerPhone: '+233240000000',
        text: 'SHOP',
        sender: MessageSender.BUYER,
      });

      expect(result.classification.intent).toBe(BuyerIntent.VIEW_CATALOG);
      expect(result.systemResponse.text).toBe('Opening the product catalog.');
      expect(mockWabaService.sendFlowMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          phoneNumberId: 'phone-number-id',
          toPhone: '+233240000000',
          flowId: 'flow-123',
          screen: 'PRODUCT_SELECT',
          headerText: 'SuperStore',
          data: expect.objectContaining({
            products: [
              { id: 'p1', title: 'Tomatoes', description: '₵2.00' },
              { id: 'p2', title: 'Onions', description: '₵1.50' },
            ],
            page_label: 'Page 1 of 2 · 7 products',
          }),
        }),
      );
      expect(mockWabaService.sendTextMessage).not.toHaveBeenCalled();
      if (previousFlowId === undefined) {
        delete process.env.META_FLOW_ID;
      } else {
        process.env.META_FLOW_ID = previousFlowId;
      }
    });

    it('should process a message, parse flow data, classify intent, and save to DB', async () => {
      vi.spyOn(aiClassifierService as any, 'apiKey', 'get').mockReturnValue('');
      const mockSession = {
        id: 'session-123',
        tenantId: 'tenant-abc',
        buyerPhone: '+233240000000',
        lastIntent: null,
      };

      mockPrismaService.chatSession.findUnique.mockResolvedValue(mockSession);
      mockPrismaService.chatMessage.findMany.mockResolvedValue([]);
      mockPrismaService.chatMessage.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'msg-1', ...data }),
      );
      mockPrismaService.chatSession.update.mockResolvedValue({
        ...mockSession,
        lastIntent: BuyerIntent.GREETING,
      });

      mockPrismaService.tenant.findUnique.mockResolvedValue({
        id: 'tenant-abc',
        name: 'SuperStore',
        whatsappPhoneNumberId: 'phone-number-id',
        products: [],
      });

      const dto = {
        tenantId: 'tenant-abc',
        buyerPhone: '+233240000000',
        text: 'Hi there!',
        sender: MessageSender.BUYER,
      };

      const result = await chatService.processIncomingMessage(dto);

      expect(result.session.id).toBe('session-123');
      expect(result.classification.intent).toBe(BuyerIntent.GREETING);
      expect(result.systemResponse.text).toBe('Hi 👋 What would you like to do today?');
      expect(mockPrismaService.chatMessage.create).toHaveBeenCalledTimes(2);
      if (process.env.META_FLOW_ID) {
        expect(mockWabaService.sendFlowMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            phoneNumberId: 'phone-number-id',
            toPhone: '+233240000000',
            flowCta: 'Get started',
            screen: process.env.META_FLOW_FIRST_SCREEN || 'PRODUCT_SELECT',
          }),
        );
      } else {
        expect(mockWabaService.sendWelcomeButtons).toHaveBeenCalledWith(
          'phone-number-id',
          '+233240000000',
          'SuperStore',
        );
      }
      expect(mockWabaService.sendTextMessage).not.toHaveBeenCalled();
    });

    it('should fetch in-stock database items formatted in WhatsApp style for ORDER_INTENT without a product name', async () => {
      vi.spyOn(aiClassifierService as any, 'apiKey', 'get').mockReturnValue('');
      const mockSession = {
        id: 'session-123',
        tenantId: 'tenant-abc',
        buyerPhone: '+233240000000',
        lastIntent: null,
      };

      mockPrismaService.chatSession.findUnique.mockResolvedValue(mockSession);
      mockPrismaService.chatMessage.findMany.mockResolvedValue([]);
      mockPrismaService.chatMessage.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'msg-1', ...data }),
      );
      mockPrismaService.chatSession.update.mockResolvedValue({
        ...mockSession,
        lastIntent: BuyerIntent.ORDER_INTENT,
      });

      mockPrismaService.tenant.findUnique.mockResolvedValue({
        id: 'tenant-abc',
        name: 'SuperStore',
        whatsappPhoneNumberId: 'phone-number-id',
        products: [
          { id: 'p1', name: 'Running Shoes', price: 150, inStock: true, image: '👟' },
          { id: 'p2', name: 'Wireless Earbuds', price: 80, inStock: false, image: '🎧' },
        ],
      });

      const dto = {
        tenantId: 'tenant-abc',
        buyerPhone: '+233240000000',
        text: 'I want to place an order',
        sender: MessageSender.BUYER,
      };

      const result = await chatService.processIncomingMessage(dto);

      expect(result.classification.intent).toBe(BuyerIntent.ORDER_INTENT);
      expect(result.systemResponse.text).toContain('🛒 *Place an Order — SuperStore*');
      expect(result.systemResponse.text).toContain('👟 *Running Shoes*');
      expect(result.systemResponse.text).toContain('💰 Price: GH₵150.00');
      expect(result.systemResponse.text).not.toContain('Wireless Earbuds');
      expect(mockWabaService.sendTextMessage).toHaveBeenCalledWith(
        'phone-number-id',
        '+233240000000',
        result.systemResponse.text,
      );
    });
  });
});
