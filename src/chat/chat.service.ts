import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { BuyerIntent, MessageSender, MessageSource, Product, Tenant } from '@prisma/client';
import { ghCedis } from '../common/money.util.js';
import { isHiddenNumber } from '../common/phone.util.js';
import { FlowService } from '../flow/flow.service.js';
import { ORDER_RECEIVED_BUTTON_TITLE, orderReceivedTap, OrderService } from '../order/order.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isLive, TenantService } from '../tenant/tenant.service.js';
import { WabaService, WELCOME_BODY_TEXT, WELCOME_BUTTON_IDS } from '../waba/waba.service.js';
import { AiClassifierService, ClassificationResult } from './ai-classifier.service.js';
import { ProcessMessageDto } from './dto/process-message.dto.js';
import { InteractiveOrderService } from './interactive-order.service.js';
import { parseFlowToText } from './utils/flow-parser.util.js';

type TenantWithProducts = Tenant & { products: Product[] };

/** What we are about to send the buyer. The stored system message is always this text. */
interface Reply {
  kind: 'text' | 'flow' | 'buttons';
  text: string;
  cta?: string;
}

/** Copy used when the ordering Flow is available, keyed by detected intent. */
const FLOW_COPY: Record<BuyerIntent, { body: (store: string) => string; cta: string }> = {
  GREETING: {
    body: (s) => `Hi 👋 Welcome to *${s}*! Tap below to browse our products and place your order.`,
    cta: 'Shop Now',
  },
  VIEW_CATALOG: {
    body: (s) => `🛍️ Browse everything *${s}* has in stock and order right here.`,
    cta: 'Browse Products',
  },
  ORDER_INTENT: {
    body: (s) => `🛒 Ready to order? Browse all available products from *${s}* and place your order right here!`,
    cta: 'Order Now',
  },
  PRODUCT_INQUIRY: {
    body: (s) => `🔍 Browse all our in-stock products from *${s}* and select exactly what you need!`,
    cta: 'Browse Products',
  },
  STOCK_CHECK: {
    body: (s) => `🔍 Browse all our in-stock products from *${s}* and select exactly what you need!`,
    cta: 'Browse Products',
  },
  HUMAN_SUPPORT: {
    body: () => '🤝 To get the fastest help, please place your order through our order form. A team member will follow up with you on WhatsApp.',
    cta: 'Open Order Form',
  },
  OUT_OF_BOUNDS: {
    body: (s) => `👋 I can only help with orders from *${s}*. Tap the button below to browse our products and place an order!`,
    cta: 'Browse & Order',
  },
};

const FLOW_COOLDOWN_MS = 15 * 60 * 1000;
const HISTORY_CONTEXT_SIZE = 5;

@Injectable()
export class ChatService implements OnModuleInit {
  private readonly logger = new Logger(ChatService.name);

