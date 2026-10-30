import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import { Fulfillment, OrderStatus, PaymentMethod, Prisma, Tenant } from '@prisma/client';
import { optionalEnv } from '../common/config.js';
import { cedis } from '../common/money.util.js';
import { isHiddenNumber, toGhanaLocal } from '../common/phone.util.js';
import { truncate } from '../common/text.util.js';
import { CreateOrderItemDto } from '../order/dto/create-order.dto.js';
import { lineTotal, normalizeQuantity, orderTotals } from '../order/order-totals.util.js';
import { OrderService } from '../order/order.service.js';
import { DEFAULT_CUSTOMER_EMAIL, PaystackService } from '../payment/paystack.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WabaService } from '../waba/waba.service.js';
import {
  DecryptedFlowPayload,
  EncryptedFlowRequest,
  FlowCryptoService,
} from './flow-crypto.service.js';

/** A cart line is exactly what the order service accepts, so no mapping is needed at checkout. */
export type CartLine = CreateOrderItemDto;

interface FlowSessionState {
  selectedIds: Set<string>;
  lastVisibleIds: string[];
  cart: CartLine[];
  category: string;
  query: string;
  page: number;
  fulfillment: Fulfillment;
  address: string;
  momoNetwork?: string;
  momoNumber?: string;
  orderRef?: string;
  updatedAt: number;
}

type FlowTenant = Tenant & { user?: { email: string } | null };

const FLOW_VERSION = '3.0';
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_SWEEP_THRESHOLD = 100;
const PRODUCTS_PER_PAGE = 5;
const QUANTITY_SLOTS = 10;
const TITLE_MAX = 30;
const QUANTITY_LABEL_MAX = 20;
const DEFAULT_PICKUP_NOTE = 'Pick up at the store. We will message you when your order is ready.';

const MOMO_NETWORKS = [
  { id: 'mtn', title: 'MTN MoMo' },
  { id: 'telecel', title: 'Telecel Cash' },
  { id: 'airteltigo', title: 'AirtelTigo Money' },
];

/** Keyword -> emoji used to decorate product titles when the product has no image emoji. */
const PRODUCT_ICONS: Array<[string[], string]> = [
  [['tomato'], '🍅'],
  [['onion'], '🧅'],
  [['pepper', 'chili', 'chilli', 'shito'], '🌶️'],
  [['carrot'], '🥕'],
  [['cabbage', 'lettuce', 'spinach', 'kontomire', 'green', 'veg'], '🥬'],
  [['okra', 'okro'], '🌱'],
  [['watermelon', 'melon'], '🍉'],
  [['banana', 'plantain'], '🍌'],
  [['apple'], '🍎'],
  [['orange', 'citrus'], '🍊'],
  [['mango'], '🥭'],
  [['pineapple'], '🍍'],
  [['avocado', 'pear'], '🥑'],
  [['potato', 'yam', 'cassava'], '🥔'],
  [['egg'], '🥚'],
  [['bread'], '🍞'],
  [['meat', 'beef', 'pork', 'goat', 'steak'], '🥩'],
  [['chicken', 'poultry'], '🍗'],
  [['fish', 'tilapia', 'salmon'], '🐟'],
  [['rice'], '🍚'],
  [['milk', 'dairy', 'yogurt'], '🥛'],
  [['oil'], '🌻'],
  [['garlic', 'ginger'], '🧄'],
  [['corn', 'maize'], '🌽'],
  [['cucumber'], '🥒'],
  [['lemon', 'lime'], '🍋'],
  [['grape'], '🍇'],
  [['strawberry', 'berry'], '🍓'],
  [['bean', 'pea'], '🫘'],
  [['water'], '💧'],
  [['drink', 'juice', 'soda'], '🧃'],
  [['soap', 'detergent'], '🧼'],
];

const FULFILLMENT_KEYS: Record<Fulfillment, 'delivery' | 'pickup'> = {
  [Fulfillment.DELIVERY]: 'delivery',
  [Fulfillment.PICKUP]: 'pickup',
};

function parseFulfillment(value: unknown): Fulfillment {
  return String(value ?? '').trim().toLowerCase() === 'pickup' ? Fulfillment.PICKUP : Fulfillment.DELIVERY;
}

