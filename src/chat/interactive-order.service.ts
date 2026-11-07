import { Injectable, Logger } from '@nestjs/common';
import { Fulfillment, OrderStatus, PaymentMethod, Tenant } from '@prisma/client';
import { cedis } from '../common/money.util.js';
import { toGhanaLocal } from '../common/phone.util.js';
import { FlowService } from '../flow/flow.service.js';
import { CreateOrderItemDto } from '../order/dto/create-order.dto.js';
import { formatOrderReceipt } from '../order/order-receipt.js';
import { lineTotal, MAX_ITEM_QUANTITY, orderTotals } from '../order/order-totals.util.js';
import { OrderService } from '../order/order.service.js';
import { DEFAULT_CUSTOMER_EMAIL, PaystackService } from '../payment/paystack.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReplyButton, WabaService } from '../waba/waba.service.js';

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
  items: CreateOrderItemDto[];
  pendingProduct?: { id: string; name: string; price: number };
  fulfillment?: Fulfillment;
  deliveryAddress?: string;
  momoNetwork?: string;
  momoNumber?: string;
  lastActive: number;
}

/** Everything a step handler needs about the current conversation. */
interface Conversation {
  tenant: Tenant;
  buyerPhone: string;
  sessionId: string;
  phoneNumberId: string;
  state: CartSessionState;
  text: string;
  lower: string;
}

const SESSION_TTL_MS = 30 * 60 * 1000;
const PAGE_SIZE = 8;

const ADD_MORE = 'add';
const REVIEW = 'review';
const EDIT = 'edit';

const MOMO_NETWORK_BUTTONS: ReplyButton[] = [
  { id: 'net:mtn', title: 'MTN MoMo' },
  { id: 'net:telecel', title: 'Telecel Cash' },
  { id: 'net:airteltigo', title: 'AirtelTigo' },
];

/**
 * Text-and-button ordering assistant for buyers whose number is hidden (BSUID),
 * where WhatsApp Flows may not be deliverable.
 */
