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
      findFirst: vi.fn(),
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
    order: {
      findUnique: vi.fn(),
      update: vi.fn(),
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
      mockPrismaService.chatSession.findFirst.mockResolvedValue(mockSession);
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
          screen: process.env.META_FLOW_FIRST_SCREEN || 'PRODUCT_SELECT',
          headerText: 'SuperStore',
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
      mockPrismaService.chatSession.findFirst.mockResolvedValue(mockSession);
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
            flowCta: 'Order Groceries',
            screen: process.env.META_FLOW_FIRST_SCREEN || 'PRODUCT_SELECT',
            headerText: 'SuperStore',
          }),
        );
        expect(mockWabaService.sendTextMessage).not.toHaveBeenCalled();
      } else {
        expect(mockWabaService.sendWelcomeButtons).toHaveBeenCalledWith(
          'phone-number-id',
          '+233240000000',
          'SuperStore',
        );
        expect(mockWabaService.sendTextMessage).not.toHaveBeenCalled();
      }
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
      mockPrismaService.chatSession.findFirst.mockResolvedValue(mockSession);
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
      // ORDER_INTENT now auto-launches the flow instead of replying with text
      if (process.env.META_FLOW_ID) {
        expect(mockWabaService.sendFlowMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            phoneNumberId: 'phone-number-id',
            toPhone: '+233240000000',
            flowCta: 'Order Now',
          }),
        );
      } else {
        // No flow configured — falls back to welcome buttons or text
        expect(
          mockWabaService.sendFlowMessage.mock.calls.length +
          mockWabaService.sendWelcomeButtons.mock.calls.length +
          mockWabaService.sendTextMessage.mock.calls.length
        ).toBeGreaterThan(0);
      }
    });

    it('should reset flow cooldown and mark session as orderCompleted when order_ref is received', async () => {
      const mockSession = {
        id: 'session-order-1',
        tenantId: 'tenant-abc',
        buyerPhone: '+233240000000',
        orderCompleted: false,
        lastIntent: BuyerIntent.ORDER_INTENT,
      };

      mockPrismaService.chatSession.findFirst.mockResolvedValue(mockSession);
      mockPrismaService.chatMessage.findMany.mockResolvedValue([]);
      mockPrismaService.chatMessage.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'msg-1', ...data }),
      );
      mockPrismaService.chatSession.update.mockResolvedValue({
        ...mockSession,
        orderCompleted: true,
      });
      mockPrismaService.tenant.findUnique.mockResolvedValue({
        id: 'tenant-abc',
        name: 'SuperStore',
        whatsappPhoneNumberId: 'phone-number-id',
      });

      // Simulate a prior flow sent so cooldown is active
      (chatService as any).lastFlowSent.set('tenant-abc:+233240000000', Date.now());

      await chatService.processIncomingMessage({
        tenantId: 'tenant-abc',
        buyerPhone: '+233240000000',
        sender: MessageSender.BUYER,
        flowData: {
          order_ref: 'ORD-1234',
          payment_method: 'cod',
        },
      });

      // 1. Session should be marked as orderCompleted: true
      expect(mockPrismaService.chatSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'session-order-1' },
          data: expect.objectContaining({
            orderCompleted: true,
          }),
        }),
      );

      // 2. Cooldown should be deleted from in-memory map
      expect((chatService as any).lastFlowSent.has('tenant-abc:+233240000000')).toBe(false);
    });

    it('should create a new session on next chat when previous session was completed', async () => {
      // When findFirst queries for active session (orderCompleted: false), return null
      mockPrismaService.chatSession.findFirst.mockResolvedValue(null);
      const newSession = {
        id: 'new-session-456',
        tenantId: 'tenant-abc',
        buyerPhone: '+233240000000',
        orderCompleted: false,
      };
      mockPrismaService.chatSession.create.mockResolvedValue(newSession);

      const session = await chatService.getOrCreateSession('tenant-abc', '+233240000000');

      expect(mockPrismaService.chatSession.findFirst).toHaveBeenCalledWith({
        where: {
          tenantId: 'tenant-abc',
          buyerPhone: '+233240000000',
          orderCompleted: false,
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(mockPrismaService.chatSession.create).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-abc',
          buyerPhone: '+233240000000',
          orderCompleted: false,
        },
      });
      expect(session.id).toBe('new-session-456');
    });

    it('should format order confirmation receipt with itemized breakdown, total, and payment method', async () => {
      const mockSession = {
        id: 'session-order-2',
        tenantId: 'tenant-abc',
        buyerPhone: '+233240000000',
        orderCompleted: false,
        lastIntent: BuyerIntent.ORDER_INTENT,
      };

      mockPrismaService.chatSession.findFirst.mockResolvedValue(mockSession);
      mockPrismaService.chatMessage.findMany.mockResolvedValue([]);
      mockPrismaService.chatMessage.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'msg-1', ...data }),
      );
      mockPrismaService.chatSession.update.mockResolvedValue({
        ...mockSession,
        orderCompleted: true,
      });
      mockPrismaService.tenant.findUnique.mockResolvedValue({
        id: 'tenant-abc',
        name: 'SuperStore',
        whatsappPhoneNumberId: 'phone-number-id',
      });

      mockPrismaService.order.findUnique.mockResolvedValue({
        id: 'order-1',
        orderNumber: 'MX-5988',
        totalAmount: 12.5,
        notes: null,
        items: [
          { productName: 'Fresh Tomatoes', quantity: 2, unitPrice: 3.0, totalPrice: 6.0 },
          { productName: 'Red Onions', quantity: 1, unitPrice: 6.5, totalPrice: 6.5 },
        ],
      });
      mockPrismaService.order.update.mockResolvedValue({});

      const result = await chatService.processIncomingMessage({
        tenantId: 'tenant-abc',
        buyerPhone: '+233240000000',
        sender: MessageSender.BUYER,
        flowData: {
          order_ref: 'MX-5988',
          payment_method: 'cod',
        },
      });

      expect(result.systemResponse.text).toContain('🧾 *Order MX-5988 placed successfully!*');
      expect(result.systemResponse.text).toContain('📦 *Items Ordered:*');
      expect(result.systemResponse.text).toContain('• 2x Fresh Tomatoes — GH₵6.00');
      expect(result.systemResponse.text).toContain('• 1x Red Onions — GH₵6.50');
      expect(result.systemResponse.text).toContain('💰 *Total Amount:* GH₵12.50');
      expect(result.systemResponse.text).toContain('💳 *Payment Method:* Cash on Delivery');
      expect(result.systemResponse.text).toContain('Your order has been confirmed for Cash on Delivery.');
      expect(mockWabaService.sendTextMessage).toHaveBeenCalledWith(
        'phone-number-id',
        '+233240000000',
        expect.stringContaining('• 2x Fresh Tomatoes — GH₵6.00'),
      );
    });

    it('should itemize delivery fee, subtotal, and address when customer chooses delivery', async () => {
      const mockSession = {
        id: 'session-order-delivery',
        tenantId: 'tenant-abc',
        buyerPhone: '+233240000000',
        orderCompleted: false,
        lastIntent: BuyerIntent.ORDER_INTENT,
      };

      mockPrismaService.chatSession.findFirst.mockResolvedValue(mockSession);
      mockPrismaService.chatMessage.findMany.mockResolvedValue([]);
      mockPrismaService.chatMessage.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'msg-1', ...data }),
      );
      mockPrismaService.chatSession.update.mockResolvedValue({
        ...mockSession,
        orderCompleted: true,
      });
      mockPrismaService.tenant.findUnique.mockResolvedValue({
        id: 'tenant-abc',
        name: 'SuperStore',
        whatsappPhoneNumberId: 'phone-number-id',
      });

      mockPrismaService.order.findUnique.mockResolvedValue({
        id: 'order-delivery-1',
        orderNumber: 'MX-9901',
        totalAmount: 17.5,
        notes: 'Fulfillment: Delivery. Address: East Legon, Accra | Payment: Pay on delivery / pickup | Subtotal: ₵12.50 | Delivery Fee: ₵5.00 | Total: ₵17.50',
        items: [
          { productName: 'Fresh Tomatoes', quantity: 2, unitPrice: 3.0, totalPrice: 6.0 },
          { productName: 'Red Onions', quantity: 1, unitPrice: 6.5, totalPrice: 6.5 },
        ],
      });
      mockPrismaService.order.update.mockResolvedValue({});

      const result = await chatService.processIncomingMessage({
        tenantId: 'tenant-abc',
        buyerPhone: '+233240000000',
        sender: MessageSender.BUYER,
        flowData: {
          order_ref: 'MX-9901',
          payment_method: 'cod',
        },
      });

      expect(result.systemResponse.text).toContain('🧾 *Order MX-9901 placed successfully!*');
      expect(result.systemResponse.text).toContain('📦 *Items Ordered:*');
      expect(result.systemResponse.text).toContain('• 2x Fresh Tomatoes — GH₵6.00');
      expect(result.systemResponse.text).toContain('• 1x Red Onions — GH₵6.50');
      expect(result.systemResponse.text).toContain('🛒 *Items Subtotal:* GH₵12.50');
      expect(result.systemResponse.text).toContain('🛵 *Delivery Fee:* GH₵5.00');
      expect(result.systemResponse.text).toContain('💰 *Total Amount:* GH₵17.50');
      expect(result.systemResponse.text).toContain('📍 *Delivery Address:* East Legon, Accra');
      expect(result.systemResponse.text).toContain('💳 *Payment Method:* Cash on Delivery');
    });
  });
});