function parsePaymentMethod(value: unknown): PaymentMethod {
  switch (String(value ?? '').trim().toLowerCase()) {
    case 'card':
      return PaymentMethod.CARD;
    case 'cod':
    case 'cash':
      return PaymentMethod.COD;
    default:
      return PaymentMethod.MOMO;
  }
}

function screen(name: string, data: Record<string, any>): Record<string, any> {
  return { version: FLOW_VERSION, screen: name, data };
}

@Injectable()
export class FlowService implements OnModuleInit {
  private readonly logger = new Logger(FlowService.name);
  private readonly flowSessions = new Map<string, FlowSessionState>();

  /** Categories served by this flow. Matches flow.json. */
  public readonly flowCategories: { id: string; title: string }[] = [
    { id: 'all', title: '🛒 All Products' },
    { id: 'vegetables', title: '🥦 Vegetables' },
    { id: 'grains', title: '🌾 Grains & Staples' },
    { id: 'spices', title: '🌶️ Spices' },
    { id: 'snacks', title: '🥜 Snacks' },
  ];

  /** Map category id -> product name keywords for DB filtering. */
  private readonly categoryKeywords: Record<string, string[]> = {
    vegetables: ['tomato', 'onion', 'pepper', 'carrot', 'cabbage', 'lettuce', 'spinach', 'okra', 'okro', 'green', 'veg', 'cucumber', 'kontomire'],
    grains: ['rice', 'maize', 'corn', 'wheat', 'oat', 'millet', 'sorghum', 'bread', 'cassava', 'yam', 'potato', 'bean', 'pea', 'gari'],
    spices: ['pepper', 'chili', 'chilli', 'shito', 'garlic', 'ginger', 'spice', 'seasoning', 'curry', 'turmeric'],
    snacks: ['peanut', 'groundnut', 'chin chin', 'biscuit', 'chips', 'snack', 'nut', 'cracker', 'wafer', 'plantain', 'banana'],
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly flowCrypto: FlowCryptoService,
    private readonly paystackService: PaystackService,
    private readonly orderService: OrderService,
    private readonly wabaService: WabaService,
  ) {}

  /**
   * Validate the Flow private key at boot so a bad key surfaces as a clear startup
   * error instead of a cryptic DECODER failure on the first request from Meta.
   */
  onModuleInit() {
    const pem = process.env.META_FLOW_PRIVATE_KEY;
    if (!pem) {
      this.logger.warn('META_FLOW_PRIVATE_KEY is not set; the Flow data-exchange endpoint will reject requests.');
      return;
    }
    try {
      const key = crypto.createPrivateKey({
        key: pem.replace(/\\n/g, '\n'),
        passphrase: process.env.META_FLOW_PASSPHRASE || undefined,
      });
      this.logger.log(`Flow private key loaded (${key.asymmetricKeyType}, ${key.asymmetricKeyDetails?.modulusLength} bits).`);
    } catch (err: any) {
      this.logger.error(
        `META_FLOW_PRIVATE_KEY cannot be parsed (${err?.message || err}). ` +
          'The PEM in .env is malformed: check that nothing was typed or auto-completed into the key value and that every line of the base64 body is intact.',
      );
    }
  }

  // ───────────────────────── Outbound: sending the Flow ─────────────────────────

  /** True when a Flow id is configured, i.e. the ordering Flow can be sent. */
  isConfigured(): boolean {
    return optionalEnv('META_FLOW_ID') !== '';
  }

