import { Inject, Injectable, Logger, Optional, forwardRef } from '@nestjs/common';
import { OrderStatus, Product, Tenant } from '@prisma/client';
import { FlowService } from '../flow/flow.service.js';
import { OrderService } from '../order/order.service.js';
import { PaystackService } from '../payment/paystack.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WabaService } from '../waba/waba.service.js';

export interface CartItem {
  productId: string;
  productName: string;
  unitPrice: number;
  quantity: number;
}

export enum InteractiveStep {
  IDLE = 'IDLE',
  AWAITING_QUANTITY = 'AWAITING_QUANTITY',
  AWAITING_CUSTOM_QUANTITY = 'AWAITING_CUSTOM_QUANTITY',
  AWAITING_ADDRESS = 'AWAITING_ADDRESS',
  AWAITING_PAYMENT_METHOD = 'AWAITING_PAYMENT_METHOD',
  AWAITING_MOMO_NETWORK = 'AWAITING_MOMO_NETWORK',
  AWAITING_MOMO_NUMBER = 'AWAITING_MOMO_NUMBER',
}

export interface CartSessionState {
  step: InteractiveStep;
  page: number;
  items: CartItem[];
  pendingProduct?: { id: string; name: string; price: number };
  fulfillment?: 'delivery' | 'pickup';
  deliveryAddress?: string;
  momoNetwork?: string;
  momoNumber?: string;
  lastActive: number;
}

@Injectable()
export class InteractiveOrderService {
  private readonly logger = new Logger(InteractiveOrderService.name);
  private readonly cartSessions = new Map<string, CartSessionState>();
  private readonly sessionTtlMs = 30 * 60 * 1000; // 30 minutes
  private readonly pageSize = 8; // Max 8 products + 2 nav rows = 10 rows (WhatsApp list limit)

  constructor(
    private readonly prisma: PrismaService,
    private readonly wabaService: WabaService,
    private readonly orderService: OrderService,
    private readonly paystackService: PaystackService,
    @Optional()
    @Inject(forwardRef(() => FlowService))
    private readonly flowService?: FlowService,
  ) {}

  /**
   * Returns true if the buyer does not have a standard phone number (e.g. Meta BSUID like GH.989894404158856).
   */
  isBuyerWithoutPhoneNumber(buyerPhone: string): boolean {
    if (!buyerPhone) return true;
    const trimmed = buyerPhone.trim();
    // BSUID format starts with 2-letter country code and dot (e.g. GH.123456) or has non-numeric letters
    return /^[A-Za-z]{2}\./.test(trimmed) || /[A-Za-z]/.test(trimmed);
  }

  private getSessionKey(tenantId: string, buyerPhone: string): string {
    return `${tenantId}:${buyerPhone}`;
  }

  private getOrCreateState(tenantId: string, buyerPhone: string): CartSessionState {
    const key = this.getSessionKey(tenantId, buyerPhone);
    const existing = this.cartSessions.get(key);

    if (existing && Date.now() - existing.lastActive < this.sessionTtlMs) {
      existing.lastActive = Date.now();
      return existing;
    }

    const newState: CartSessionState = {
      step: InteractiveStep.IDLE,
      page: 1,
      items: [],
      lastActive: Date.now(),
    };
    this.cartSessions.set(key, newState);
    return newState;
  }

  private clearState(tenantId: string, buyerPhone: string) {
    this.cartSessions.delete(this.getSessionKey(tenantId, buyerPhone));
  }

