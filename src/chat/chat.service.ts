import { Injectable, NotFoundException } from '@nestjs/common';
import { BuyerIntent, MessageSender, MessageSource, Tenant, Product } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiClassifierService } from './ai-classifier.service.js';
import { ProcessMessageDto } from './dto/process-message.dto.js';
import { parseFlowToText } from './utils/flow-parser.util.js';
import { FlowService } from '../flow/flow.service.js';
import { WabaService } from '../waba/waba.service.js';
import { OrderService } from '../order/order.service.js';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiClassifierService: AiClassifierService,
    private readonly wabaService: WabaService,
    private readonly flowService: FlowService,
    private readonly orderService: OrderService,
  ) { }

  /**
   * Get an existing chat session or create a new one for a buyer-tenant pair.
   */
  async getOrCreateSession(tenantId: string, buyerPhone: string) {
    let session = await this.prisma.chatSession.findUnique({
      where: {
        tenantId_buyerPhone: {
          tenantId,
          buyerPhone,
        },
      },
    });

    if (!session) {
      session = await this.prisma.chatSession.create({
        data: {
          tenantId,
          buyerPhone,
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
        .catch(() => {});
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

    // 5b. Auto-create Order in DB if WhatsApp Flow cart submission payload exists
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

    // 6. Generate automated response based on classified intent
    const responseText = shopRequested
      ? 'Opening the product catalog.'
      : await this.generateResponseForIntent(
          classification.intent,
          dto.tenantId,
          classification.extractedEntities,
          tenant,
        );

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
        if (classification.intent === BuyerIntent.GREETING) {
          const flowId = process.env.META_FLOW_ID;
          if (flowId) {
            const firstScreen = process.env.META_FLOW_FIRST_SCREEN || 'PRODUCT_SELECT';
            const flowData = await this.flowService.buildFlowInitData(tenant.id);
            try {
              await this.wabaService.sendFlowMessage({
                phoneNumberId: tenant.whatsappPhoneNumberId,
                toPhone: dto.buyerPhone,
                flowId,
                flowToken: `${tenant.id}:${Date.now()}`,
                flowCta: 'Get started',
                screen: firstScreen,
                headerText: tenant.name,
                bodyText: 'Hi 👋 What would you like to do today?',
                data: flowData,
              });
            } catch (flowErr: any) {
              if (firstScreen !== 'PRODUCT_SELECT') {
                console.warn(
                  `Meta Flow screen "${firstScreen}" rejected by Meta. Falling back to "PRODUCT_SELECT": ${flowErr?.message || flowErr}`,
                );
                await this.wabaService.sendFlowMessage({
                  phoneNumberId: tenant.whatsappPhoneNumberId,
                  toPhone: dto.buyerPhone,
                  flowId,
                  flowToken: `${tenant.id}:${Date.now()}`,
                  flowCta: 'Get started',
                  screen: 'PRODUCT_SELECT',
                  headerText: tenant.name,
                  bodyText: 'Browse our products and place your order.',
                  data: flowData,
                });
              } else {
                throw flowErr;
              }
            }
          } else {
            await this.wabaService.sendWelcomeButtons(
              tenant.whatsappPhoneNumberId,
              dto.buyerPhone,
              tenant.name,
            );
          }
        } else if (shopRequested) {
          const flowId = process.env.META_FLOW_ID;
          if (!flowId) {
            throw new Error('META_FLOW_ID is not configured.');
          }

          const flowData = await this.flowService.buildFlowInitData(tenant.id);

          await this.wabaService.sendFlowMessage({
            phoneNumberId: tenant.whatsappPhoneNumberId,
            toPhone: dto.buyerPhone,
            flowId,
            flowToken: `${tenant.id}:${Date.now()}`,
            flowCta: 'Get started',
            screen: 'PRODUCT_SELECT',
            headerText: tenant.name,
            bodyText: 'Browse our products and place your order.',
            data: flowData,
          });
        } else {
          await this.wabaService.sendTextMessage(
            tenant.whatsappPhoneNumberId,
            dto.buyerPhone,
            responseText,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.warn(`WhatsApp auto-reply dispatch failed: ${message}`);
      }
    }

    // 8. Update ChatSession state
    const updatedSession = await this.prisma.chatSession.update({
      where: { id: session.id },
      data: {
        lastIntent: classification.intent,
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
   * Get full chat history for a buyer with a specific tenant.
   */
  async getSessionHistory(tenantId: string, buyerPhone: string) {
    const session = await this.prisma.chatSession.findUnique({
      where: {
        tenantId_buyerPhone: {
          tenantId,
          buyerPhone,
        },
      },
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
}