  /**
   * Send the ordering Flow to a buyer. This is the single place that knows how the
   * flow token, first screen and initial data are assembled.
   */
  async dispatchFlow(options: {
    tenant: Tenant;
    toPhone: string;
    cta: string;
    bodyText: string;
  }): Promise<{ messageId: string }> {
    const flowId = optionalEnv('META_FLOW_ID');
    if (!flowId) {
      throw new Error('META_FLOW_ID is not configured.');
    }
    if (!options.tenant.whatsappPhoneNumberId) {
      throw new Error(`Tenant ${options.tenant.id} has no WhatsApp phone number id.`);
    }

    const screenName = optionalEnv('META_FLOW_FIRST_SCREEN', 'PRODUCT_SELECT');
    return this.wabaService.sendFlowMessage({
      phoneNumberId: options.tenant.whatsappPhoneNumberId,
      toPhone: options.toPhone,
      flowId,
      flowToken: `${options.tenant.id}:${options.toPhone}:${Date.now()}`,
      flowCta: options.cta,
      screen: screenName,
      headerText: options.tenant.name,
      bodyText: options.bodyText,
      data: await this.buildFlowInitData(options.tenant.id),
    });
  }

  /**
   * Initial PRODUCT_SELECT payload attached to the Flow message.
   */
  async buildFlowInitData(tenantId: string): Promise<Record<string, any>> {
    const result = await this.buildProductSelectScreen(tenantId, this.newSession(), 1, 'all', '');
    return result.data;
  }

  // ───────────────────────── Inbound: data exchange ─────────────────────────

  /**
   * Decrypt a Meta Flow request, handle it and return the encrypted response.
   */
  async processEncryptedFlowRequest(body: EncryptedFlowRequest): Promise<string> {
    const privateKeyPem = process.env.META_FLOW_PRIVATE_KEY;
    if (!privateKeyPem) {
      this.logger.error('META_FLOW_PRIVATE_KEY is not configured in environment variables.');
      throw new BadRequestException('Flow encryption key not configured');
    }

    const { decryptedPayload, aesKey, iv } = this.flowCrypto.decryptRequest(
      body,
      privateKeyPem,
      process.env.META_FLOW_PASSPHRASE,
    );

    this.logger.log(`Flow request: action=${decryptedPayload.action} screen=${decryptedPayload.screen ?? '-'}`);
    const responsePayload = await this.handleFlowAction(decryptedPayload);
    this.logger.log(`Flow response: screen=${responsePayload.screen ?? '-'}`);

    return this.flowCrypto.encryptResponse(responsePayload, aesKey, iv);
  }

  /**
   * Screen navigation: PRODUCT_SELECT -> QUANTITIES -> SUMMARY -> PAYMENT -> DONE
   */
  async handleFlowAction(payload: DecryptedFlowPayload): Promise<Record<string, any>> {
    const { action, data, flow_token } = payload;
    const currentScreen = payload.screen;

    if (action === 'ping') {
      return { version: FLOW_VERSION, data: { status: 'active' } };
    }

    const { tenantId, buyerPhone } = this.parseFlowToken(flow_token);
    if (!tenantId) {
      throw new BadRequestException('Flow token is missing a tenant id.');
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: { user: { select: { email: true } } },
    });
    if (!tenant) {
      throw new BadRequestException(`No tenant found for flow token.`);
    }

    const session = this.getSession(String(flow_token).trim());

    if (action === 'INIT') {
      Object.assign(session, this.newSession());
      return this.buildProductSelectScreen(tenant.id, session, 1, 'all', '');
    }