  /**
   * Dedicated entry point for buyers with hidden phone numbers (BSUID).
   * Drives the interactive conversation using WhatsApp list messages and reply buttons.
   */
  async handleHiddenNumberBuyerInteraction(options: {
    tenant: Tenant & { products?: Product[] };
    buyerPhone: string;
    sessionId: string;
    messageText: string;
  }): Promise<boolean> {
    const { tenant, buyerPhone, sessionId, messageText } = options;
    const phoneNumberId = tenant.whatsappPhoneNumberId;

    this.logger.log(`[InteractiveOrder] Entry — buyerPhone: "${buyerPhone}", tenantId: ${tenant.id}, phoneNumberId: "${phoneNumberId}", text: "${messageText}"`);

    if (!phoneNumberId) {
      this.logger.error(`[InteractiveOrder] Cannot dispatch: tenant "${tenant.name}" (${tenant.id}) has no whatsappPhoneNumberId. Complete WhatsApp onboarding first.`);
      return false;
    }

    const trimmedText = (messageText || '').trim();
    const state = this.getOrCreateState(tenant.id, buyerPhone);

    this.logger.log(
      `Handling hidden-number buyer [${buyerPhone}] at step [${state.step}] with text: "${trimmedText}"`,
    );

    // 1. Pagination navigation: pg:<pageNumber> or text commands like "next", "more", "prev"
    if (trimmedText.startsWith('pg:') || trimmedText.toLowerCase() === 'more' || trimmedText.toLowerCase() === 'next') {
      if (trimmedText.startsWith('pg:')) {
        const targetPage = parseInt(trimmedText.replace('pg:', ''), 10);
        if (!isNaN(targetPage) && targetPage > 0) state.page = targetPage;
      } else {
        state.page = (state.page || 1) + 1;
      }
      await this.sendProductList(tenant, buyerPhone, state.page);
      return true;
    }

    if (trimmedText.toLowerCase() === 'prev' || trimmedText.toLowerCase() === 'previous' || trimmedText.toLowerCase() === 'back') {
      state.page = Math.max(1, (state.page || 1) - 1);
      await this.sendProductList(tenant, buyerPhone, state.page);
      return true;
    }

    // 2. Product selection from list (via p:<id> or via typing the item number e.g. "1", "2")
    let selectedProductId: string | null = null;

    if (trimmedText.startsWith('p:')) {
      selectedProductId = trimmedText.replace('p:', '').trim();
    } else {
      const numericChoice = parseInt(trimmedText, 10);
      if (!isNaN(numericChoice) && state.step === InteractiveStep.IDLE) {
        // Fetch current page products to map the chosen number
        const page = state.page || 1;
        const productsOnPage = await this.prisma.product.findMany({
          where: { tenantId: tenant.id, inStock: true },
          skip: (page - 1) * this.pageSize,
          take: this.pageSize,
          orderBy: { name: 'asc' },
        });

        if (numericChoice >= 1 && numericChoice <= productsOnPage.length) {
          selectedProductId = productsOnPage[numericChoice - 1].id;
        }
      }
    }

    if (selectedProductId) {
      const product = await this.prisma.product.findUnique({
        where: { id: selectedProductId },
      });

      if (product) {
        state.pendingProduct = {
          id: product.id,
          name: product.name,
          price: product.price,
        };
        state.step = InteractiveStep.AWAITING_QUANTITY;

        // Try interactive buttons first; if client doesn't support them, fallback to text prompt
        try {
          await this.wabaService.sendInteractiveButtons({
            phoneNumberId,
            toPhone: buyerPhone,
            bodyText: `How many ${product.name}?\n₵${product.price.toFixed(2)}`,
            buttons: [
              { id: 'q:1', title: '1' },
              { id: 'q:2', title: '2' },
              { id: 'q:other', title: 'Other' },
            ],
          });
        } catch {
          await this.wabaService.sendTextMessage(
            phoneNumberId,
            buyerPhone,
            `How many ${product.name}? (₵${product.price.toFixed(2)})\nReply with 1, 2, or type any quantity:`,
          );
        }
        return true;
      }
    }

    // 3. Quantity selection: via buttons (q:1, q:2, q:other) or typing a number
    if (trimmedText === 'q:1' || trimmedText === 'q:2' || (state.step === InteractiveStep.AWAITING_QUANTITY && !isNaN(parseFloat(trimmedText)) && parseFloat(trimmedText) > 0)) {
      const qty = trimmedText.startsWith('q:')
        ? parseInt(trimmedText.replace('q:', ''), 10)
        : parseFloat(trimmedText);

      if (state.pendingProduct) {
        this.addItemToCart(state, state.pendingProduct, qty);
        state.pendingProduct = undefined;
        state.step = InteractiveStep.IDLE;
        await this.sendAddedConfirmation(tenant, buyerPhone, state);
        return true;
      }
    }

    if (trimmedText === 'q:other') {
      state.step = InteractiveStep.AWAITING_CUSTOM_QUANTITY;
      await this.wabaService.sendTextMessage(
        phoneNumberId,
        buyerPhone,
        'Type the amount (e.g. 2.5)',
      );
      return true;
    }

    // 4. Custom quantity input
    if (state.step === InteractiveStep.AWAITING_CUSTOM_QUANTITY) {
      const parsedQty = parseFloat(trimmedText);
      if (!isNaN(parsedQty) && parsedQty > 0 && state.pendingProduct) {
        this.addItemToCart(state, state.pendingProduct, parsedQty);
        state.pendingProduct = undefined;
        state.step = InteractiveStep.IDLE;
        await this.sendAddedConfirmation(tenant, buyerPhone, state);
        return true;
      } else {
        await this.wabaService.sendTextMessage(
          phoneNumberId,
          buyerPhone,
          'Please enter a valid positive number for the amount (e.g. 3 or 1.5):',
        );
        return true;
      }
    }

    // 5. Add more items
    if (trimmedText === 'add' || trimmedText === '➕ Add more') {
      await this.sendProductList(tenant, buyerPhone, state.page);
      return true;
    }

    // 6. Review order summary
    if (trimmedText === 'review' || trimmedText === '✅ Review') {
      if (state.items.length === 0) {
        await this.wabaService.sendTextMessage(
          phoneNumberId,
          buyerPhone,
          'Your cart is currently empty. Tap below to choose items to purchase!',
        );
        await this.sendProductList(tenant, buyerPhone, 1);
        return true;
      }
      await this.sendOrderReview(tenant, buyerPhone, state);
      return true;
    }

    // 7. Edit order
    if (trimmedText === 'edit' || trimmedText === '✏️ Edit') {
      state.items = [];
      state.step = InteractiveStep.IDLE;
      await this.wabaService.sendTextMessage(
        phoneNumberId,
        buyerPhone,
        'Cart cleared! Let\'s pick your items again:',
      );
      await this.sendProductList(tenant, buyerPhone, 1);
      return true;
    }

    // 8. Fulfillment selection: Delivery or Pickup
    const lowerText = trimmedText.toLowerCase();
    if (trimmedText === 'ful:delivery' || trimmedText === '🛵 Delivery' || lowerText === 'delivery') {
      state.fulfillment = 'delivery';
      state.step = InteractiveStep.AWAITING_ADDRESS;
      await this.wabaService.sendTextMessage(
        phoneNumberId,
        buyerPhone,
        '📍 Send your delivery address and reachable phone number for the rider',
      );
      return true;
    }

    if (trimmedText === 'ful:pickup' || trimmedText === '🏪 Pickup' || lowerText === 'pickup') {
      state.fulfillment = 'pickup';
      state.step = InteractiveStep.AWAITING_PAYMENT_METHOD;
      await this.sendPaymentMethodOptions(tenant, buyerPhone, state);
      return true;
    }

    // 9. Delivery address received
    if (state.step === InteractiveStep.AWAITING_ADDRESS) {
      state.deliveryAddress = trimmedText;
      state.step = InteractiveStep.AWAITING_PAYMENT_METHOD;
      await this.sendPaymentMethodOptions(tenant, buyerPhone, state);
      return true;
    }

    // 10. Payment method selection
    if (trimmedText === 'pay:momo' || trimmedText === '📱 MoMo' || lowerText === 'momo') {
      state.step = InteractiveStep.AWAITING_MOMO_NETWORK;
      try {
        await this.wabaService.sendInteractiveButtons({
          phoneNumberId,
          toPhone: buyerPhone,
          bodyText: 'Choose your network:',
          buttons: [
            { id: 'net:mtn', title: 'MTN MoMo' },
            { id: 'net:telecel', title: 'Telecel Cash' },
            { id: 'net:airteltigo', title: 'AirtelTigo' },
          ],
        });
      } catch {
        await this.wabaService.sendTextMessage(
          phoneNumberId,
          buyerPhone,
          'Choose your mobile money network:\n• Reply *mtn* for MTN MoMo\n• Reply *telecel* for Telecel Cash\n• Reply *airteltigo* for AirtelTigo',
        );
      }
      return true;
    }

    if (trimmedText === 'pay:card' || trimmedText === '💳 Card' || lowerText === 'card') {
      await this.handleCardCheckout(tenant, buyerPhone, sessionId, state);
      return true;
    }

    if (trimmedText === 'pay:cod' || trimmedText === '💵 On delivery' || lowerText === 'cod' || lowerText === 'cash') {
      await this.handleCodCheckout(tenant, buyerPhone, sessionId, state);
      return true;
    }

    // 11. MoMo Network chosen
    if (
      trimmedText === 'net:mtn' ||
      trimmedText === 'net:telecel' ||
      trimmedText === 'net:airteltigo' ||
      lowerText === 'mtn' ||
      lowerText === 'telecel' ||
      lowerText === 'airteltigo'
    ) {
      state.momoNetwork = trimmedText.replace('net:', '').toLowerCase();
      state.step = InteractiveStep.AWAITING_MOMO_NUMBER;
      await this.wabaService.sendTextMessage(
        phoneNumberId,
        buyerPhone,
        'Enter your MoMo number (e.g. 0241234567)',
      );
      return true;
    }

    // 12. MoMo phone number received -> Place order & trigger Paystack charge
    if (state.step === InteractiveStep.AWAITING_MOMO_NUMBER) {
      const cleanPhone = trimmedText.replace(/[^\d+]/g, '');
      if (cleanPhone.length >= 9) {
        state.momoNumber = cleanPhone;
        await this.handleMoMoCheckout(tenant, buyerPhone, sessionId, state);
        return true;
      } else {
        await this.wabaService.sendTextMessage(
          phoneNumberId,
          buyerPhone,
          'Please enter a valid 10-digit mobile money number (e.g. 0241234567):',
        );
        return true;
      }
    }

    // 13. Dispatch WhatsApp Flow directly to hidden-number buyer (using recipient field)
    this.logger.log(`[InteractiveOrder] Dispatching flow message to hidden-number buyer "${buyerPhone}"`);
    try {
      const flowId = process.env.META_FLOW_ID;
      const firstScreen = process.env.META_FLOW_FIRST_SCREEN || 'PRODUCT_SELECT';
      const flowData = this.flowService
        ? await this.flowService.buildFlowInitData(tenant.id, firstScreen)
        : undefined;

      await this.wabaService.sendRequestContactInfo({
        phoneNumberId,
        toPhone: buyerPhone,
        flowId,
        flowToken: `${tenant.id}:${buyerPhone}:${Date.now()}`,
        flowCta: 'Browse & Order',
        screen: firstScreen,
        headerText: tenant.name,
        bodyText: `Welcome to *${tenant.name || 'our store'}*! 👋\n\nTap below to open our interactive catalog and order items directly:`,
        data: flowData,
      });
      return true;
    } catch (err) {
      this.logger.warn(`Failed to dispatch flow to hidden-number buyer, falling back to text catalog: ${err}`);
      await this.sendProductList(tenant, buyerPhone, 1);
      return true;
    }
  }