  /** Last time the ordering Flow was sent to a buyer (tenantId:buyerPhone), to avoid spamming it. */
  private readonly lastFlowSent = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiClassifierService: AiClassifierService,
    private readonly wabaService: WabaService,
    private readonly flowService: FlowService,
    private readonly orderService: OrderService,
    private readonly interactiveOrderService: InteractiveOrderService,
    private readonly tenantService: TenantService,
  ) {}

  onModuleInit() {
    this.flowService.onConfirmationDue((tenant, orderNumber, buyerPhone) => this.confirmFlowOrder(tenant, orderNumber, buyerPhone));
  }

  clearCooldown(tenantId: string, buyerPhone: string) {
    this.lastFlowSent.delete(this.cooldownKey(tenantId, buyerPhone));
  }

  /**
   * Get the active chat session (orderCompleted = false) or create a new one.
   */
  async getOrCreateSession(tenantId: string, buyerPhone: string) {
    const existing = await this.prisma.chatSession.findFirst({
      where: { tenantId, buyerPhone, orderCompleted: false },
      orderBy: { createdAt: 'desc' },
    });
    return existing ?? this.prisma.chatSession.create({ data: { tenantId, buyerPhone, orderCompleted: false } });
  }

  /**
   * Handle one inbound buyer message: persist it, work out what to say, say it, and
   * persist exactly what was said so the vendor dashboard mirrors the WhatsApp thread.
   */
  async processIncomingMessage(dto: ProcessMessageDto) {
    const { text: messageText, source } = this.normalizeIncoming(dto);

    if (dto.incomingMessageId && (await this.isDuplicate(dto.incomingMessageId))) {
      this.logger.log(`Skipping duplicate WhatsApp message ${dto.incomingMessageId}`);
      return { duplicate: true, session: null, message: null, classification: null, systemResponse: null };
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: dto.tenantId },
      include: { products: true },
    });
    if (!tenant) {
      throw new NotFoundException(`Tenant ${dto.tenantId} not found.`);
    }

    if (dto.incomingMessageId && tenant.whatsappPhoneNumberId) {
      this.wabaService.sendTypingIndicator(tenant.whatsappPhoneNumberId, dto.incomingMessageId).catch(() => {});
    }

    const session = await this.getOrCreateSession(dto.tenantId, dto.buyerPhone);
    const orderRef = this.flowOrderRef(dto.flowData);

    if (dto.location) {
      const pinned = await this.handleLocationPin(tenant, session, dto, messageText);
      if (pinned) return pinned;
    }

    const receivedOrder = orderReceivedTap(messageText);
    if (receivedOrder) {
      return this.handleOrderReceived(tenant, session, dto, receivedOrder);
    }

    if (isHiddenNumber(dto.buyerPhone) && !orderRef) {
      return this.handleHiddenNumberBuyer(tenant, session, dto, messageText, source);
    }

    // A completed Flow order needs no AI call: the buyer just pressed Done.
    const classification: ClassificationResult = orderRef
      ? { intent: BuyerIntent.ORDER_INTENT, confidence: 1, extractedEntities: {}, isOutOfBounds: false, reasoning: 'Flow order completed.' }
      : await this.classify(session.id, messageText);

    const buyerMessage = await this.saveMessage(session.id, {
      sender: dto.sender || MessageSender.BUYER,
      source,
      text: messageText,
      whatsappMessageId: dto.incomingMessageId,
      flowData: dto.flowData,
      detectedIntent: classification.intent,
      confidenceScore: classification.confidence,
      rawAiResponse: classification.rawResponse,
    });

    let reply: Reply | null;

    if (orderRef) {
      // Done: the buyer is back in the chat, so the receipt and pin request land in view.
      const found = await this.confirmFlowOrder(tenant, orderRef, dto.buyerPhone, true);
      reply = found ? null : { kind: 'text', text: `🧾 Order ${orderRef} received. We'll contact you on WhatsApp with updates.` };
    } else if (dto.flowData) {
      reply = null; // intermediate Flow step: nothing to say yet
    } else {
      reply = await this.buildReply(tenant, dto.buyerPhone, messageText, classification);
    }

    if (reply && tenant.whatsappPhoneNumberId) {
      reply = await this.dispatch(tenant, dto.buyerPhone, reply);
    }

    const systemResponse = reply
      ? await this.saveMessage(session.id, {
          sender: MessageSender.SYSTEM,
          source: MessageSource.TEXT,
          text: reply.text,
          detectedIntent: classification.intent,
        })
      : null;

    const updatedSession = await this.prisma.chatSession.update({
      where: { id: session.id },
      data: {
        lastIntent: classification.intent,
        orderCompleted: orderRef ? true : session.orderCompleted,
      },
    });

    return { duplicate: false, session: updatedSession, message: buyerMessage, classification, systemResponse };
  }

  // ───────────────────────── Inbound helpers ─────────────────────────

  private normalizeIncoming(dto: ProcessMessageDto): { text: string; source: MessageSource } {
    let text = dto.text || '';
    let source = dto.location ? MessageSource.LOCATION : dto.source || MessageSource.TEXT;

    if (dto.flowData && Object.keys(dto.flowData).length > 0) {
      source = MessageSource.FLOW_SELECTION;
      const parsed = parseFlowToText(dto.flowData);
      text = text ? `${text} | ${parsed}` : parsed;
    }

    return { text: text.trim() || 'Empty message', source };
  }

  /** The order reference the Flow's terminal screen sends when the buyer presses Done. */
  private flowOrderRef(flowData?: Record<string, any>): string | null {
    const ref = flowData?.order_id ?? flowData?.order_ref;
    return ref ? String(ref).trim() || null : null;
  }

  private async isDuplicate(whatsappMessageId: string): Promise<boolean> {
    const existing = await this.prisma.chatMessage.findUnique({ where: { whatsappMessageId } });
    return Boolean(existing);
  }

  private saveMessage(
    sessionId: string,
    data: {
      sender: MessageSender;
      source: MessageSource;
      text: string;
      whatsappMessageId?: string;
      flowData?: Record<string, any>;
      detectedIntent?: BuyerIntent;
      confidenceScore?: number;
      rawAiResponse?: Record<string, any>;
    },
  ) {
    return this.prisma.chatMessage.create({
      data: {
        sessionId,
        sender: data.sender,
        source: data.source,
        text: data.text,
        whatsappMessageId: data.whatsappMessageId ?? undefined,
        flowData: data.flowData ?? undefined,
        detectedIntent: data.detectedIntent ?? undefined,
        confidenceScore: data.confidenceScore ?? undefined,
        rawAiResponse: (data.rawAiResponse ?? undefined) as any,
      },
    });
  }

  /**
   * Classify the buyer's intent. Welcome-button taps are mapped directly and skip the AI call.
   */
  private async classify(sessionId: string, messageText: string): Promise<ClassificationResult> {
    const button = this.buttonIntent(messageText);
    if (button) {
      return { intent: button, confidence: 1, extractedEntities: {}, isOutOfBounds: false, reasoning: 'Welcome button tapped.' };
    }

    const recent = await this.prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_CONTEXT_SIZE,
    });
    const history = recent.reverse().map((msg) => `${msg.sender}: ${msg.text}`);
    return this.aiClassifierService.classifyMessage(messageText, history);
  }

  private buttonIntent(messageText: string): BuyerIntent | null {
    switch (messageText.trim()) {
      case WELCOME_BUTTON_IDS.SHOP:
      case '🛍️ Shop products':
        return BuyerIntent.VIEW_CATALOG;
      case WELCOME_BUTTON_IDS.HUMAN:
      case '💬 Talk to us':
        return BuyerIntent.HUMAN_SUPPORT;
      case WELCOME_BUTTON_IDS.TRACK:
      case '📦 Track my order':
        return BuyerIntent.ORDER_INTENT;
      default:
        return null;
    }
  }

  private isTrackRequest(messageText: string): boolean {
    const trimmed = messageText.trim();
    return trimmed === WELCOME_BUTTON_IDS.TRACK || trimmed === '📦 Track my order';
  }

  // ───────────────────────── Location pins ─────────────────────────

  /**
   * A buyer shared a location pin. Attach it to their newest order that asked for one;
   * returns null when no order is waiting, so the message is handled like any other.
   */
  private async handleLocationPin(
    tenant: TenantWithProducts,
    session: { id: string },
    dto: ProcessMessageDto,
    messageText: string,
  ) {
    const order = await this.orderService.attachLocation(tenant.id, dto.buyerPhone, dto.location!);
    if (!order) return null;

    const buyerMessage = await this.saveMessage(session.id, {
      sender: dto.sender || MessageSender.BUYER,
      source: MessageSource.LOCATION,
      text: messageText,
      whatsappMessageId: dto.incomingMessageId,
    });

    let reply: Reply = {
      kind: 'text',
      text: `📍 Thanks! We've saved this pin for order *${order.orderNumber}*. Our rider will use it to find you.`,
    };
    if (tenant.whatsappPhoneNumberId) {
      reply = await this.dispatch(tenant, dto.buyerPhone, reply);
    }
    const systemResponse = await this.saveMessage(session.id, {
      sender: MessageSender.SYSTEM,
      source: MessageSource.TEXT,
      text: reply.text,
    });

    return { duplicate: false, session, message: buyerMessage, classification: null, systemResponse };
  }

  /** The buyer tapped "I got my order" on the out-for-delivery message. No AI call needed. */
  private async handleOrderReceived(tenant: TenantWithProducts, session: { id: string }, dto: ProcessMessageDto, orderNumber: string) {
    const buyerMessage = await this.saveMessage(session.id, {
      sender: dto.sender || MessageSender.BUYER,
      source: MessageSource.TEXT,
      text: `${ORDER_RECEIVED_BUTTON_TITLE} (${orderNumber})`,
      whatsappMessageId: dto.incomingMessageId,
    });

    let reply: Reply = { kind: 'text', text: await this.orderService.confirmReceivedByBuyer(tenant.id, dto.buyerPhone, orderNumber) };
    if (tenant.whatsappPhoneNumberId) {
      reply = await this.dispatch(tenant, dto.buyerPhone, reply);
    }
    const systemResponse = await this.saveMessage(session.id, {
      sender: MessageSender.SYSTEM,
      source: MessageSource.TEXT,
      text: reply.text,
    });

    return { duplicate: false, session, message: buyerMessage, classification: null, systemResponse };
  }

  // ───────────────────────── Hidden-number buyers ─────────────────────────

  private async handleHiddenNumberBuyer(
    tenant: TenantWithProducts,
    session: { id: string },
    dto: ProcessMessageDto,
    messageText: string,
    source: MessageSource,
  ) {
    if (!tenant.whatsappPhoneNumberId) {
      this.logger.error(`[BSUID] Tenant "${tenant.name}" has no whatsappPhoneNumberId; cannot reply to ${dto.buyerPhone}.`);
      return { duplicate: false, session, message: null, classification: null, systemResponse: null };
    }

    const buyerMessage = await this.saveMessage(session.id, {
      sender: dto.sender || MessageSender.BUYER,
      source,
      text: messageText,
      whatsappMessageId: dto.incomingMessageId,
    });

    await this.interactiveOrderService.handleHiddenNumberBuyerInteraction({
      tenant,
      buyerPhone: dto.buyerPhone,
      sessionId: session.id,
      messageText,
    });

    const systemResponse = await this.saveMessage(session.id, {
      sender: MessageSender.SYSTEM,
      source: MessageSource.TEXT,
      text: 'Handled by the interactive ordering assistant.',
      detectedIntent: BuyerIntent.VIEW_CATALOG,
    });

    return {
      duplicate: false,
      session,
      message: buyerMessage,
      classification: { intent: BuyerIntent.VIEW_CATALOG, confidence: 1, isOutOfBounds: false },
      systemResponse,
    };
  }

  // ───────────────────────── Replies ─────────────────────────

  /**
   * Send a Flow order's receipt (the MoMo prompt already went out at place_order), then ask
   * for the delivery pin. Runs when the buyer taps Done, and from a fallback a minute after
   * place_order for buyers who close the Flow instead; only the first call sends anything.
   * Returns false when the order is not this buyer's.
   *
   * MoMo buyers often leave WhatsApp to approve the prompt, so the fallback can fire while
   * the Flow is still open and the pin request lands out of view. A later Done therefore
   * asks for the pin again, at the bottom of the chat, unless the buyer already shared it.
   */
  private async confirmFlowOrder(tenant: Tenant, orderRef: string, buyerPhone: string, fromDone = false): Promise<boolean> {
    this.clearCooldown(tenant.id, buyerPhone);

    const completion = await this.flowService.completeOrder(tenant, orderRef, buyerPhone);
    if (!completion) {
      this.logger.warn(`Order ${orderRef} not found for tenant ${tenant.id} and buyer ${buyerPhone}.`);
      return false;
    }
    if (completion.text === null) {
      const { order } = completion;
      if (fromDone && tenant.whatsappPhoneNumberId && order.locationRequestedAt && !order.locationReceivedAt) {
        const session = await this.getOrCreateSession(tenant.id, buyerPhone);
        await this.askForPin(tenant, buyerPhone, session.id, order, true);
      }
      return true;
    }

    const session = await this.getOrCreateSession(tenant.id, buyerPhone);
    await this.orderService.linkSession(completion.order.id, session.id);

    if (tenant.whatsappPhoneNumberId) {
      await this.dispatch(tenant, buyerPhone, { kind: 'text', text: completion.text });
    }
    await this.saveMessage(session.id, {
      sender: MessageSender.SYSTEM,
      source: MessageSource.TEXT,
      text: completion.text,
      detectedIntent: BuyerIntent.ORDER_INTENT,
    });

    if (tenant.whatsappPhoneNumberId) {
      await this.askForPin(tenant, buyerPhone, session.id, completion.order, false);
    }
    return true;
  }

  /** Send the location request and note in the thread whether it actually went out. */
  private async askForPin(tenant: Tenant, buyerPhone: string, sessionId: string, order: { id: string; orderNumber: string }, again: boolean) {
    const how = await this.flowService.requestDeliveryLocation(tenant, buyerPhone, order);
    const asked = `📍 Asked the buyer${again ? ' again' : ''} to share the delivery location for order ${order.orderNumber}`;
    await this.saveMessage(sessionId, {
      sender: MessageSender.SYSTEM,
      source: MessageSource.TEXT,
      text:
        how === 'location_request'
          ? `${asked}.`
          : how === 'text'
            ? `${asked} by text (WhatsApp refused the location button).`
            : `⚠️ Could not send the location request for order ${order.orderNumber}; ask the buyer for their pin in the chat.`,
    });
  }

  private async buildReply(
    tenant: TenantWithProducts,
    buyerPhone: string,
    messageText: string,
    classification: ClassificationResult,
  ): Promise<Reply> {
    if (this.isTrackRequest(messageText)) {
      return { kind: 'text', text: await this.trackLatestOrder(tenant, buyerPhone) };
    }

    const intent = classification.intent;

    // Only approved shops send the ordering Flow (the webhook already filters inbound messages).
    if (this.flowService.isConfigured() && isLive(tenant)) {
      const copy = FLOW_COPY[intent] ?? FLOW_COPY.OUT_OF_BOUNDS;
      const lastSent = this.lastFlowSent.get(this.cooldownKey(tenant.id, buyerPhone)) || 0;
      if (Date.now() - lastSent > FLOW_COOLDOWN_MS) {
        return { kind: 'flow', text: copy.body(tenant.name), cta: copy.cta };
      }
      return {
        kind: 'text',
        text: `👆 We already sent you the order form a moment ago. Scroll up and tap *${copy.cta}* to continue.`,
      };
    }

    const shopButton = intent === BuyerIntent.VIEW_CATALOG && this.buttonIntent(messageText) !== null;
    if (intent === BuyerIntent.GREETING || shopButton) {
      return { kind: 'buttons', text: WELCOME_BODY_TEXT };
    }

    return { kind: 'text', text: this.generateResponseForIntent(intent, tenant, classification.extractedEntities) };
  }

  /**
   * Send the reply over WhatsApp. If a richer message type fails, fall back to plain text
   * with the same copy, so the stored message still matches what the buyer saw.
   */
  private async dispatch(tenant: Tenant, buyerPhone: string, reply: Reply): Promise<Reply> {
    const phoneNumberId = tenant.whatsappPhoneNumberId!;
    try {
      switch (reply.kind) {
        case 'flow':
          try {
            await this.flowService.dispatchFlow({ tenant, toPhone: buyerPhone, cta: reply.cta!, bodyText: reply.text });
            this.lastFlowSent.set(this.cooldownKey(tenant.id, buyerPhone), Date.now());
          } catch (err: any) {
            this.logger.warn(`Flow dispatch failed (${err?.message || err}); sending text instead.`);
            await this.wabaService.sendTextMessage(phoneNumberId, buyerPhone, reply.text);
          }
          break;
        case 'buttons':
          try {
            await this.wabaService.sendWelcomeButtons(phoneNumberId, buyerPhone, tenant.name);
          } catch {
            await this.wabaService.sendTextMessage(phoneNumberId, buyerPhone, reply.text);
          }
          break;
        default:
          await this.wabaService.sendTextMessage(phoneNumberId, buyerPhone, reply.text);
      }
    } catch (err: any) {
      this.logger.warn(`WhatsApp auto-reply dispatch failed: ${err?.message || err}`);
    }
    return reply;
  }

  private async trackLatestOrder(tenant: Tenant, buyerPhone: string): Promise<string> {
    const order = await this.orderService.findLatestForBuyer(tenant.id, buyerPhone);
    if (!order) {
      return `📦 You have no orders with *${tenant.name}* yet. Say *hi* to start one!`;
    }
    const status = order.status.replace(/_/g, ' ').toLowerCase();
    return `📦 Your latest order *${order.orderNumber}* (${ghCedis(order.totalAmount)}) is currently *${status}*.`;
  }

  /**
   * Plain-text reply used when no ordering Flow is configured.
   */
  private generateResponseForIntent(
    intent: BuyerIntent,
    tenant: TenantWithProducts,
    entities?: { productName?: string | null; quantity?: number | null },
  ): string {
    const store = tenant.name || 'our store';
    const products = tenant.products || [];
    const inStock = products.filter((p) => p.inStock);
    const matched = this.findProduct(products, entities?.productName);
    const describe = (p: Product) => `${p.image ?? '🛒'} *${p.name}*`;

    switch (intent) {
      case BuyerIntent.GREETING:
        return WELCOME_BODY_TEXT;

      case BuyerIntent.VIEW_CATALOG: {
        if (products.length === 0) {
          return `🏪 Welcome to *${store}*! Our catalog is currently empty. Please check back soon!`;
        }
        const outOfStock = products.filter((p) => !p.inStock);
        const list = inStock.map((p) => `${describe(p)}\n   💰 ${ghCedis(p.price)}`).join('\n\n');
        const outList = outOfStock.length
          ? `\n\n❌ *Currently Out of Stock:*\n${outOfStock.map((p) => `${p.image ?? '🛒'} ${p.name}`).join('\n')}`
          : '';
        return `🛍️ *${store} — Product Catalog*\n\n${list}${outList}\n\n_Reply with a product name to order or ask about it!_`;
      }

      case BuyerIntent.PRODUCT_INQUIRY:
        if (matched) {
          const stockLabel = matched.inStock ? '✅ In Stock' : '❌ Out of Stock';
          return `${describe(matched)}\n💰 Price: ${ghCedis(matched.price)}\n📦 Status: ${stockLabel}\n\nWould you like to place an order? Just say _"I want to buy ${matched.name}"_`;
        }
        return `🔍 We couldn't find that exact product. Reply *"view catalog"* to see all available items at *${store}*!`;

      case BuyerIntent.STOCK_CHECK:
        if (matched) {
          return matched.inStock
            ? `✅ Yes! ${describe(matched)} is currently in stock at ${ghCedis(matched.price)}.`
            : `❌ Sorry, ${describe(matched)} is currently out of stock. Check back soon!`;
        }
        return `📦 We currently have *${inStock.length} items* in stock and ready to go! Reply *"view catalog"* to see the full list.`;

      case BuyerIntent.ORDER_INTENT: {
        if (matched && !matched.inStock) {
          const alternatives = inStock.length
            ? `\n\n📦 *Available Items in Stock:*\n${inStock.map((p) => `• ${describe(p)} — ${ghCedis(p.price)}`).join('\n')}`
            : '';
          return `❌ Sorry, ${describe(matched)} is currently out of stock.${alternatives}\n\nReply with an item name to order!`;
        }
        if (matched) {
          const qty = entities?.quantity || 1;
          return `🛒 *Order Summary*\n\n${describe(matched)}\n   • Quantity: ${qty}\n   • Unit Price: ${ghCedis(matched.price)}\n   • *Total: ${ghCedis(matched.price * qty)}*\n\nReply *CONFIRM* to complete your purchase with *${store}*! 🎉`;
        }
        if (inStock.length === 0) {
          return `🏪 Welcome to *${store}*! We currently have no items in stock for ordering. Please check back later!`;
        }
        const list = inStock.map((p, i) => `${i + 1}. ${describe(p)}\n   💰 Price: ${ghCedis(p.price)}`).join('\n\n');
        return `🛒 *Place an Order — ${store}*\n\nHere are the items available for purchase:\n\n${list}\n\n👉 *To place your order*, reply with the product name and quantity (e.g., _"I want 2 ${inStock[0].name}"_).`;
      }

      case BuyerIntent.HUMAN_SUPPORT:
        return `🤝 You've requested to speak with a representative from *${store}*.\n\nA team member will join this chat shortly. Thank you for your patience! 🙏`;

      default:
        return `👋 Thanks for reaching out to *${store}*!\n\nI can help you with:\n🛍️ Browse catalog\n💬 Product inquiries\n📦 Place an order\n🤝 Talk to support\n\nWhat would you like to do?`;
    }
  }

  private findProduct(products: Product[], name?: string | null): Product | undefined {
    if (!name) return undefined;
    const needle = name.toLowerCase();
    return products.find((p) => p.name.toLowerCase().includes(needle));
  }

  private cooldownKey(tenantId: string, buyerPhone: string): string {
    return `${tenantId}:${buyerPhone}`;
  }

  // ───────────────────────── Vendor dashboard queries ─────────────────────────

  /**
   * List buyer conversations for the authenticated vendor's shop.
   */
  async getSessionsForVendor(userId: string, page = 1, limit = 20, search?: string) {
    const tenant = await this.tenantService.findByUser(userId);
    const where = {
      tenantId: tenant.id,
      ...(search ? { buyerPhone: { contains: search, mode: 'insensitive' as const } } : {}),
    };

    const [total, sessions] = await Promise.all([
      this.prisma.chatSession.count({ where }),
      this.prisma.chatSession.findMany({
        where,
        skip: (Math.max(1, page) - 1) * limit,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          orders: { orderBy: { createdAt: 'desc' }, include: { items: true } },
          _count: { select: { messages: true, orders: true } },
        },
      }),
    ]);

    return {
      data: sessions.map((session) => ({
        id: session.id,
        buyerPhone: session.buyerPhone,
        lastIntent: session.lastIntent,
        orderCompleted: session.orderCompleted,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        lastMessage: session.messages[0] || null,
        totalMessages: session._count.messages,
        totalOrders: session._count.orders,
        orders: session.orders,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Full conversation and orders for one session owned by the vendor.
   */
  async getSessionDetailForVendor(userId: string, sessionId: string) {
    const tenant = await this.tenantService.findByUser(userId);
    const session = await this.prisma.chatSession.findFirst({
      where: { id: sessionId, tenantId: tenant.id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        orders: { orderBy: { createdAt: 'desc' }, include: { items: true } },
      },
    });
    if (!session) {
      throw new NotFoundException(`Conversation session "${sessionId}" not found for your shop.`);
    }
    return session;
  }

  /**
   * Latest chat history between the vendor's shop and a buyer.
   */
  async getSessionHistory(userId: string, buyerPhone: string) {
    const tenant = await this.tenantService.findByUser(userId);
    const session = await this.prisma.chatSession.findFirst({
      where: { tenantId: tenant.id, buyerPhone },
      orderBy: { createdAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) {
      throw new NotFoundException(`No chat history found for buyer "${buyerPhone}".`);
    }
    return session;
  }
}