    if (action === 'data_exchange') {
      this.syncProductSelection(session, data);

      const step =
        data?.step ||
        data?.flow_action ||
        data?.action ||
        (data?.category !== undefined && !data?.cart ? 'set_category' : undefined) ||
        (data?.query !== undefined && !data?.cart ? 'search' : undefined) ||
        (data?.page !== undefined && !data?.cart ? 'go_page' : undefined);

      const category = typeof data?.category === 'string' ? data.category.trim() : session.category;
      const query =
        typeof data?.query === 'string'
          ? data.query.trim()
          : typeof data?.search_query === 'string'
            ? data.search_query.trim()
            : session.query;

      switch (step) {
        case 'set_category':
        case 'search':
          return this.buildProductSelectScreen(tenant.id, session, 1, category || 'all', query);

        case 'go_page':
        case 'next_page':
        case 'previous_page': {
          const requested =
            step === 'next_page'
              ? session.page + 1
              : step === 'previous_page'
                ? session.page - 1
                : parseInt(String(data?.page || data?.page_select || '1'), 10);
          return this.buildProductSelectScreen(tenant.id, session, Math.max(1, requested || 1), category, query);
        }

        case 'continue':
          if (session.selectedIds.size === 0) {
            return this.buildProductSelectScreen(
              tenant.id,
              session,
              session.page,
              session.category,
              session.query,
              '⚠️ Please select at least one item before continuing.',
            );
          }
          return this.buildQuantitiesScreen(tenant.id, session);

        case 'quantities':
          return this.buildSummaryScreen(tenant, session, data);

        case 'to_payment':
          return this.handleToPayment(tenant, session, data);

        case 'pay':
          return this.handlePay(tenant, session, data, buyerPhone);
      }

      // No explicit step: re-render whatever screen the client says it is on.
      switch (currentScreen) {
        case 'PRODUCT_SELECT':
          return this.buildProductSelectScreen(tenant.id, session, session.page, session.category, session.query);
        case 'QUANTITIES':
          return this.buildSummaryScreen(tenant, session, data);
        case 'SUMMARY':
          return this.buildSummaryScreen(tenant, session, data);
        case 'PAYMENT':
          return this.buildPaymentScreen(tenant, session);
        case 'DONE':
          return this.buildDoneScreen(session.orderRef ?? '', "Order placed. We'll message you on WhatsApp with updates.");
      }
    }