@Injectable()
export class InteractiveOrderService {
  private readonly logger = new Logger(InteractiveOrderService.name);
  private readonly cartSessions = new Map<string, CartSessionState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly wabaService: WabaService,
    private readonly orderService: OrderService,
    private readonly paystackService: PaystackService,
    private readonly flowService: FlowService,
  ) {}

  async handleHiddenNumberBuyerInteraction(options: {
    tenant: Tenant;
    buyerPhone: string;
    sessionId: string;
    messageText: string;
  }): Promise<boolean> {
    const { tenant, buyerPhone, sessionId } = options;
    if (!tenant.whatsappPhoneNumberId) {
      this.logger.error(`Tenant "${tenant.name}" (${tenant.id}) has no whatsappPhoneNumberId; cannot reply.`);
      return false;
    }

    const text = (options.messageText || '').trim();
    const convo: Conversation = {
      tenant,
      buyerPhone,
      sessionId,
      phoneNumberId: tenant.whatsappPhoneNumberId,
      state: this.getOrCreateState(tenant.id, buyerPhone),
      text,
      lower: text.toLowerCase(),
    };

    this.logger.log(`[Interactive] ${buyerPhone} at ${convo.state.step}: "${text}"`);

    const handlers: Array<(c: Conversation) => Promise<boolean>> = [
      this.handlePagination,
      this.handleProductSelection,
      this.handleQuantity,
      this.handleCartActions,
      this.handleFulfillment,
      this.handleAddress,
      this.handlePaymentMethod,
      this.handleMomoNetwork,
      this.handleMomoNumber,
    ];
    for (const handler of handlers) {
      if (await handler.call(this, convo)) return true;
    }

    return this.sendCatalogEntry(convo);
  }

  // ───────────────────────── Step handlers ─────────────────────────

  private async handlePagination(c: Conversation): Promise<boolean> {
    if (c.text.startsWith('pg:') || c.lower === 'more' || c.lower === 'next') {
      const target = c.text.startsWith('pg:') ? parseInt(c.text.slice(3), 10) : c.state.page + 1;
      c.state.page = Number.isFinite(target) && target > 0 ? target : c.state.page;
      await this.sendProductList(c, c.state.page);
      return true;
    }
    if (['prev', 'previous', 'back'].includes(c.lower)) {
      c.state.page = Math.max(1, c.state.page - 1);
      await this.sendProductList(c, c.state.page);
      return true;
    }
    return false;
  }

  private async handleProductSelection(c: Conversation): Promise<boolean> {
    let productId: string | null = null;

    if (c.text.startsWith('p:')) {
      productId = c.text.slice(2).trim();
    } else if (c.state.step === InteractiveStep.IDLE && /^\d+$/.test(c.text)) {
      const choice = parseInt(c.text, 10);
      const products = await this.productsOnPage(c.tenant.id, c.state.page);
      if (choice >= 1 && choice <= products.length) {
        productId = products[choice - 1].id;
      }
    }
    if (!productId) return false;

    const product = await this.prisma.product.findFirst({ where: { id: productId, tenantId: c.tenant.id, inStock: true } });
    if (!product) return false;

    c.state.pendingProduct = { id: product.id, name: product.name, price: product.price };
    c.state.step = InteractiveStep.AWAITING_QUANTITY;
    await this.sendButtons(
      c,
      `How many ${product.name}?\n${cedis(product.price)}`,
      [
        { id: 'q:1', title: '1' },
        { id: 'q:2', title: '2' },
        { id: 'q:other', title: 'Other' },
      ],
      `How many ${product.name}? (${cedis(product.price)})\nReply with 1, 2, or type any quantity:`,
    );
    return true;
  }

  private async handleQuantity(c: Conversation): Promise<boolean> {
    const { state } = c;

    if (c.text === 'q:other') {
      state.step = InteractiveStep.AWAITING_CUSTOM_QUANTITY;
      await this.sendText(c, `Type how many, from 1 to ${MAX_ITEM_QUANTITY}:`);
      return true;
    }

    const awaitingQuantity =
      state.step === InteractiveStep.AWAITING_QUANTITY || state.step === InteractiveStep.AWAITING_CUSTOM_QUANTITY;
    const raw = c.text.startsWith('q:') ? c.text.slice(2) : awaitingQuantity ? c.text.trim() : '';
    // Whole numbers only, so the total shown is the total charged (orders store whole quantities).
    const quantity = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) {
      if (state.step === InteractiveStep.AWAITING_CUSTOM_QUANTITY) {
        await this.sendText(c, `Please type a whole number from 1 to ${MAX_ITEM_QUANTITY}:`);
        return true;
      }
      return false;
    }
    if (!state.pendingProduct) return false;

    const { pendingProduct } = state;
    const existing = state.items.find((i) => i.productId === pendingProduct.id);
    if (existing) {
      existing.quantity = Math.min(MAX_ITEM_QUANTITY, existing.quantity + quantity);
    } else {
      state.items.push({ productId: pendingProduct.id, productName: pendingProduct.name, unitPrice: pendingProduct.price, quantity });
    }
    state.pendingProduct = undefined;
    state.step = InteractiveStep.IDLE;

    const { subtotal } = orderTotals(state.items);
    const count = state.items.reduce((sum, i) => sum + (Number.isInteger(i.quantity) ? i.quantity : 1), 0);
    await this.sendButtons(
      c,
      `Added ✅ (${count} items, ${cedis(subtotal)})\n\nWhat would you like to do?`,
      [
        { id: ADD_MORE, title: '➕ Add more' },
        { id: REVIEW, title: '✅ Review' },
      ],
      `Added ✅ (${count} items, Subtotal: ${cedis(subtotal)})\n\nReply with:\n• *add* — Add more products\n• *review* — Review order and checkout`,
    );
    return true;
  }

  private async handleCartActions(c: Conversation): Promise<boolean> {
    if (c.text === ADD_MORE || c.text === '➕ Add more') {
      await this.sendProductList(c, c.state.page);
      return true;
    }

    if (c.text === REVIEW || c.text === '✅ Review') {
      if (c.state.items.length === 0) {
        await this.sendText(c, 'Your cart is currently empty. Pick the items you would like to buy:');
        await this.sendProductList(c, 1);
        return true;
      }
      const summary = c.state.items.map((i) => `• ${i.productName} x ${i.quantity} = ${cedis(lineTotal(i))}`).join('\n');
      const { subtotal } = orderTotals(c.state.items);
      const header = `🧾 *Review your order*\n\n${summary}\n\n💰 *Total: ${cedis(subtotal)}*`;
      await this.sendButtons(
        c,
        `${header}\n\nSelect fulfillment:`,
        [
          { id: 'ful:delivery', title: '🛵 Delivery' },
          { id: 'ful:pickup', title: '🏪 Pickup' },
          { id: EDIT, title: '✏️ Edit' },
        ],
        `${header}\n\nReply with:\n• *delivery* — 🛵 Delivery\n• *pickup* — 🏪 Store Pickup\n• *edit* — Clear and re-pick`,
      );
      return true;
    }

    if (c.text === EDIT || c.text === '✏️ Edit') {
      c.state.items = [];
      c.state.step = InteractiveStep.IDLE;
      await this.sendText(c, "Cart cleared! Let's pick your items again:");
      await this.sendProductList(c, 1);
      return true;
    }

    return false;
  }

  private async handleFulfillment(c: Conversation): Promise<boolean> {
    if (c.text === 'ful:delivery' || c.text === '🛵 Delivery' || c.lower === 'delivery') {
      c.state.fulfillment = Fulfillment.DELIVERY;
      c.state.step = InteractiveStep.AWAITING_ADDRESS;
      await this.sendText(c, '📍 Send your delivery address and a reachable phone number for the rider');
      return true;
    }
    if (c.text === 'ful:pickup' || c.text === '🏪 Pickup' || c.lower === 'pickup') {
      c.state.fulfillment = Fulfillment.PICKUP;
      c.state.step = InteractiveStep.AWAITING_PAYMENT_METHOD;
      await this.sendPaymentMethodOptions(c);
      return true;
    }
    return false;
  }

  private async handleAddress(c: Conversation): Promise<boolean> {
    if (c.state.step !== InteractiveStep.AWAITING_ADDRESS) return false;
    c.state.deliveryAddress = c.text;
    c.state.step = InteractiveStep.AWAITING_PAYMENT_METHOD;
    await this.sendPaymentMethodOptions(c);
    return true;
  }

  private async handlePaymentMethod(c: Conversation): Promise<boolean> {
    if (c.text === 'pay:momo' || c.text === '📱 MoMo' || c.lower === 'momo') {
      c.state.step = InteractiveStep.AWAITING_MOMO_NETWORK;
      await this.sendButtons(
        c,
        'Choose your network:',
        MOMO_NETWORK_BUTTONS,
        'Choose your mobile money network:\n• Reply *mtn* for MTN MoMo\n• Reply *telecel* for Telecel Cash\n• Reply *airteltigo* for AirtelTigo',
      );
      return true;
    }
    if (c.text === 'pay:card' || c.text === '💳 Card' || c.lower === 'card') {
      await this.checkoutWithCard(c);
      return true;
    }
    if (c.text === 'pay:cod' || c.text === '💵 On delivery' || c.lower === 'cod' || c.lower === 'cash') {
      await this.checkoutCashOnDelivery(c);
      return true;
    }
    return false;
  }

  private async handleMomoNetwork(c: Conversation): Promise<boolean> {
    const network = c.text.startsWith('net:') ? c.text.slice(4).toLowerCase() : c.lower;
    if (!['mtn', 'telecel', 'airteltigo'].includes(network)) return false;
    c.state.momoNetwork = network;
    c.state.step = InteractiveStep.AWAITING_MOMO_NUMBER;
    await this.sendText(c, 'Enter your MoMo number (e.g. 0241234567)');
    return true;
  }

  private async handleMomoNumber(c: Conversation): Promise<boolean> {
    if (c.state.step !== InteractiveStep.AWAITING_MOMO_NUMBER) return false;
    const local = toGhanaLocal(c.text);
    if (local.length < 10) {
      await this.sendText(c, 'Please enter a valid 10-digit mobile money number (e.g. 0241234567):');
      return true;
    }
    c.state.momoNumber = local;
    await this.checkoutWithMomo(c);
    return true;
  }

  // ───────────────────────── Checkout ─────────────────────────

  private async placeOrder(c: Conversation, paymentMethod: PaymentMethod) {
    const { state, tenant } = c;
    const fulfillment = state.fulfillment ?? Fulfillment.PICKUP;
    return this.orderService.createOrder(tenant.id, {
      buyerPhone: c.buyerPhone,
      sessionId: c.sessionId,
      status: paymentMethod === PaymentMethod.COD ? OrderStatus.CONFIRMED : OrderStatus.AWAITING_PAYMENT,
      paymentMethod,
      paymentPhone: paymentMethod === PaymentMethod.MOMO ? state.momoNumber : undefined,
      momoNetwork: paymentMethod === PaymentMethod.MOMO ? state.momoNetwork : undefined,
      fulfillment,
      deliveryAddress: fulfillment === Fulfillment.DELIVERY ? state.deliveryAddress : undefined,
      deliveryFee: fulfillment === Fulfillment.DELIVERY ? Number(tenant.deliveryFee ?? 0) : 0,
      items: state.items,
    }, {}, { creditPromoter: true });
  }

  private async checkoutWithMomo(c: Conversation) {
    const order = await this.placeOrder(c, PaymentMethod.MOMO);
    const charge = await this.paystackService.initiateMoMoCharge({
      amount: order.totalAmount,
      momoNumber: c.state.momoNumber!,
      provider: c.state.momoNetwork || 'mtn',
      reference: order.orderNumber,
      email: DEFAULT_CUSTOMER_EMAIL,
      metadata: { tenantId: c.tenant.id, buyerPhone: c.buyerPhone, orderId: order.id },
    });

    if (!charge.success) {
      await this.orderService.discard(order.id);
      c.state.step = InteractiveStep.AWAITING_MOMO_NUMBER;
      await this.sendText(
        c,
        `⚠️ We couldn't start the payment: ${charge.message}\nEnter another MoMo number, or reply *cod* to pay on delivery.`,
      );
      return;
    }

    await this.sendText(c, formatOrderReceipt(order));
    this.clearState(c);
  }

  private async checkoutWithCard(c: Conversation) {
    const order = await this.placeOrder(c, PaymentMethod.CARD);
    const card = await this.paystackService.initializeCardPayment({
      amount: order.totalAmount,
      email: DEFAULT_CUSTOMER_EMAIL,
      reference: order.orderNumber,
    });

    if (!card.success || !card.authorizationUrl) {
      await this.orderService.discard(order.id);
      c.state.step = InteractiveStep.AWAITING_PAYMENT_METHOD;
      await this.sendText(c, '⚠️ Card payments are unavailable right now. Please choose mobile money or pay on delivery.');
      await this.sendPaymentMethodOptions(c);
      return;
    }

    await this.wabaService.sendInteractiveCtaUrl({
      phoneNumberId: c.phoneNumberId,
      toPhone: c.buyerPhone,
      bodyText: `Tap below to pay ${cedis(order.totalAmount)} securely for order ${order.orderNumber}.`,
      displayText: 'Pay now',
      url: card.authorizationUrl,
    });
    this.clearState(c);
  }

  private async checkoutCashOnDelivery(c: Conversation) {
    const order = await this.placeOrder(c, PaymentMethod.COD);
    await this.sendText(c, formatOrderReceipt(order));
    this.clearState(c);
  }

  // ───────────────────────── Outbound helpers ─────────────────────────

  private sendText(c: Conversation, text: string) {
    return this.wabaService.sendTextMessage(c.phoneNumberId, c.buyerPhone, text);
  }

  /** Try interactive buttons; if the client rejects them, send the plain-text equivalent. */
  private async sendButtons(c: Conversation, bodyText: string, buttons: ReplyButton[], fallbackText: string) {
    try {
      await this.wabaService.sendInteractiveButtons({ phoneNumberId: c.phoneNumberId, toPhone: c.buyerPhone, bodyText, buttons });
    } catch {
      await this.sendText(c, fallbackText);
    }
  }

  private sendPaymentMethodOptions(c: Conversation) {
    const fee = c.state.fulfillment === Fulfillment.DELIVERY ? Number(c.tenant.deliveryFee ?? 0) : 0;
    const { total } = orderTotals(c.state.items, fee);
    const feeNote = fee > 0 ? ` (incl. ${cedis(fee)} delivery)` : '';
    return this.sendButtons(
      c,
      `💳 *Total: ${cedis(total)}*${feeNote}\nHow would you like to pay?`,
      [
        { id: 'pay:momo', title: '📱 MoMo' },
        { id: 'pay:card', title: '💳 Card' },
        { id: 'pay:cod', title: '💵 On delivery' },
      ],
      `💳 *Total: ${cedis(total)}*${feeNote}\nHow would you like to pay?\n\nReply with:\n• *momo* — Mobile Money\n• *card* — Debit/Credit Card\n• *cod* — Cash on Delivery`,
    );
  }

  private productsOnPage(tenantId: string, page: number) {
    return this.prisma.product.findMany({
      where: { tenantId, inStock: true },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      orderBy: { name: 'asc' },
    });
  }

  private async sendProductList(c: Conversation, page: number) {
    const total = await this.prisma.product.count({ where: { tenantId: c.tenant.id, inStock: true } });
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const current = Math.min(Math.max(1, page), totalPages);
    c.state.page = current;

    const products = await this.productsOnPage(c.tenant.id, current);
    if (products.length === 0) {
      await this.sendText(c, `Welcome to ${c.tenant.name}! 👋\nThere are no products in stock right now. Please check back later!`);
      return;
    }

    const lines = products.map((p, i) => `*${i + 1}*. ${p.name} — ${cedis(p.price)}`).join('\n');
    let catalog = `🛍️ *${c.tenant.name}* (Page ${current}/${totalPages})\n\n${lines}\n\n💬 *Reply with the number (e.g. 1) to select an item.*`;
    if (current < totalPages) catalog += '\n▶️ Type *more* to view next page';
    if (current > 1) catalog += '\n◀️ Type *prev* to view previous page';

    await this.sendText(c, catalog);
  }

  /** First contact: try the WhatsApp Flow, fall back to the numbered text catalog. */
  private async sendCatalogEntry(c: Conversation): Promise<boolean> {
    if (this.flowService.isConfigured()) {
      try {
        await this.flowService.dispatchFlow({
          tenant: c.tenant,
          toPhone: c.buyerPhone,
          cta: 'Browse & Order',
          bodyText: `Welcome to *${c.tenant.name}*! 👋\n\nTap below to open our catalog and order items directly:`,
        });
        return true;
      } catch (err: any) {
        this.logger.warn(`Flow dispatch to hidden-number buyer failed, sending text catalog: ${err?.message || err}`);
      }
    }
    await this.sendProductList(c, 1);
    return true;
  }

  // ───────────────────────── State ─────────────────────────

  private stateKey(tenantId: string, buyerPhone: string): string {
    return `${tenantId}:${buyerPhone}`;
  }

  private getOrCreateState(tenantId: string, buyerPhone: string): CartSessionState {
    const key = this.stateKey(tenantId, buyerPhone);
    const existing = this.cartSessions.get(key);
    if (existing && Date.now() - existing.lastActive < SESSION_TTL_MS) {
      existing.lastActive = Date.now();
      return existing;
    }
    const fresh: CartSessionState = { step: InteractiveStep.IDLE, page: 1, items: [], lastActive: Date.now() };
    this.cartSessions.set(key, fresh);
    return fresh;
  }

  private clearState(c: Conversation) {
    this.cartSessions.delete(this.stateKey(c.tenant.id, c.buyerPhone));
  }
}
