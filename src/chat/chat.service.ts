import { Injectable, NotFoundException } from '@nestjs/common';
import { BuyerIntent, MessageSender, MessageSource, Tenant, Product, OrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiClassifierService } from './ai-classifier.service.js';
import { ProcessMessageDto } from './dto/process-message.dto.js';
import { parseFlowToText } from './utils/flow-parser.util.js';
import { FlowService } from '../flow/flow.service.js';
import { WabaService } from '../waba/waba.service.js';
import { OrderService } from '../order/order.service.js';

@Injectable()
export class ChatService {
  /**
   * Tracks the last time an order flow was sent to each buyer (keyed by tenantId:buyerPhone).
   * Used to enforce a 15-minute cooldown so the flow is not spammed on every message.
   */
  private readonly flowCooldownMs = 15 * 60 * 1000; // 15 minutes
  private readonly lastFlowSent = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiClassifierService: AiClassifierService,
    private readonly wabaService: WabaService,
    private readonly flowService: FlowService,
    private readonly orderService: OrderService,
  ) { }

  /**
   * Clear the 15-minute order flow cooldown for a buyer-tenant pair.
   * Called when an order is completed, allowing the buyer to launch a fresh flow immediately.
   */
  clearCooldown(tenantId: string, buyerPhone: string) {
    this.lastFlowSent.delete(`${tenantId}:${buyerPhone}`);
  }

  /**
   * Get an active chat session (where orderCompleted is false) or create a new one.
   * When an order is completed, the previous session is marked orderCompleted=true,
   * so the buyer's next interaction will automatically create a brand new session.
   */
  async getOrCreateSession(tenantId: string, buyerPhone: string) {
    let session = await this.prisma.chatSession.findFirst({
      where: {
        tenantId,
        buyerPhone,
        orderCompleted: false,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!session) {
      session = await this.prisma.chatSession.create({
        data: {
          tenantId,
          buyerPhone,
          orderCompleted: false,
        },
      });
    }

    return session;
  }

  /**
   * Process an incoming text message or WhatsApp Flow selection from a buyer.
   * Parses flow payloads, saves message to history, runs AI intent classification,
   * updates session state, and dispatches automated response to buyer on WhatsApp.
   */
  async processIncomingMessage(dto: ProcessMessageDto) {

    let messageText = dto.text || '';
    let source = dto.source || MessageSource.TEXT;

    // If flowData is provided, convert it into readable text and set source
    if (dto.flowData && Object.keys(dto.flowData).length > 0) {
      source = MessageSource.FLOW_SELECTION;
      const parsedFlowText = parseFlowToText(dto.flowData);
      messageText = messageText
        ? `${messageText} | ${parsedFlowText}`
        : parsedFlowText;
    }

    if (!messageText.trim()) {
      messageText = 'Empty message';
    }

    // 1. Fetch tenant early (used for typing indicator, response generation, and WhatsApp dispatch)
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: dto.tenantId },
      include: { products: true },
    });

    // 1b. Immediately display "typing..." indicator and mark message as read on WhatsApp
    if (dto.incomingMessageId && tenant?.whatsappPhoneNumberId) {
      this.wabaService
        .sendTypingIndicator(tenant.whatsappPhoneNumberId, dto.incomingMessageId)
        .catch(() => { });
    }

    // 2. Fetch or create ChatSession
    const session = await this.getOrCreateSession(dto.tenantId, dto.buyerPhone);

    // 3. Retrieve recent 5 messages for history context
    const recentMessages = await this.prisma.chatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    const historyContext = recentMessages
      .reverse()
      .map((msg) => `${msg.sender}: ${msg.text}`);

    // 4. Classify intent with AI
    let classification = await this.aiClassifierService.classifyMessage(
      messageText,
      historyContext,
    );



    const shopRequested = ['SHOP', '🛍️ Shop products'].includes(
      messageText.trim(),
    );
    if (shopRequested) {
      classification = {
        ...classification,
        intent: BuyerIntent.VIEW_CATALOG,
        confidence: 1,
        isOutOfBounds: false,
        reasoning: 'Buyer selected the Shop products welcome button.',
      };
    }

    // 5. Save buyer ChatMessage in database
    const buyerMessage = await this.prisma.chatMessage.create({
      data: {
        sessionId: session.id,
        sender: dto.sender || MessageSender.BUYER,
        source,
        text: messageText,
        flowData: dto.flowData ?? undefined,
        detectedIntent: classification.intent,
        confidenceScore: classification.confidence,
        rawAiResponse: (classification.rawResponse ?? undefined) as any,
      },
    });

    // 5b. Auto-create or confirm Order in DB if WhatsApp Flow submission payload exists
    if (dto.flowData?.cart_json) {
      try {
        const cartItems = typeof dto.flowData.cart_json === 'string'
          ? JSON.parse(dto.flowData.cart_json)
          : dto.flowData.cart_json;

        if (Array.isArray(cartItems) && cartItems.length > 0) {
          await this.orderService.createOrder(dto.tenantId, {
            buyerPhone: dto.buyerPhone,
            sessionId: session.id,
            items: cartItems.map((item: any) => ({
              productId: item.id || item.productId || undefined,
              productName: item.title || item.name || 'Product Item',
              unitPrice: Number(item.unitPrice || item.price || 0),
              quantity: Number(item.qty || item.quantity || 1),
            })),
          });
        }
      } catch (err) {
        console.warn(`Auto order creation from flow failed: ${err}`);
      }
    }

    let completedOrder: any = null;

    if (dto.flowData?.order_ref) {
      try {
        const orderRef = String(dto.flowData.order_ref).trim();
        const paymentMethod = dto.flowData.payment_method;
        const momoNetwork = dto.flowData.momo_network;
        const momoNumber = dto.flowData.momo_number;

        const existingOrder = await this.prisma.order.findUnique({
          where: { orderNumber: orderRef },
          include: { items: true },
        });

        if (existingOrder) {
          completedOrder = existingOrder;
          const notesArr = [existingOrder.notes];
          if (paymentMethod === 'momo') {
            notesArr.push(`MoMo Details: ${momoNetwork || 'MoMo'} (${momoNumber || dto.buyerPhone})`);
          } else if (paymentMethod === 'cod') {
            notesArr.push('Payment: Cash on Delivery confirmed');
          }

          await this.prisma.order.update({
            where: { id: existingOrder.id },
            data: {
              sessionId: session.id,
              status: paymentMethod === 'momo' ? OrderStatus.AWAITING_PAYMENT : OrderStatus.CONFIRMED,
              notes: notesArr.filter(Boolean).join(' | '),
            },
          });
        }
      } catch (orderUpdateErr) {
        console.warn(`Error updating flow order: ${orderUpdateErr}`);
      }

      // Reset flow cooldown immediately upon order completion
      this.clearCooldown(dto.tenantId, dto.buyerPhone);
    }

    // 6. Generate automated response based on classified intent
    const responseText = dto.flowData?.order_ref
      ? this.formatOrderConfirmationMessage(
        String(dto.flowData.order_ref).trim(),
        dto.flowData.payment_method,
        dto.flowData.momo_number,
        dto.buyerPhone,
        completedOrder,
      )
      : (shopRequested
        ? 'Opening the product catalog.'
        : await this.generateResponseForIntent(
          classification.intent,
          dto.tenantId,
          classification.extractedEntities,
          tenant,
        ));

    // 7. Save automated system response in database
    const systemResponse = await this.prisma.chatMessage.create({
      data: {
        sessionId: session.id,
        sender: MessageSender.SYSTEM,
        source: MessageSource.TEXT,
        text: responseText,
        detectedIntent: classification.intent,
      },
    });

    // 8. Dispatch automated WhatsApp message back to buyer via Meta Cloud API if tenant is onboarded
    if (tenant?.whatsappPhoneNumberId) {
      try {
        const isOrderConfirmation = !!dto.flowData?.order_ref;
        const isFlowSubmission = dto.source === MessageSource.FLOW_SELECTION || !!dto.flowData;

        // === INTENTS THAT ALWAYS LAUNCH THE FLOW ===
        const flowIntents = new Set<BuyerIntent>([
          BuyerIntent.GREETING,
          BuyerIntent.VIEW_CATALOG,
          BuyerIntent.ORDER_INTENT,
          BuyerIntent.PRODUCT_INQUIRY,
          BuyerIntent.STOCK_CHECK,
          BuyerIntent.HUMAN_SUPPORT,
          BuyerIntent.OUT_OF_BOUNDS,
        ]);

        if (isOrderConfirmation) {
          // Order was just placed via the flow — send confirmation text only
          await this.wabaService.sendTextMessage(
            tenant.whatsappPhoneNumberId,
            dto.buyerPhone,
            responseText,
          );
        } else if (isFlowSubmission) {
          // Intermediate flow step (not final order) — don't send anything extra
        } else if (shopRequested || flowIntents.has(classification.intent)) {
          // Determine message copy based on intent
          const isGreeting = classification.intent === BuyerIntent.GREETING || shopRequested;
          const isOutOfScope = classification.intent === BuyerIntent.OUT_OF_BOUNDS;
          const isHumanSupport = classification.intent === BuyerIntent.HUMAN_SUPPORT;

          let bodyText: string;
          let ctaLabel: string;

          if (isGreeting) {
            bodyText = `Hi 👋 Welcome to *${tenant.name}*! Tap below to browse fresh groceries and place your order.`;
            ctaLabel = 'Order Groceries';
          } else if (isOutOfScope) {
            bodyText = `👋 I can only help with grocery orders from *${tenant.name}*. Tap the button below to browse our products and place an order!`;
            ctaLabel = 'Browse & Order';
          } else if (isHumanSupport) {
            bodyText = `🤝 To get the fastest help, please place your order through our order form. A team member will follow up with you on WhatsApp.`;
            ctaLabel = 'Open Order Form';
          } else if (classification.intent === BuyerIntent.ORDER_INTENT) {
            bodyText = `🛒 Ready to order? Browse all available groceries from *${tenant.name}* and place your order right here!`;
            ctaLabel = 'Order Now';
          } else if (classification.intent === BuyerIntent.PRODUCT_INQUIRY || classification.intent === BuyerIntent.STOCK_CHECK) {
            bodyText = `🔍 Browse all our in-stock products from *${tenant.name}* and select exactly what you need!`;
            ctaLabel = 'Browse Products';
          } else {
            bodyText = `🛍️ Shop fresh groceries from *${tenant.name}* — delivered to your door!`;
            ctaLabel = 'Order Groceries';
          }

          // Cooldown check: only re-send flow if it hasn't been sent in the last 15 minutes
          const cooldownKey = `${tenant.id}:${dto.buyerPhone}`;
          const lastSent = this.lastFlowSent.get(cooldownKey) || 0;
          const cooldownExpired = Date.now() - lastSent > this.flowCooldownMs;

          const flowId = process.env.META_FLOW_ID;

          if (flowId && cooldownExpired) {
            const firstScreen = process.env.META_FLOW_FIRST_SCREEN || 'PRODUCT_SELECT';
            try {
              const flowData = await this.flowService.buildFlowInitData(tenant.id, firstScreen);
              await this.wabaService.sendFlowMessage({
                phoneNumberId: tenant.whatsappPhoneNumberId,
                toPhone: dto.buyerPhone,
                flowId,
                flowToken: `${tenant.id}:${dto.buyerPhone}:${Date.now()}`,
                flowCta: ctaLabel,
                screen: firstScreen,
                headerText: tenant.name,
                bodyText,
                data: flowData,
              });
              this.lastFlowSent.set(cooldownKey, Date.now());
            } catch (flowErr: any) {
              console.warn(`Flow dispatch failed (${flowErr?.message || flowErr}). Sending nudge text.`);
              // Fallback: send a short text nudge if flow fails
              await this.wabaService.sendTextMessage(
                tenant.whatsappPhoneNumberId,
                dto.buyerPhone,
                bodyText,
              );
            }
          } else if (!flowId) {
            // No flow configured — fall back to welcome buttons or text
            try {
              await this.wabaService.sendWelcomeButtons(
                tenant.whatsappPhoneNumberId,
                dto.buyerPhone,
                tenant.name,
              );
            } catch {
              await this.wabaService.sendTextMessage(
                tenant.whatsappPhoneNumberId,
                dto.buyerPhone,
                bodyText,
              );
            }
          } else {
            // Flow was sent recently (within cooldown) — send a short nudge instead
            const nudgeText = `👆 We already sent you the order form just a moment ago! Check your messages above to tap *${ctaLabel}*.`;
            await this.wabaService.sendTextMessage(
              tenant.whatsappPhoneNumberId,
              dto.buyerPhone,
              nudgeText,
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.warn(`WhatsApp auto-reply dispatch failed: ${message}`);
      }
    }

    // 8. Update ChatSession state (mark orderCompleted if final order confirmation)
    const isFinalOrder = !!dto.flowData?.order_ref;
    const updatedSession = await this.prisma.chatSession.update({
      where: { id: session.id },
      data: {
        lastIntent: classification.intent,
        orderCompleted: isFinalOrder ? true : session.orderCompleted,
        updatedAt: new Date(),
      },
    });

    return {
      session: updatedSession,
      message: buyerMessage,
      classification,
      systemResponse,
    };
  }

  /**
   * Generate an automated response for the buyer based on detected AI intent and tenant context.
   * Accepts the pre-fetched tenant (with products) to avoid a redundant DB query.
   */
  private async generateResponseForIntent(
    intent: BuyerIntent,
    tenantId: string,
    extractedEntities?: { productName?: string | null; quantity?: number | null },
    prefetchedTenant?: (Tenant & { products: Product[] }) | null,
  ): Promise<string> {
    const tenant =
      prefetchedTenant ??
      (await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        include: { products: true },
      }));

    const tenantName = tenant?.name || 'our store';
    const products = tenant?.products || [];

    switch (intent) {
      case BuyerIntent.GREETING:
        return `Hi 👋 What would you like to do today?`;

      case BuyerIntent.VIEW_CATALOG: {
        if (products.length === 0) {
          return `🏪 Welcome to *${tenantName}*! Our catalog is currently empty. Please check back soon!`;
        }
        const inStock = products.filter((p) => p.inStock);
        const outOfStock = products.filter((p) => !p.inStock);
        const productList = inStock
          .map((p) => `${p.image ?? '🛒'} *${p.name}*\n   💰 GH₵${p.price.toFixed(2)}`)
          .join('\n\n');
        const outList = outOfStock.length > 0
          ? `\n\n❌ *Currently Out of Stock:*\n` + outOfStock.map((p) => `${p.image ?? '🛒'} ${p.name}`).join('\n')
          : '';
        return `🛍️ *${tenantName} — Product Catalog*\n\n${productList}${outList}\n\n_Reply with a product name to order or ask about it!_`;
      }

      case BuyerIntent.PRODUCT_INQUIRY:
        if (extractedEntities?.productName) {
          const matched = products.find(
            (p) => p.name.toLowerCase().includes(extractedEntities.productName!.toLowerCase()),
          );
          if (matched) {
            const stockLabel = matched.inStock ? '✅ In Stock' : '❌ Out of Stock';
            return `${matched.image ?? '🛒'} *${matched.name}*\n💰 Price: GH₵${matched.price.toFixed(2)}\n📦 Status: ${stockLabel}\n\nWould you like to place an order? Just say _"I want to buy ${matched.name}"_`;
          }
        }
        return `🔍 We couldn't find that exact product. Reply *"view catalog"* to see all available items at *${tenantName}*!`;

      case BuyerIntent.STOCK_CHECK:
        if (extractedEntities?.productName) {
          const matched = products.find(
            (p) => p.name.toLowerCase().includes(extractedEntities.productName!.toLowerCase()),
          );
          if (matched) {
            return matched.inStock
              ? `✅ Yes! ${matched.image ?? ''} *${matched.name}* is currently in stock at GH₵${matched.price.toFixed(2)}.`
              : `❌ Sorry, ${matched.image ?? ''} *${matched.name}* is currently out of stock. Check back soon!`;
          }
        }
        const inStockCount = products.filter((p) => p.inStock).length;
        return `📦 We currently have *${inStockCount} items* in stock and ready to ship! Reply *"view catalog"* to see the full list.`;

      case BuyerIntent.ORDER_INTENT: {
        const qty = extractedEntities?.quantity || 1;
        if (extractedEntities?.productName) {
          const matched = products.find(
            (p) => p.name.toLowerCase().includes(extractedEntities.productName!.toLowerCase()),
          );
          if (matched) {
            if (!matched.inStock) {
              const inStockItems = products.filter((p) => p.inStock);
              const itemsList = inStockItems.length > 0
                ? '\n\n📦 *Available Items in Stock:*\n' + inStockItems.map((p) => `• ${p.image ?? '🛒'} *${p.name}* — GH₵${p.price.toFixed(2)}`).join('\n')
                : '';
              return `❌ Sorry, ${matched.image ?? ''} *${matched.name}* is currently out of stock.${itemsList}\n\nReply with an item name to order!`;
            }
            const total = matched.price * qty;
            return `🛒 *Order Summary*\n\n${matched.image ?? '🛒'} *${matched.name}*\n   • Quantity: ${qty}\n   • Unit Price: GH₵${matched.price.toFixed(2)}\n   • *Total: GH₵${total.toFixed(2)}*\n\nReply *CONFIRM* to complete your purchase with *${tenantName}*! 🎉`;
          }
        }

        const availableProducts = products.filter((p) => p.inStock);
        if (availableProducts.length === 0) {
          return `🏪 Welcome to *${tenantName}*! We currently have no items in stock for ordering. Please check back later!`;
        }

        const itemsList = availableProducts
          .map(
            (p, index) =>
              `${index + 1}. ${p.image ?? '🛒'} *${p.name}*\n   💰 Price: GH₵${p.price.toFixed(2)}`,
          )
          .join('\n\n');

        return `🛒 *Place an Order — ${tenantName}*\n\nHere are the items available for purchase:\n\n${itemsList}\n\n👉 *To place your order*, reply with the product name and quantity (e.g., _"I want 2 ${availableProducts[0]?.name || 'items'}"_).`;
      }

      case BuyerIntent.HUMAN_SUPPORT:
        return `🤝 You've requested to speak with a representative from *${tenantName}*.\n\nA team member will join this chat shortly. Thank you for your patience! 🙏`;

      case BuyerIntent.OUT_OF_BOUNDS:
      default:
        return `👋 Thanks for reaching out to *${tenantName}*!\n\nI can help you with:\n🛍️ Browse catalog\n💬 Product inquiries\n📦 Place an order\n🤝 Talk to support\n\nWhat would you like to do?`;
    }
  }

  /**
   * Helper to resolve the authenticated vendor user's tenant.
   */
  private async getTenantForUser(userId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { userId },
    });
    if (!tenant) {
      throw new NotFoundException('You do not have a registered shop/tenant.');
    }
    return tenant;
  }

  /**
   * List all buyer chat sessions/conversations for the authenticated vendor's shop.
   * Includes latest message preview and associated orders count.
   */
  async getSessionsForVendor(
    userId: string,
    page = 1,
    limit = 20,
    search?: string,
  ) {
    const tenant = await this.getTenantForUser(userId);
    const skip = (Math.max(1, page) - 1) * limit;

    const whereClause: any = {
      tenantId: tenant.id,
      ...(search
        ? {
          buyerPhone: { contains: search, mode: 'insensitive' },
        }
        : {}),
    };

    const [total, sessions] = await Promise.all([
      this.prisma.chatSession.count({ where: whereClause }),
      this.prisma.chatSession.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1, // latest message preview
          },
          orders: {
            orderBy: { createdAt: 'desc' },
            include: {
              items: true,
            },
          },
          _count: {
            select: {
              messages: true,
              orders: true,
            },
          },
        },
      }),
    ]);

    const formattedSessions = sessions.map((session) => ({
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
    }));

    return {
      data: formattedSessions,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get complete conversation and all placed orders for a single buyer session.
   */
  async getSessionDetailForVendor(userId: string, sessionId: string) {
    const tenant = await this.getTenantForUser(userId);

    const session = await this.prisma.chatSession.findFirst({
      where: {
        id: sessionId,
        tenantId: tenant.id,
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
        orders: {
          orderBy: { createdAt: 'desc' },
          include: {
            items: true,
          },
        },
      },
    });

    if (!session) {
      throw new NotFoundException(
        `Conversation session "${sessionId}" not found for your shop.`,
      );
    }

    return session;
  }

  /**
   * Get full chat history for a buyer with a specific tenant.
   */
  async getSessionHistory(tenantId: string, buyerPhone: string) {
    const session = await this.prisma.chatSession.findFirst({
      where: {
        tenantId,
        buyerPhone,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!session) {
      throw new NotFoundException(
        `No chat history found for buyer "${buyerPhone}" with tenant "${tenantId}".`,
      );
    }

    return session;
  }

  /**
   * Format the final order confirmation receipt message sent on WhatsApp.
   * Includes order reference, itemized grocery breakdown with quantities and prices,
   * items subtotal, delivery fee (for delivery orders), delivery address, grand total,
   * and payment method instructions.
   */
  private formatOrderConfirmationMessage(
    orderRef: string,
    paymentMethod?: string,
    momoNumber?: string,
    buyerPhone?: string,
    order?: {
      totalAmount: number;
      notes?: string | null;
      items?: Array<{
        productName: string;
        quantity: number;
        unitPrice: number;
        totalPrice?: number;
      }>;
    } | null,
  ): string {
    const lines: string[] = [];

    lines.push(`🧾 *Order ${orderRef} placed successfully!*\n`);

    if (order?.items && order.items.length > 0) {
      lines.push('📦 *Items Ordered:*');
      let itemsSubtotal = 0;
      for (const item of order.items) {
        const itemTotal =
          item.totalPrice != null
            ? item.totalPrice
            : item.quantity * item.unitPrice;
        itemsSubtotal += itemTotal;
        lines.push(`• ${item.quantity}x ${item.productName} — GH₵${itemTotal.toFixed(2)}`);
      }
      lines.push('');

      // Check delivery details from order notes or difference
      let isDelivery = false;
      let deliveryFee = 0;
      let deliveryAddress: string | null = null;

      if (order.notes) {
        if (order.notes.includes('Fulfillment: Delivery')) {
          isDelivery = true;
          const addrMatch = order.notes.match(/Address:\s*([^|]+)/i);
          if (addrMatch) {
            deliveryAddress = addrMatch[1].trim();
          }
        }
        const feeMatch = order.notes.match(/Delivery Fee:\s*₵?([0-9.]+)/i);
        if (feeMatch) {
          deliveryFee = parseFloat(feeMatch[1]);
        }
      }

      // If delivery fee wasn't explicitly found in notes, check if total exceeds items subtotal
      if (!deliveryFee && order.totalAmount > itemsSubtotal) {
        const diff = Number((order.totalAmount - itemsSubtotal).toFixed(2));
        if (diff > 0.01) {
          deliveryFee = diff;
          isDelivery = true;
        }
      }

      if (deliveryFee > 0 || isDelivery) {
        lines.push(`🛒 *Items Subtotal:* GH₵${itemsSubtotal.toFixed(2)}`);
        lines.push(`🛵 *Delivery Fee:* GH₵${deliveryFee.toFixed(2)}`);
        lines.push(`💰 *Total Amount:* GH₵${order.totalAmount.toFixed(2)}`);
        if (deliveryAddress) {
          lines.push(`📍 *Delivery Address:* ${deliveryAddress}`);
        }
      } else if (order.notes?.includes('Fulfillment: Pickup')) {
        lines.push(`💰 *Total Amount:* GH₵${order.totalAmount.toFixed(2)}`);
        lines.push('🛍️ *Fulfillment:* Store Pickup (Free)');
      } else {
        lines.push(`💰 *Total Amount:* GH₵${order.totalAmount.toFixed(2)}`);
      }

      lines.push('');
    }

    if (paymentMethod === 'momo') {
      const phone = momoNumber || buyerPhone || '';
      lines.push(`💳 *Payment Method:* Mobile Money${phone ? ` (${phone})` : ''}`);
      lines.push(`\nPlease approve the MoMo prompt sent to ${phone}. Your groceries will be delivered today!`);
    } else if (paymentMethod === 'cod') {
      lines.push('💳 *Payment Method:* Cash on Delivery');
      lines.push('\nYour order has been confirmed for Cash on Delivery. Please have the exact amount ready upon delivery. Our rider will contact you on WhatsApp!');
    } else if (paymentMethod === 'card') {
      lines.push('💳 *Payment Method:* Card Payment');
      lines.push('\nWe will send you a secure payment link on WhatsApp shortly.');
    } else {
      lines.push('\nYour order has been confirmed! Our team will contact you on WhatsApp with updates.');
    }

    return lines.join('\n');
  }
}