  private addItemToCart(
    state: CartSessionState,
    product: { id: string; name: string; price: number },
    quantity: number,
  ) {
    const existingIndex = state.items.findIndex((i) => i.productId === product.id);
    if (existingIndex > -1) {
      state.items[existingIndex].quantity += quantity;
    } else {
      state.items.push({
        productId: product.id,
        productName: product.name,
        unitPrice: product.price,
        quantity,
      });
    }
  }

  private async sendProductList(
    tenant: Tenant,
    buyerPhone: string,
    page: number,
  ) {
    const phoneNumberId = tenant.whatsappPhoneNumberId;
    if (!phoneNumberId) {
      this.logger.error(`[InteractiveOrder] sendProductList: no phoneNumberId for tenant ${tenant.id}`);
      return;
    }

    this.logger.log(`[InteractiveOrder] Sending text catalog page ${page} to "${buyerPhone}"`);
    const totalProducts = await this.prisma.product.count({
      where: { tenantId: tenant.id, inStock: true },
    });

    const totalPages = Math.max(1, Math.ceil(totalProducts / this.pageSize));
    const currentPage = Math.min(Math.max(1, page), totalPages);

    const products = await this.prisma.product.findMany({
      where: { tenantId: tenant.id, inStock: true },
      skip: (currentPage - 1) * this.pageSize,
      take: this.pageSize,
      orderBy: { name: 'asc' },
    });

    if (products.length === 0) {
      await this.wabaService.sendTextMessage(
        phoneNumberId,
        buyerPhone,
        `Welcome to ${tenant.name || 'our store'}! 👋\nCurrently, there are no products in stock. Please check back later!`,
      );
      return;
    }

    // Build friendly numbered text catalog
    let catalogText = `🛍️ *${tenant.name || 'Marketix Store'}* (Page ${currentPage}/${totalPages})\n\n`;
    products.forEach((p, idx) => {
      catalogText += `*${idx + 1}*. ${p.name} — ₵${p.price.toFixed(2)}\n`;
    });

    catalogText += `\n💬 *Reply with the number (e.g. 1) to select an item.*`;

    if (currentPage < totalPages) {
      catalogText += `\n▶️ Type *more* to view next page`;
    }
    if (currentPage > 1) {
      catalogText += `\n◀️ Type *prev* to view previous page`;
    }

    // Send as reliable text message (which Meta guarantees delivery for BSUID)
    await this.wabaService.sendTextMessage(phoneNumberId, buyerPhone, catalogText);
  }

