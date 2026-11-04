import { Test, TestingModule } from '@nestjs/testing';
import { BuyerIntent, Fulfillment, MessageSender, PaymentMethod } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiClassifierService } from './ai-classifier.service.js';
import { ChatService } from './chat.service.js';
import { parseFlowToText } from './utils/flow-parser.util.js';
import { FlowService } from '../flow/flow.service.js';
import { WabaService } from '../waba/waba.service.js';
import { OrderService } from '../order/order.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { InteractiveOrderService } from './interactive-order.service.js';
import { formatOrderReceipt } from '../order/order-receipt.js';

describe('ChatModule', () => {
  let chatService: ChatService;
  let aiClassifierService: AiClassifierService;

  const tenant = {
    id: 'tenant-abc',
    name: 'SuperStore',
    status: 'ACTIVE',
    whatsappPhoneNumberId: 'phone-number-id',
    deliveryFee: 5,
    products: [] as any[],
  };

  const session = {
    id: 'session-123',
    tenantId: 'tenant-abc',
    buyerPhone: '+233240000000',
    orderCompleted: false,
    lastIntent: null,
  };

  const mockPrismaService = {
    chatSession: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    chatMessage: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    tenant: {
      findUnique: vi.fn(),
    },
  };

  const mockOrderService = {
    findByOrderNumber: vi.fn(),
    linkSession: vi.fn(),
    findLatestForBuyer: vi.fn(),
    attachLocation: vi.fn(),
    confirmReceivedByBuyer: vi.fn(),
  };

  const mockWabaService = {
    sendTextMessage: vi.fn(),
    sendWelcomeButtons: vi.fn(),
    sendTypingIndicator: vi.fn(),
  };

  /** completeOrder mirrors the real tenant check and receipt so the chat-side behaviour stays observable. */
  const mockFlowService = {
    isConfigured: vi.fn(),
    dispatchFlow: vi.fn(),
    requestDeliveryLocation: vi.fn(),
    onConfirmationDue: vi.fn(),
    completeOrder: vi.fn(async (t: { id: string }, ref: string) => {
      const order = await mockOrderService.findByOrderNumber(ref);
      return order && order.tenantId === t.id ? { order, text: formatOrderReceipt(order) } : null;
    }),
  };

  const mockInteractiveOrderService = {
    handleHiddenNumberBuyerInteraction: vi.fn(),
  };

  const mockTenantService = {
    findByUser: vi.fn(),
  };

  const buyerMessage = (text: string, extra: Record<string, any> = {}) => ({
    tenantId: 'tenant-abc',
    buyerPhone: '+233240000000',
    text,
    sender: MessageSender.BUYER,
    ...extra,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        AiClassifierService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: WabaService, useValue: mockWabaService },
        { provide: FlowService, useValue: mockFlowService },
        { provide: OrderService, useValue: mockOrderService },
        { provide: InteractiveOrderService, useValue: mockInteractiveOrderService },
        { provide: TenantService, useValue: mockTenantService },
      ],
    }).compile();

    chatService = module.get<ChatService>(ChatService);
    aiClassifierService = module.get<AiClassifierService>(AiClassifierService);

    vi.clearAllMocks();
    vi.spyOn(aiClassifierService as any, 'apiKey', 'get').mockReturnValue('');

    mockPrismaService.chatSession.findFirst.mockResolvedValue(session);
    mockPrismaService.chatSession.update.mockImplementation(({ data }) => Promise.resolve({ ...session, ...data }));
    mockPrismaService.chatMessage.findUnique.mockResolvedValue(null);
    mockPrismaService.chatMessage.findMany.mockResolvedValue([]);
    mockPrismaService.chatMessage.create.mockImplementation(({ data }) => Promise.resolve({ id: 'msg-1', ...data }));
    mockPrismaService.tenant.findUnique.mockResolvedValue(tenant);

    mockWabaService.sendTextMessage.mockResolvedValue({ messageId: 'wamid-123' });
    mockWabaService.sendWelcomeButtons.mockResolvedValue({ messageId: 'wamid-welcome' });
    mockWabaService.sendTypingIndicator.mockResolvedValue({ success: true });
    mockFlowService.isConfigured.mockReturnValue(false);
    mockFlowService.dispatchFlow.mockResolvedValue({ messageId: 'wamid-flow' });
    mockOrderService.linkSession.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseFlowToText', () => {
    it('should correctly format WhatsApp flow JSON into human-readable text', () => {
      const result = parseFlowToText({ action: 'select_item', product_name: 'Sneakers', quantity: 2 });
      expect(result).toBe('Flow Selection: Action: select_item | Selected Product: "Sneakers" (Qty: 2)');
    });
  });

  describe('AiClassifierService', () => {
    it('should classify greetings correctly via fallback when API key is unconfigured', async () => {
      const result = await aiClassifierService.classifyMessage('Hello, good morning!');
      expect(result.intent).toBe(BuyerIntent.GREETING);
    });

    it('should classify product questions correctly via fallback', async () => {
      const result = await aiClassifierService.classifyMessage('How much does this cost?');
      expect(result.intent).toBe(BuyerIntent.PRODUCT_INQUIRY);
    });

    it('should parse JSON correctly when AI response contains conversational preamble', async () => {
      vi.spyOn(aiClassifierService as any, 'apiKey', 'get').mockReturnValue('test-api-key');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: 'Here\'s the classification:\n{"intent": "ORDER_INTENT", "confidence": 0.95, "extractedEntities": {"productName": "Shoes", "quantity": 1}, "isOutOfBounds": false, "reasoning": "Buyer wants to buy shoes"}',
            },
          }],
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
          choices: [{
            message: {
              content: '```json\n{"intent": "HUMAN_SUPPORT", "confidence": 0.88, "extractedEntities": {}, "isOutOfBounds": false, "reasoning": "Agent requested"}\n```',
            },
          }],
        }),
      }));

      const result = await aiClassifierService.classifyMessage('Can I talk to a human?');
      expect(result.intent).toBe(BuyerIntent.HUMAN_SUPPORT);
    });
  });

  describe('ChatService', () => {
    it('sends the product Flow when the buyer taps Shop products and stores the copy it sent', async () => {
      mockFlowService.isConfigured.mockReturnValue(true);

      const result = await chatService.processIncomingMessage(buyerMessage('SHOP'));

      expect(result.classification!.intent).toBe(BuyerIntent.VIEW_CATALOG);
      expect(mockFlowService.dispatchFlow).toHaveBeenCalledWith(
        expect.objectContaining({ tenant, toPhone: '+233240000000', cta: 'Browse Products' }),
      );
      expect(result.systemResponse!.text).toContain('SuperStore');
      expect(mockWabaService.sendTextMessage).not.toHaveBeenCalled();
    });

    it('sends a nudge instead of a second Flow while the cooldown is active', async () => {
      mockFlowService.isConfigured.mockReturnValue(true);
      (chatService as any).lastFlowSent.set('tenant-abc:+233240000000', Date.now());

      const result = await chatService.processIncomingMessage(buyerMessage('hello'));

      expect(mockFlowService.dispatchFlow).not.toHaveBeenCalled();
      expect(mockWabaService.sendTextMessage).toHaveBeenCalledWith('phone-number-id', '+233240000000', result.systemResponse!.text);
      expect(result.systemResponse!.text).toContain('already sent you the order form');
    });

    it('falls back to welcome buttons for greetings when no Flow is configured', async () => {
      const result = await chatService.processIncomingMessage(buyerMessage('Hi there!'));

      expect(result.session!.id).toBe('session-123');
      expect(result.classification!.intent).toBe(BuyerIntent.GREETING);
      expect(result.systemResponse!.text).toBe('Hi 👋 What would you like to do today?');
      expect(mockPrismaService.chatMessage.create).toHaveBeenCalledTimes(2);
      expect(mockWabaService.sendWelcomeButtons).toHaveBeenCalledWith('phone-number-id', '+233240000000', 'SuperStore');
      expect(mockWabaService.sendTextMessage).not.toHaveBeenCalled();
    });

    it('replies with the in-stock catalog text for ORDER_INTENT when no Flow is configured', async () => {
      mockPrismaService.tenant.findUnique.mockResolvedValue({
        ...tenant,
        products: [
          { id: 'p1', name: 'Running Shoes', price: 150, inStock: true, image: '👟' },
          { id: 'p2', name: 'Wireless Earbuds', price: 80, inStock: false, image: '🎧' },
        ],
      });

      const result = await chatService.processIncomingMessage(buyerMessage('I want to place an order'));

      expect(result.classification!.intent).toBe(BuyerIntent.ORDER_INTENT);
      expect(result.systemResponse!.text).toContain('🛒 *Place an Order — SuperStore*');
      expect(result.systemResponse!.text).toContain('👟 *Running Shoes*');
      expect(result.systemResponse!.text).toContain('💰 Price: GH₵150.00');
      expect(result.systemResponse!.text).not.toContain('Wireless Earbuds');
      expect(mockWabaService.sendTextMessage).toHaveBeenCalledWith('phone-number-id', '+233240000000', result.systemResponse!.text);
    });

    it('skips messages whose WhatsApp id was already processed', async () => {
      mockPrismaService.chatMessage.findUnique.mockResolvedValue({ id: 'existing' });

      const result = await chatService.processIncomingMessage(buyerMessage('hello', { incomingMessageId: 'wamid.dup' }));

      expect(result.duplicate).toBe(true);
      expect(mockPrismaService.chatMessage.create).not.toHaveBeenCalled();
      expect(mockWabaService.sendTextMessage).not.toHaveBeenCalled();
    });

    it('should reset flow cooldown and mark session as orderCompleted when order_ref is received', async () => {
      mockOrderService.findByOrderNumber.mockResolvedValue(null);
      (chatService as any).lastFlowSent.set('tenant-abc:+233240000000', Date.now());

      await chatService.processIncomingMessage(buyerMessage('', { flowData: { order_ref: 'ORD-1234' } }));

      expect(mockPrismaService.chatSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'session-123' },
          data: expect.objectContaining({ orderCompleted: true }),
        }),
      );
      expect((chatService as any).lastFlowSent.has('tenant-abc:+233240000000')).toBe(false);
    });

    it('should create a new session on next chat when previous session was completed', async () => {
      mockPrismaService.chatSession.findFirst.mockResolvedValue(null);
      const newSession = { id: 'new-session-456', tenantId: 'tenant-abc', buyerPhone: '+233240000000', orderCompleted: false };
      mockPrismaService.chatSession.create.mockResolvedValue(newSession);

      const created = await chatService.getOrCreateSession('tenant-abc', '+233240000000');

      expect(mockPrismaService.chatSession.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-abc', buyerPhone: '+233240000000', orderCompleted: false },
        orderBy: { createdAt: 'desc' },
      });
      expect(mockPrismaService.chatSession.create).toHaveBeenCalledWith({
        data: { tenantId: 'tenant-abc', buyerPhone: '+233240000000', orderCompleted: false },
      });
      expect(created.id).toBe('new-session-456');
    });

    it('should format order confirmation receipt with itemized breakdown, total, and payment method', async () => {
      mockOrderService.findByOrderNumber.mockResolvedValue({
        id: 'order-1',
        tenantId: 'tenant-abc',
        orderNumber: 'MX-5988',
        totalAmount: 12.5,
        paymentMethod: PaymentMethod.COD,
        items: [
          { productName: 'Fresh Tomatoes', quantity: 2, unitPrice: 3.0, totalPrice: 6.0 },
          { productName: 'Red Onions', quantity: 1, unitPrice: 6.5, totalPrice: 6.5 },
        ],
      });

      await chatService.processIncomingMessage(buyerMessage('', { flowData: { order_ref: 'MX-5988' } }));
      const text = mockWabaService.sendTextMessage.mock.calls[0][2];

      expect(text).toContain('🧾 *Order MX-5988 placed successfully!*');
      expect(text).toContain('📦 *Items Ordered:*');
      expect(text).toContain('• 2x Fresh Tomatoes — GH₵6.00');
      expect(text).toContain('• 1x Red Onions — GH₵6.50');
      expect(text).toContain('💰 *Total Amount:* GH₵12.50');
      expect(text).toContain('💳 *Payment Method:* Cash on Delivery');
      expect(text).toContain('Your order has been confirmed for Cash on Delivery.');
      expect(mockOrderService.linkSession).toHaveBeenCalledWith('order-1', 'session-123');
      expect(mockWabaService.sendTextMessage).toHaveBeenCalledWith('phone-number-id', '+233240000000', text);
    });

    it('should itemize delivery fee, subtotal, and address when customer chooses delivery', async () => {
      mockOrderService.findByOrderNumber.mockResolvedValue({
        id: 'order-delivery-1',
        tenantId: 'tenant-abc',
        orderNumber: 'MX-9901',
        totalAmount: 17.5,
        deliveryFee: 5,
        fulfillment: Fulfillment.DELIVERY,
        deliveryAddress: 'East Legon, Accra',
        paymentMethod: PaymentMethod.COD,
        items: [
          { productName: 'Fresh Tomatoes', quantity: 2, unitPrice: 3.0, totalPrice: 6.0 },
          { productName: 'Red Onions', quantity: 1, unitPrice: 6.5, totalPrice: 6.5 },
        ],
      });

      await chatService.processIncomingMessage(buyerMessage('', { flowData: { order_ref: 'MX-9901' } }));
      const text = mockWabaService.sendTextMessage.mock.calls[0][2];

      expect(text).toContain('🧾 *Order MX-9901 placed successfully!*');
      expect(text).toContain('🛒 *Items Subtotal:* GH₵12.50');
      expect(text).toContain('🛵 *Delivery Fee:* GH₵5.00');
      expect(text).toContain('💰 *Total Amount:* GH₵17.50');
      expect(text).toContain('📍 *Delivery Address:* East Legon, Accra');
      expect(text).toContain('💳 *Payment Method:* Cash on Delivery');
    });

    it('treats the Flow Done payload (order_id) as a completed order and asks for the delivery pin', async () => {
      mockOrderService.findByOrderNumber.mockResolvedValue({
        id: 'order-7', tenantId: 'tenant-abc', orderNumber: 'MX-7', totalAmount: 10, paymentMethod: PaymentMethod.COD, items: [],
      });
      const classify = vi.spyOn(aiClassifierService, 'classifyMessage');

      await chatService.processIncomingMessage(buyerMessage('WhatsApp Flow Submitted', { flowData: { order_id: 'MX-7' } }));

      expect(classify).not.toHaveBeenCalled();
      expect(mockFlowService.completeOrder).toHaveBeenCalledWith(expect.objectContaining({ id: 'tenant-abc' }), 'MX-7', '+233240000000');
      expect(mockFlowService.requestDeliveryLocation).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tenant-abc' }),
        '+233240000000',
        expect.objectContaining({ id: 'order-7', orderNumber: 'MX-7' }),
      );
      const receiptCall = mockWabaService.sendTextMessage.mock.invocationCallOrder[0];
      const pinCall = mockFlowService.requestDeliveryLocation.mock.invocationCallOrder[0];
      expect(receiptCall).toBeLessThan(pinCall);
    });

    it('confirms a Flow order from the fallback when the buyer never taps Done', async () => {
      mockOrderService.findByOrderNumber.mockResolvedValue({
        id: 'order-7', tenantId: 'tenant-abc', orderNumber: 'MX-7', totalAmount: 10, paymentMethod: PaymentMethod.COD, items: [],
      });
      chatService.onModuleInit();
      const [confirm] = mockFlowService.onConfirmationDue.mock.calls[0];

      await confirm(tenant, 'MX-7', '+233240000000');

      expect(mockWabaService.sendTextMessage).toHaveBeenCalledWith('phone-number-id', '+233240000000', expect.stringContaining('MX-7'));
      expect(mockOrderService.linkSession).toHaveBeenCalledWith('order-7', 'session-123');
      expect(mockFlowService.requestDeliveryLocation).toHaveBeenCalled();
    });

    it('sends nothing on Done when the fallback already confirmed the order', async () => {
      mockOrderService.findByOrderNumber.mockResolvedValue({ id: 'order-7', tenantId: 'tenant-abc', orderNumber: 'MX-7' });
      mockFlowService.completeOrder.mockImplementationOnce(async () => ({ order: { id: 'order-7', orderNumber: 'MX-7' }, text: null }) as any);

      const result = await chatService.processIncomingMessage(buyerMessage('WhatsApp Flow Submitted', { flowData: { order_id: 'MX-7' } }));

      expect(result.systemResponse).toBeNull();
      expect(mockWabaService.sendTextMessage).not.toHaveBeenCalled();
      expect(mockFlowService.requestDeliveryLocation).not.toHaveBeenCalled();
    });

    it('attaches a shared location pin to the waiting order and confirms it', async () => {
      mockOrderService.attachLocation.mockResolvedValue({ id: 'order-7', orderNumber: 'MX-7' });
      const location = { latitude: 6.67, longitude: -1.57 };

      const result = await chatService.processIncomingMessage(buyerMessage('📍 Location shared (6.67, -1.57)', { location }));

      expect(mockOrderService.attachLocation).toHaveBeenCalledWith('tenant-abc', '+233240000000', location);
      expect(mockPrismaService.chatMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ source: 'LOCATION' }) }),
      );
      expect(result.systemResponse!.text).toContain('saved this pin for order *MX-7*');
    });

    it('confirms receipt when the buyer taps "I got my order", without asking the AI', async () => {
      mockOrderService.confirmReceivedByBuyer.mockResolvedValue('✅ Thank you! Order *MX-7* is marked as received.');

      const result = await chatService.processIncomingMessage(buyerMessage('order_received:MX-7'));

      expect(mockOrderService.confirmReceivedByBuyer).toHaveBeenCalledWith('tenant-abc', '+233240000000', 'MX-7');
      expect(mockPrismaService.chatMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ text: '✅ I got my order (MX-7)' }) }),
      );
      expect(result.classification).toBeNull();
      expect(result.systemResponse!.text).toContain('marked as received');
    });

    it('does not link an order that belongs to another tenant', async () => {
      mockOrderService.findByOrderNumber.mockResolvedValue({ id: 'order-x', tenantId: 'other-tenant', orderNumber: 'MX-1', totalAmount: 1, items: [] });

      const result = await chatService.processIncomingMessage(buyerMessage('', { flowData: { order_ref: 'MX-1' } }));

      expect(mockOrderService.linkSession).not.toHaveBeenCalled();
      expect(result.systemResponse!.text).toContain('Order MX-1 received');
    });
  });
});