    return screen(currentScreen || 'PRODUCT_SELECT', { ...data });
  }

  // ───────────────────────── Sessions ─────────────────────────

  private parseFlowToken(flowToken?: string): { tenantId: string | null; buyerPhone: string | null } {
    if (!flowToken || !flowToken.includes(':')) {
      return { tenantId: null, buyerPhone: null };
    }
    const parts = flowToken.split(':');
    return { tenantId: parts[0] || null, buyerPhone: parts.length >= 3 ? parts[1] : null };
  }

  private newSession(): FlowSessionState {
    return {
      selectedIds: new Set<string>(),
      lastVisibleIds: [],
      cart: [],
      category: 'all',
      query: '',
      page: 1,
      fulfillment: Fulfillment.DELIVERY,
      address: '',
      updatedAt: Date.now(),
    };
  }

  private getSession(key: string): FlowSessionState {
    if (this.flowSessions.size > SESSION_SWEEP_THRESHOLD) {
      const now = Date.now();
      for (const [sessionKey, state] of this.flowSessions) {
        if (now - state.updatedAt > SESSION_TTL_MS) this.flowSessions.delete(sessionKey);
      }
    }

    let session = this.flowSessions.get(key);
    if (!session) {
      session = this.newSession();
      this.flowSessions.set(key, session);
    }
    session.updatedAt = Date.now();
    return session;
  }

  /**
   * Keep the set of selected product ids in sync across paginated pages.
   */
  private syncProductSelection(session: FlowSessionState, data?: Record<string, any>) {
    const raw = data?.selected_on_page ?? data?.selected_products;
    const onPage = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];

    for (const id of session.lastVisibleIds) session.selectedIds.delete(id);
    for (const id of onPage) session.selectedIds.add(id);
  }

  // ───────────────────────── Screens ─────────────────────────

  private buildProductWhere(tenantId: string, category: string, query: string): Prisma.ProductWhereInput {
    const conditions: Prisma.ProductWhereInput[] = [];
    if (query) {
      conditions.push({ name: { contains: query, mode: 'insensitive' } });
    }
    const keywords = category !== 'all' ? this.categoryKeywords[category] : undefined;
    if (keywords) {
      conditions.push({ OR: keywords.map((kw) => ({ name: { contains: kw, mode: 'insensitive' } })) });
    }
    return { tenantId, inStock: true, ...(conditions.length ? { AND: conditions } : {}) };
  }

  private async buildProductSelectScreen(
    tenantId: string,
    session: FlowSessionState,
    requestedPage: number,
    category: string,
    query: string,
    notice = ' ',
  ): Promise<Record<string, any>> {
    const where = this.buildProductWhere(tenantId, category, query);
    const total = await this.prisma.product.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / PRODUCTS_PER_PAGE));
    const page = Math.min(Math.max(requestedPage, 1), totalPages);

    const products = await this.prisma.product.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PRODUCTS_PER_PAGE,
      take: PRODUCTS_PER_PAGE,
    });

    const pageProducts = products.map((p) => ({
      id: p.id,
      title: this.formatProductTitle(p.name, p.image),
      description: cedis(p.price),
    }));

    session.lastVisibleIds = pageProducts.map((p) => p.id);
    session.page = page;
    session.category = category;
    session.query = query;

    const selectedCount = session.selectedIds.size;
    const showNotice = notice.trim() !== '';

    return screen('PRODUCT_SELECT', {
      categories: this.flowCategories,
      category_prefill: category,
      pages: Array.from({ length: totalPages }, (_, i) => ({ id: String(i + 1), title: `Page ${i + 1} of ${totalPages}` })),
      page_prefill: String(page),
      products: pageProducts,
      pre_selected: session.lastVisibleIds.filter((id) => session.selectedIds.has(id)),
      page_label: `${total} products`,
      selection_note: selectedCount ? `🛒 ${selectedCount} item(s) selected` : '🛒 Your basket is empty — tap items to add',
      search_prefill: query || ' ',
      notice: showNotice ? notice : ' ',
      show_notice: showNotice,
    });
  }

  private async buildQuantitiesScreen(tenantId: string, session: FlowSessionState): Promise<Record<string, any>> {
    const selected = await this.prisma.product.findMany({
      where: { tenantId, inStock: true, id: { in: Array.from(session.selectedIds) } },
      orderBy: { createdAt: 'desc' },
    });

    const quantityOptions = Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), title: String(i + 1) }));
    const data: Record<string, any> = {};

    for (let i = 0; i < QUANTITY_SLOTS; i++) {
      const product = selected[i];
      data[`item_${i}_id`] = product?.id ?? ' ';
      data[`item_${i}_label`] = product ? truncate(this.formatProductTitle(product.name, product.image), QUANTITY_LABEL_MAX) : ' ';
      data[`item_${i}_helper`] = product ? `${cedis(product.price)} each` : ' ';
      data[`show_${i}`] = Boolean(product);
      data[`item_${i}_options`] = product ? quantityOptions : [quantityOptions[0]];
      data[`item_${i}_default`] = '1';
    }

    return screen('QUANTITIES', data);
  }

  private async buildSummaryScreen(
    tenant: FlowTenant,
    session: FlowSessionState,
    data?: Record<string, any>,
    errorMessage = ' ',
  ): Promise<Record<string, any>> {
    const slots: Array<{ id: string; quantity: number }> = [];
    for (let i = 0; i < QUANTITY_SLOTS; i++) {
      const id = String(data?.[`i${i}_id`] ?? data?.[`item_${i}_id`] ?? '').trim();
      if (!id) continue;
      slots.push({ id, quantity: normalizeQuantity(data?.[`i${i}_qty`] ?? data?.[`item_${i}_qty`] ?? data?.[`qty_${i}`]) });
    }

    if (slots.length > 0) {
      const products = await this.prisma.product.findMany({
        where: { tenantId: tenant.id, inStock: true, id: { in: slots.map((s) => s.id) } },
      });
      session.cart = slots.flatMap((slot) => {
        const product = products.find((p) => p.id === slot.id);
        if (!product) return [];
        return [{
          productId: product.id,
          productName: this.formatProductTitle(product.name, product.image),
          unitPrice: product.price,
          quantity: slot.quantity,
        }];
      });
    }

    return this.summaryScreenFor(tenant, session, errorMessage);
  }

  private summaryScreenFor(tenant: FlowTenant, session: FlowSessionState, errorMessage = ' '): Record<string, any> {
    const totals = this.totalsFor(tenant, session);
    const showError = errorMessage.trim() !== '';
    const orderTotal =
      session.fulfillment === Fulfillment.DELIVERY
        ? `💰 Total: ${cedis(totals.total)} (incl. ${cedis(totals.deliveryFee)} delivery)`
        : `💰 Total: ${cedis(totals.total)} (Pickup)`;

    return screen('SUMMARY', {
      summary_lines: session.cart.length ? session.cart.map((line) => this.formatCartLine(line)).join('\n') : 'No items selected.',
      order_total: orderTotal,
      cart_json: JSON.stringify(session.cart),
      error_message: showError ? errorMessage : ' ',
      show_error: showError,
      fulfillment_prefill: FULFILLMENT_KEYS[session.fulfillment],
      pickup_note: tenant.pickupNote || DEFAULT_PICKUP_NOTE,
    });
  }

  private handleToPayment(tenant: FlowTenant, session: FlowSessionState, data?: Record<string, any>): Record<string, any> {
    const incomingCart = this.parseCart(data?.cart);
    if (incomingCart.length > 0) {
      session.cart = incomingCart;
    }

    session.fulfillment = parseFulfillment(data?.fulfillment);
    session.address = typeof data?.address === 'string' ? data.address.trim() : '';

    if (session.fulfillment === Fulfillment.DELIVERY && !session.address) {
      return this.summaryScreenFor(tenant, session, '⚠️ Please enter your delivery address / landmark before continuing.');
    }

    return this.buildPaymentScreen(tenant, session);
  }

  private buildPaymentScreen(tenant: FlowTenant, session: FlowSessionState, errorMessage = ' '): Record<string, any> {
    const { total } = this.totalsFor(tenant, session);
    const showError = errorMessage.trim() !== '';
    return screen('PAYMENT', {
      order_total: `Total: ${cedis(total)}`,
      pay_label: `Pay ${cedis(total)}`,
      networks: MOMO_NETWORKS,
      error_message: showError ? errorMessage : ' ',
      show_error: showError,
      network_prefill: session.momoNetwork || 'mtn',
      number_prefill: session.momoNumber || '',
    });
  }

  private buildDoneScreen(orderRef: string, message: string): Record<string, any> {
    return screen('DONE', { order_ref: orderRef, done_message: message });
  }

  /**
   * PAYMENT -> DONE. The order is persisted first so its reference is reserved, then the
   * payment is initiated. If payment initiation fails the order is discarded and the
   * buyer stays on the PAYMENT screen with an explanation.
   */
  private async handlePay(
    tenant: FlowTenant,
    session: FlowSessionState,
    data: Record<string, any> | undefined,
    buyerPhoneFromToken: string | null,
  ): Promise<Record<string, any>> {
    const paymentMethod = parsePaymentMethod(data?.payment_method);
    session.momoNetwork = typeof data?.momo_network === 'string' ? data.momo_network.trim() : 'mtn';
    session.momoNumber = typeof data?.momo_number === 'string' ? data.momo_number.trim() : '';

    if (paymentMethod === PaymentMethod.MOMO && toGhanaLocal(session.momoNumber).length < 10) {
      return this.buildPaymentScreen(tenant, session, '⚠️ Please enter a valid 10-digit mobile money number (e.g. 0244123456).');
    }

    if (session.cart.length === 0) {
      return this.buildProductSelectScreen(tenant.id, session, 1, 'all', '', '⚠️ Your basket is empty. Please pick your items again.');
    }

    const totals = this.totalsFor(tenant, session);
    const buyerPhone = buyerPhoneFromToken || 'unknown';
    const order = await this.orderService.createOrder(tenant.id, {
      buyerPhone,
      status: paymentMethod === PaymentMethod.COD ? OrderStatus.CONFIRMED : OrderStatus.AWAITING_PAYMENT,
      paymentMethod,
      paymentPhone: paymentMethod === PaymentMethod.MOMO ? session.momoNumber : undefined,
      momoNetwork: paymentMethod === PaymentMethod.MOMO ? session.momoNetwork : undefined,
      fulfillment: session.fulfillment,
      deliveryAddress: session.fulfillment === Fulfillment.DELIVERY ? session.address : undefined,
      deliveryFee: totals.deliveryFee,
      items: session.cart,
    });

    const customerEmail = tenant.user?.email || DEFAULT_CUSTOMER_EMAIL;
    let doneMessage: string;

    switch (paymentMethod) {
      case PaymentMethod.MOMO: {
        const charge = await this.paystackService.initiateMoMoCharge({
          amount: order.totalAmount,
          momoNumber: session.momoNumber!,
          provider: session.momoNetwork!,
          email: customerEmail,
          reference: order.orderNumber,
          metadata: { tenantId: tenant.id, orderId: order.id, buyerPhone },
        });
        if (!charge.success) {
          await this.orderService.discard(order.id);
          return this.buildPaymentScreen(
            tenant,
            session,
            `⚠️ Payment initiation failed: ${charge.message}. Please verify your phone number and network.`,
          );
        }
        doneMessage = `Order placed! A payment prompt has been sent to ${session.momoNumber}. Approve it with your MoMo PIN to complete the order.`;
        break;
      }
      case PaymentMethod.CARD: {
        const card = await this.paystackService.initializeCardPayment({
          amount: order.totalAmount,
          email: customerEmail,
          reference: order.orderNumber,
        });
        if (!card.success || !card.authorizationUrl) {
          await this.orderService.discard(order.id);
          return this.buildPaymentScreen(
            tenant,
            session,
            '⚠️ Card payments are unavailable right now. Please choose mobile money or pay on delivery.',
          );
        }
        await this.sendCardLink(tenant, buyerPhone, order.orderNumber, order.totalAmount, card.authorizationUrl);
        doneMessage = 'Order placed. Tap the secure payment link we sent you on WhatsApp to pay by card.';
        break;
      }
      default:
        doneMessage = "Order placed. You can pay on delivery or at pickup. We'll message you on WhatsApp with updates.";
    }

    session.orderRef = order.orderNumber;
    session.selectedIds.clear();
    session.cart = [];

    return this.buildDoneScreen(order.orderNumber, doneMessage);
  }

  private async sendCardLink(tenant: FlowTenant, buyerPhone: string, orderNumber: string, amount: number, url: string) {
    if (!tenant.whatsappPhoneNumberId || !buyerPhone || isHiddenNumber(buyerPhone)) {
      this.logger.warn(`Cannot send card link for ${orderNumber}: no deliverable buyer number.`);
      return;
    }
    try {
      await this.wabaService.sendInteractiveCtaUrl({
        phoneNumberId: tenant.whatsappPhoneNumberId,
        toPhone: buyerPhone,
        bodyText: `Tap below to pay ${cedis(amount)} securely for order ${orderNumber}.`,
        displayText: 'Pay now',
        url,
      });
    } catch (err: any) {
      this.logger.warn(`Failed to send card link for ${orderNumber}: ${err?.message || err}`);
    }
  }

  // ───────────────────────── Helpers ─────────────────────────

  private totalsFor(tenant: FlowTenant, session: FlowSessionState) {
    const fee = session.fulfillment === Fulfillment.DELIVERY ? Number(tenant.deliveryFee ?? 0) : 0;
    return orderTotals(session.cart, fee);
  }

  private formatCartLine(line: CartLine): string {
    return `${line.productName}: ${line.quantity} × ${cedis(line.unitPrice)} = ${cedis(lineTotal(line))}`;
  }

  private parseCart(raw: unknown): CartLine[] {
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return [];
      }
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((line: any) => line && typeof line.productId === 'string' && typeof line.productName === 'string')
      .map((line: any) => ({
        productId: line.productId,
        productName: line.productName,
        unitPrice: Number(line.unitPrice) || 0,
        quantity: normalizeQuantity(line.quantity),
      }));
  }

  /**
   * Product title decorated with an emoji: the product's own image emoji, or one inferred from its name.
   */
  formatProductTitle(name: string, image?: string | null): string {
    const trimmed = name?.trim() || '';
    if (!trimmed) return trimmed;

    let title: string;
    if (/^(\p{Extended_Pictographic}|\p{Emoji_Presentation})/u.test(trimmed)) {
      title = trimmed;
    } else if (image && image.trim() && image.trim().length <= 4) {
      title = `${image.trim()} ${trimmed}`;
    } else {
      const lower = trimmed.toLowerCase();
      const match = PRODUCT_ICONS.find(([keywords]) => keywords.some((kw) => lower.includes(kw)));
      title = `${match ? match[1] : '🛒'} ${trimmed}`;
    }

    return truncate(title, TITLE_MAX);
  }
}