  private async sendAddedConfirmation(
    tenant: Tenant,
    buyerPhone: string,
    state: CartSessionState,
  ) {
    const phoneNumberId = tenant.whatsappPhoneNumberId;
    if (!phoneNumberId) return;

    const totalItemsCount = state.items.reduce(
      (sum, i) => sum + (Number.isInteger(i.quantity) ? i.quantity : 1),
      0,
    );
    const subtotal = state.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);

    // Try interactive buttons first; fallback to text if recipient client rejects buttons
    try {
      await this.wabaService.sendInteractiveButtons({
        phoneNumberId,
        toPhone: buyerPhone,
        bodyText: `Added ✅ (${totalItemsCount} items, ₵${subtotal.toFixed(2)})\n\nWhat would you like to do?`,
        buttons: [
          { id: 'add', title: '➕ Add more' },
          { id: 'review', title: '✅ Review' },
        ],
      });
    } catch {
      await this.wabaService.sendTextMessage(
        phoneNumberId,
        buyerPhone,
        `Added ✅ (${totalItemsCount} items, Subtotal: ₵${subtotal.toFixed(2)})\n\nReply with:\n• *add* — Add more products\n• *review* — Review order and checkout`,
      );
    }
  }

  private async sendOrderReview(
    tenant: Tenant,
    buyerPhone: string,
    state: CartSessionState,
  ) {
    const phoneNumberId = tenant.whatsappPhoneNumberId;
    if (!phoneNumberId) return;

    let total = 0;
    const summaryLines = state.items
      .map((i) => {
        const itemTotal = i.unitPrice * i.quantity;
        total += itemTotal;
        return `• ${i.productName} x ${i.quantity} = ₵${itemTotal.toFixed(2)}`;
      })
      .join('\n');

    try {
      await this.wabaService.sendInteractiveButtons({
        phoneNumberId,
        toPhone: buyerPhone,
        bodyText: `🧾 *Review your order*\n\n${summaryLines}\n\n💰 *Total: ₵${total.toFixed(2)}*\n\nSelect fulfillment:`,
        buttons: [
          { id: 'ful:delivery', title: '🛵 Delivery' },
          { id: 'ful:pickup', title: '🏪 Pickup' },
          { id: 'edit', title: '✏️ Edit' },
        ],
      });
    } catch {
      await this.wabaService.sendTextMessage(
        phoneNumberId,
        buyerPhone,
        `🧾 *Review your order*\n\n${summaryLines}\n\n💰 *Total: ₵${total.toFixed(2)}*\n\nReply with:\n• *delivery* — 🛵 Delivery\n• *pickup* — 🏪 Store Pickup\n• *edit* — Clear and re-pick`,
      );
    }
  }

  private async sendPaymentMethodOptions(
    tenant: Tenant,
    buyerPhone: string,
    state: CartSessionState,
  ) {
    const phoneNumberId = tenant.whatsappPhoneNumberId;
    if (!phoneNumberId) return;

    const total = state.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);

    try {
      await this.wabaService.sendInteractiveButtons({
        phoneNumberId,
        toPhone: buyerPhone,
        bodyText: `💳 *Total: ₵${total.toFixed(2)}*\nHow would you like to pay?`,
        buttons: [
          { id: 'pay:momo', title: '📱 MoMo' },
          { id: 'pay:card', title: '💳 Card' },
          { id: 'pay:cod', title: '💵 On delivery' },
        ],
      });
    } catch {
      await this.wabaService.sendTextMessage(
        phoneNumberId,
        buyerPhone,
        `💳 *Total: ₵${total.toFixed(2)}*\nHow would you like to pay?\n\nReply with:\n• *momo* — Mobile Money\n• *card* — Debit/Credit Card\n• *cod* — Cash on Delivery`,
      );
    }
  }

  private async handleMoMoCheckout(
    tenant: Tenant,
    buyerPhone: string,
    sessionId: string,
    state: CartSessionState,
  ) {
    const phoneNumberId = tenant.whatsappPhoneNumberId!;
    const totalAmount = state.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);

    const notes = [
      `Fulfillment: ${state.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}`,
      state.deliveryAddress ? `Address: ${state.deliveryAddress}` : null,
      `MoMo: ${state.momoNetwork?.toUpperCase() || 'MoMo'} (${state.momoNumber})`,
    ]
      .filter(Boolean)
      .join(' | ');

    // Create Order in DB
    const order = await this.orderService.createOrder(tenant.id, {
      buyerPhone: state.momoNumber || buyerPhone,
      sessionId,
      status: OrderStatus.AWAITING_PAYMENT,
      notes,
      items: state.items.map((i) => ({
        productId: i.productId,
        productName: i.productName,
        unitPrice: i.unitPrice,
        quantity: Math.max(1, Math.round(i.quantity)),
      })),
    });

    // Trigger Paystack MoMo prompt push
    this.paystackService
      .initiateMoMoCharge({
        amount: totalAmount,
        momoNumber: state.momoNumber!,
        provider: state.momoNetwork || 'mtn',
        reference: order.orderNumber,
        email: 'customer@orders.marketix.app',
        metadata: {
          tenantId: tenant.id,
          buyerPhone,
          orderId: order.id,
        },
      })
      .catch((err) => {
        this.logger.error(`Paystack MoMo charge initiation failed: ${err.message || err}`);
      });

    // Send confirmation to WhatsApp user
    await this.wabaService.sendTextMessage(
      phoneNumberId,
      buyerPhone,
      `🎉 Order placed. Approve the payment prompt on your phone.\n\nOrder ref: ${order.orderNumber}`,
    );

    this.clearState(tenant.id, buyerPhone);
  }

  private async handleCardCheckout(
    tenant: Tenant,
    buyerPhone: string,
    sessionId: string,
    state: CartSessionState,
  ) {
    const phoneNumberId = tenant.whatsappPhoneNumberId!;
    const totalAmount = state.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);

    const notes = [
      `Fulfillment: ${state.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}`,
      state.deliveryAddress ? `Address: ${state.deliveryAddress}` : null,
      'Payment: Card (Paystack)',
    ]
      .filter(Boolean)
      .join(' | ');

    const order = await this.orderService.createOrder(tenant.id, {
      buyerPhone,
      sessionId,
      status: OrderStatus.AWAITING_PAYMENT,
      notes,
      items: state.items.map((i) => ({
        productId: i.productId,
        productName: i.productName,
        unitPrice: i.unitPrice,
        quantity: Math.max(1, Math.round(i.quantity)),
      })),
    });

    const cardRes = await this.paystackService.initializeCardPayment({
      amount: totalAmount,
      email: 'customer@orders.marketix.app',
      reference: order.orderNumber,
    });

    const paymentUrl = cardRes.authorizationUrl || `https://checkout.paystack.com/${order.orderNumber}`;

    await this.wabaService.sendInteractiveCtaUrl({
      phoneNumberId,
      toPhone: buyerPhone,
      bodyText: `Tap below to pay ₵${totalAmount.toFixed(2)} securely for order ${order.orderNumber}.`,
      displayText: 'Pay now',
      url: paymentUrl,
    });

    this.clearState(tenant.id, buyerPhone);
  }

  private async handleCodCheckout(
    tenant: Tenant,
    buyerPhone: string,
    sessionId: string,
    state: CartSessionState,
  ) {
    const phoneNumberId = tenant.whatsappPhoneNumberId!;

    const notes = [
      `Fulfillment: ${state.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}`,
      state.deliveryAddress ? `Address: ${state.deliveryAddress}` : null,
      'Payment: Cash on Delivery',
    ]
      .filter(Boolean)
      .join(' | ');

    const order = await this.orderService.createOrder(tenant.id, {
      buyerPhone,
      sessionId,
      status: OrderStatus.CONFIRMED,
      notes,
      items: state.items.map((i) => ({
        productId: i.productId,
        productName: i.productName,
        unitPrice: i.unitPrice,
        quantity: Math.max(1, Math.round(i.quantity)),
      })),
    });

    await this.wabaService.sendTextMessage(
      phoneNumberId,
      buyerPhone,
      `🎉 Order placed successfully!\n\nOrder ref: ${order.orderNumber}\nPayment: Cash on Delivery\nWe will prepare your order for delivery.`,
    );

    this.clearState(tenant.id, buyerPhone);
  }
}
