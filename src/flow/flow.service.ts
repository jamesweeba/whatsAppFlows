import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  FlowCart,
  Fulfillment,
  Order,
  OrderStatus,
  PaymentMethod,
  Prisma,
  Product,
  ProductMeasure,
  Tenant,
} from '@prisma/client';
import { CategoryService } from '../category/category.service.js';
import { optionalEnv } from '../common/config.js';
import { MEASURE_CODES } from '../common/measure-codes.js';
import { ghsCompact } from '../common/money.util.js';
import {
  formatGhanaLocal,
  ghanaMomoNetwork,
  isGhanaMobile,
  isHiddenNumber,
  toE164,
  toGhanaLocal,
  toInternationalDigits,
} from '../common/phone.util.js';
import { truncate } from '../common/text.util.js';
import { formatOrderReceipt } from '../order/order-receipt.js';
import { normalizeQuantity, orderTotals } from '../order/order-totals.util.js';
import { NotificationService } from '../notification/notification.service.js';
import { OrderService } from '../order/order.service.js';
import { DEFAULT_CUSTOMER_EMAIL, PaystackService } from '../payment/paystack.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isLive } from '../tenant/tenant.service.js';
import { WabaService } from '../waba/waba.service.js';
import { DecryptedFlowPayload, EncryptedFlowRequest, FlowCryptoService } from './flow-crypto.service.js';
import { PLACEHOLDER_PHOTO } from './placeholder-image.js';

/** One basket line as stored on the FlowCart. Prices are never stored: they are read from the DB at render time. */
export interface CartLineRef {
  sku: string;
  measure: string;
  qty: number;
}

/** The line PRODUCT is editing, so add_line knows the old measure and where to return. */
interface EditingRef {
  sku: string;
  measure: string | null;
  fromBasket: boolean;
}

interface Measure {
  code: string;
  label: string;
  price: number;
  description?: string | null;
}

type CatalogProduct = Product & { measures: ProductMeasure[] };

interface PricedLine extends CartLineRef {
  product: CatalogProduct;
  measureInfo: Measure;
  total: number;
}

interface Option {
  id: string;
  title: string;
  description?: string;
}

export type ConfirmationHandler = (tenant: Tenant, orderNumber: string, buyerPhone: string) => Promise<unknown>;

/** The order fields the MoMo prompt needs. */
type PromptableOrder = Pick<
  Order,
  'id' | 'orderNumber' | 'buyerPhone' | 'totalAmount' | 'paymentMethod' | 'paymentPhone' | 'momoNetwork' | 'status'
>;

const FLOW_VERSION = '3.0';
const FIRST_SCREEN = 'WELCOME';
const CART_TTL_MS = 60 * 60 * 1000;
/** How long to wait for Done before sending the receipt and pin request anyway. */
const CONFIRMATION_FALLBACK_MS = 60 * 1000;
const STALE_CART_MS = 7 * 24 * 60 * 60 * 1000;

/** Products per CATALOGUE page; Previous and Next rows are added on top (NavigationList caps at 20). */
const PRODUCTS_PER_PAGE = 15;
/** BASKET shows the 20 most recent lines (NavigationList caps at 20). */
const BASKET_LINES_SHOWN = 20;
const MAX_WELCOME_OPTIONS = 20;
const MAX_QTY = 10;

/** Text caps enforced by the Flow validator (see the endpoint contract). */
const LIMIT = {
  navTitle: 30,
  navDescription: 20,
  navMetadata: 80,
  navEnd: 10,
  badge: 15,
  optionTitle: 30,
  optionDescription: 300,
  subheading: 80,
  caption: 409,
  input: 200,
};

const REORDER_ID = 'reorder_last';
/** Pseudo-category for products created before categories were required. */
const ALL_PRODUCTS_ID = 'all';
const ASAP_SLOT_ID = 'asap';
const EACH_MEASURE = MEASURE_CODES.EACH;
const REMOVE_MEASURE = MEASURE_CODES.REMOVE;
const NONE = MEASURE_CODES.NONE;

const DEFAULT_ASAP_SLOT: Option = {
  id: ASAP_SLOT_ID,
  title: 'Now · within 1 hour',
  description: 'Rider leaves as soon as your order is packed',
};
const FALLBACK_AREA: Option = { id: 'other', title: 'Other area' };

const PAYMENT_METHODS: Option[] = [
  { id: 'momo', title: 'Mobile Money (MoMo)', description: 'MTN, Telecel or AirtelTigo' },
  { id: 'cash', title: 'Cash on delivery', description: 'Pay the rider in cash' },
];

const QTY_OPTIONS = Array.from({ length: MAX_QTY }, (_, i) => ({ id: String(i + 1), title: String(i + 1) }));

function screen(name: string, data: Record<string, any>): Record<string, any> {
  return { version: FLOW_VERSION, screen: name, data };
}

/** Steps a NavigationList row that is not about a product carries in its `sku` slot. */
const NAV_STEPS = new Set(['open_category', 'open_basket', 'build_summary']);

/**
 * NavigationList item payloads share one schema, so every key must be present.
 * WhatsApp can drop `step` from the payload, so rows without a product also put the
 * step in `sku` (product ids are UUIDs, so they never collide with a step name).
 */
function navAction(action: string, fields: { sku?: string; measure?: string; category: string; page: number | string }) {
  return {
    name: 'data_exchange',
    payload: {
      step: action,
      sku: fields.sku ?? action,
      measure: fields.measure ?? NONE,
      category: fields.category,
      page: String(fields.page),
    },
  };
}

function text(value: unknown, max = LIMIT.input): string {
  return typeof value === 'string' ? truncate(value.trim(), max) : '';
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

@Injectable()
export class FlowService implements OnModuleInit {
  private readonly logger = new Logger(FlowService.name);
  private confirmationHandler: ConfirmationHandler | null = null;
  /** MoMo prompts started at place_order, by order id; the receipt waits for the outcome. */
  private readonly pendingPrompts = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly flowCrypto: FlowCryptoService,
    private readonly paystackService: PaystackService,
    private readonly orderService: OrderService,
    private readonly wabaService: WabaService,
    private readonly notifications: NotificationService,
    private readonly categoryService: CategoryService,
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
   * Send the ordering Flow to a buyer. The flow token carries the tenant and the buyer's
   * phone, because INIT does not include the phone and "Repeat my last order" needs it.
   * The Flow opens with a data_exchange INIT, so WELCOME is always built by handleFlowAction.
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

    return this.wabaService.sendFlowMessage({
      phoneNumberId: options.tenant.whatsappPhoneNumberId,
      toPhone: options.toPhone,
      flowId,
      flowToken: `${options.tenant.id}:${options.toPhone}:${Date.now()}`,
      flowCta: options.cta,
      flowAction: 'data_exchange',
      screen: FIRST_SCREEN,
      headerText: options.tenant.name,
      bodyText: options.bodyText,
    });
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

    const responsePayload = await this.handleFlowAction(decryptedPayload);
    this.logger.log(`Flow response: token=${decryptedPayload.flow_token ?? '-'} screen=${responsePayload.screen ?? '-'}`);

    return this.flowCrypto.encryptResponse(responsePayload, aesKey, iv);
  }

  /**
   * Route one decrypted request. Navigation is driven by `data.step` (`data.action` is
   * still read for Flows uploaded before the rename):
   * WELCOME -> CATALOGUE -> PRODUCT -> BASKET -> CHECKOUT -> ORDER_RECEIVED.
   * Going "back" is done by choosing an earlier screen in the response.
   */
  async handleFlowAction(payload: DecryptedFlowPayload): Promise<Record<string, any>> {
    const { action, data, flow_token } = payload;
    const step = this.stepFor(payload);
    this.logger.log(`Flow request: token=${flow_token ?? '-'} action=${action} step=${step} screen=${payload.screen ?? '-'}`);

    if (action === 'ping') {
      return { version: FLOW_VERSION, data: { status: 'active' } };
    }
    if (data?.error) {
      this.logger.warn(`Flow client error for token ${flow_token ?? '-'}: ${JSON.stringify(data.error)}`);
      return { version: FLOW_VERSION, data: { acknowledged: true } };
    }

    const { tenantId, buyerPhone } = this.parseFlowToken(flow_token);
    if (!tenantId) {
      throw new BadRequestException('Flow token is missing a tenant id.');
    }
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      throw new BadRequestException('No tenant found for flow token.');
    }
    // A suspended (or released) shop stops taking orders, including from a Flow the buyer
    // already has open: the webhook gate only stops new Flow messages being sent.
    if (!isLive(tenant)) {
      this.logger.warn(`Refusing Flow request for ${tenant.status} shop ${tenant.id} (token ${flow_token}).`);
      throw new BadRequestException('This shop is not taking orders right now.');
    }

    const cart = await this.loadCart(String(flow_token).trim(), tenant.id, buyerPhone ?? '');
    const category = text(data?.category) || ALL_PRODUCTS_ID;
    const page = Math.max(1, parseInt(String(data?.page ?? '1'), 10) || 1);

    if (action === 'INIT') {
      this.deleteStaleCarts(tenant.id);
      return this.welcomeScreen(tenant, buyerPhone);
    }

    switch (step) {
      case 'open_category':
        if (category === REORDER_ID) {
          return this.reorderLastOrder(tenant, cart, buyerPhone);
        }
        return this.catalogueScreen(tenant, cart, category, page);

      case 'open_product':
        return this.productScreen(tenant, cart, text(data?.sku), text(data?.measure) || NONE, category, page);

      case 'add_line':
        return this.addLine(tenant, cart, data ?? {}, category, page);

      case 'open_basket':
        return this.basketScreen(tenant, cart, category);

      case 'build_summary':
        return this.checkoutScreen(tenant, cart, category);

      case 'place_order':
        return this.placeOrder(tenant, cart, data ?? {}, buyerPhone);
    }

    this.logger.warn(
      `Unknown Flow step "${step}" for token ${flow_token} (data keys: ${Object.keys(data ?? {}).join(', ') || 'none'}); ` +
        'showing WELCOME. Is the Flow on Meta the current src/flow/flow.json?',
    );
    return this.welcomeScreen(tenant, buyerPhone);
  }

  /**
   * Which step a request is. `data.step` (or the older `data.action`) is used when present,
   * but WhatsApp has been seen to drop it, so otherwise the step is worked out from the
   * screen the request came from and the fields it carries.
   */
  private stepFor({ action, screen, data }: DecryptedFlowPayload): string {
    const named = data?.step ?? data?.action;
    if (typeof named === 'string' && named) return named;

    const sku = text(data?.sku);
    switch (screen) {
      case 'WELCOME':
        return 'open_category';
      case 'PRODUCT':
        // The footer sends the chosen quantity; "Back to list" sends only category and page.
        return data?.qty !== undefined ? 'add_line' : 'open_category';
      case 'CHECKOUT':
        return 'place_order';
      case 'CATALOGUE':
      case 'BASKET':
        if (NAV_STEPS.has(sku)) return sku;
        if (sku && sku !== NONE) return 'open_product';
    }
    return action;
  }

  // ───────────────────────── After place_order: receipt, MoMo prompt, pin ─────────────────────────

  /**
   * The chat layer registers here to send the receipt and pin request for a buyer who
   * placed an order but never tapped Done. It is called CONFIRMATION_FALLBACK_MS after
   * place_order and is a no-op when Done already confirmed the order.
   */
  onConfirmationDue(handler: ConfirmationHandler) {
    this.confirmationHandler = handler;
  }

  /**
   * Return the receipt text for the chat layer to send, with a warning if the MoMo prompt
   * failed. Runs once per order: on Done, or on the fallback if Done never came; the
   * other call gets `text: null`. Returns null when the order does not belong to this
   * tenant and buyer, so a stray order reference never reveals someone else's receipt.
   */
  async completeOrder(tenant: Tenant, orderNumber: string, buyerPhone: string) {
    const order = await this.orderService.findByOrderNumber(orderNumber);
    if (!order || order.tenantId !== tenant.id || !this.isSameBuyer(order.buyerPhone, buyerPhone)) {
      return null;
    }
    if (!(await this.orderService.claimConfirmation(order.id))) {
      return { order, text: null };
    }

    // The prompt normally started at place_order; wait for it so the receipt reports the
    // real outcome. Without one in flight (e.g. after a restart), try it now.
    const pending = this.pendingPrompts.get(order.id);
    this.pendingPrompts.delete(order.id);
    const paymentNotice = await (pending ?? this.requestPayment(tenant, order));

    return { order, text: formatOrderReceipt(order) + paymentNotice };
  }

  /**
   * Send the MoMo prompt once. Resolves to '' when it went out (or was not needed), or to
   * a warning for the receipt when Paystack refused it; the claim is then released so a
   * later attempt can retry.
   */
  private async requestPayment(tenant: Tenant, order: PromptableOrder): Promise<string> {
    const needsPrompt =
      order.paymentMethod === PaymentMethod.MOMO && order.status === OrderStatus.AWAITING_PAYMENT && Boolean(order.paymentPhone);
    if (!needsPrompt || !(await this.orderService.claimPaymentRequest(order.id))) {
      return '';
    }

    const charge = await this.paystackService.initiateMoMoCharge({
      amount: order.totalAmount,
      momoNumber: order.paymentPhone!,
      provider: order.momoNetwork || 'mtn',
      email: DEFAULT_CUSTOMER_EMAIL,
      reference: order.orderNumber,
      metadata: { tenantId: tenant.id, orderId: order.id, buyerPhone: order.buyerPhone },
    });
    if (charge.success) return '';

    await this.orderService.releasePaymentRequest(order.id);
    this.logger.warn(`MoMo prompt for ${order.orderNumber} failed: ${charge.message}`);
    return (
      `\n\n⚠️ We couldn't send the MoMo prompt to ${formatGhanaLocal(order.paymentPhone!)} (${charge.message}). ` +
      'Reply here and we will help you pay, or pay the rider in cash.'
    );
  }

  /**
   * Ask the buyer to drop a pin on the delivery address with WhatsApp's native map picker.
   * The pin arrives later as a `location` message and is attached by OrderService.attachLocation.
   */
  async requestDeliveryLocation(tenant: Tenant, buyerPhone: string, order: { id: string; orderNumber: string }) {
    if (!tenant.whatsappPhoneNumberId) return;
    try {
      await this.wabaService.sendLocationRequest(
        tenant.whatsappPhoneNumberId,
        buyerPhone,
        `Tap below and drop the pin on the *delivery* address for order ${order.orderNumber} so our rider finds you fast.`,
      );
      await this.orderService.markLocationRequested(order.id);
    } catch (err: any) {
      this.logger.warn(`Failed to request location for ${order.orderNumber}: ${err?.message || err}`);
    }
  }

  /**
   * Compare phones in one format: vendors may send the Flow to `024...` while the webhook
   * reports `233...`. Orders placed from a token without a phone are stored as "unknown".
   */
  private isSameBuyer(orderPhone: string, buyerPhone: string): boolean {
    if (orderPhone === 'unknown') return true;
    return toInternationalDigits(orderPhone) === toInternationalDigits(buyerPhone);
  }

  // ───────────────────────── Cart ─────────────────────────

  private parseFlowToken(flowToken?: string): { tenantId: string | null; buyerPhone: string | null } {
    if (!flowToken || !flowToken.includes(':')) {
      return { tenantId: null, buyerPhone: null };
    }
    const parts = flowToken.split(':');
    return { tenantId: parts[0] || null, buyerPhone: parts.length >= 3 ? parts[1] || null : null };
  }

  /**
   * The server-side cart for this flow_token. A cart idle for over an hour starts empty
   * again, unless it was already checked out (place_order must stay idempotent).
   */
  private async loadCart(flowToken: string, tenantId: string, buyerPhone: string): Promise<FlowCart> {
    const cart = await this.prisma.flowCart.upsert({
      where: { flowToken },
      create: { flowToken, tenantId, buyerPhone },
      update: {},
    });
    if (cart.tenantId !== tenantId) {
      throw new BadRequestException('Flow token does not match its cart.');
    }

    const expired = Date.now() - cart.updatedAt.getTime() > CART_TTL_MS;
    if (expired && this.linesOf(cart).length > 0 && !(await this.orderService.findByFlowCart(cart.id))) {
      return this.saveCart(cart, [], null);
    }
    return cart;
  }

  /** Abandoned carts that never became an order are kept for a week (drop-off analysis), then removed. */
  private deleteStaleCarts(tenantId: string) {
    void this.prisma.flowCart
      .deleteMany({ where: { tenantId, updatedAt: { lt: new Date(Date.now() - STALE_CART_MS) }, order: { is: null } } })
      .catch((err) => this.logger.warn(`Stale cart cleanup failed: ${err?.message || err}`));
  }

  private linesOf(cart: FlowCart): CartLineRef[] {
    return Array.isArray(cart.lines) ? (cart.lines as unknown as CartLineRef[]) : [];
  }

  private editingOf(cart: FlowCart): EditingRef | null {
    return cart.editing && typeof cart.editing === 'object' ? (cart.editing as unknown as EditingRef) : null;
  }

  private saveCart(cart: FlowCart, lines: CartLineRef[], editing: EditingRef | null | undefined): Promise<FlowCart> {
    return this.prisma.flowCart.update({
      where: { id: cart.id },
      data: {
        lines: lines as unknown as Prisma.InputJsonValue,
        ...(editing !== undefined && { editing: editing ? (editing as unknown as Prisma.InputJsonValue) : Prisma.DbNull }),
      },
    });
  }

  /**
   * Price every line from the DB. Lines whose product went out of stock or whose
   * measure was removed are dropped (and the cart is cleaned up).
   */
  private async priceCart(tenantId: string, cart: FlowCart): Promise<PricedLine[]> {
    const lines = this.linesOf(cart);
    if (lines.length === 0) return [];

    const products = await this.prisma.product.findMany({
      where: { tenantId, inStock: true, id: { in: [...new Set(lines.map((l) => l.sku))] } },
      include: { measures: true },
    });

    const priced = lines.flatMap((line) => {
      const product = products.find((p) => p.id === line.sku);
      const measureInfo = product && this.measuresOf(product).find((m) => m.code === line.measure);
      if (!product || !measureInfo) return [];
      return [{ ...line, product, measureInfo, total: orderTotals([{ unitPrice: measureInfo.price, quantity: line.qty }]).subtotal }];
    });

    if (priced.length !== lines.length) {
      await this.saveCart(cart, priced.map(({ sku, measure, qty }) => ({ sku, measure, qty })), undefined);
    }
    return priced;
  }

  /** A product's measures; products without any are sold as a single "Each" at their base price. */
  private measuresOf(product: CatalogProduct): Measure[] {
    if (product.measures.length === 0) {
      return [{ code: EACH_MEASURE, label: 'Each', price: product.price }];
    }
    return [...product.measures].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  private subtotal(lines: PricedLine[]): number {
    return orderTotals(lines.map((l) => ({ unitPrice: l.measureInfo.price, quantity: l.qty }))).subtotal;
  }

  // ───────────────────────── Categories ─────────────────────────

  /**
   * The predefined categories this shop has in-stock products in, so buyers never open an
   * empty category, after "All products" (every in-stock product, categorised or not).
   */
  private async listCategories(tenantId: string): Promise<Option[]> {
    const [categories, inStock] = await Promise.all([
      this.categoryService.listInStock(tenantId),
      this.prisma.product.count({ where: { tenantId, inStock: true } }),
    ]);

    // Always first, so every product (categorised or not) is one tap away.
    const all: Option = { id: ALL_PRODUCTS_ID, title: 'All products', description: `Everything in stock · ${plural(inStock, 'product')}` };
    return [
      all,
      ...categories.map((c) => ({
        id: c.id,
        title: truncate(c.title, LIMIT.optionTitle),
        ...(c.description ? { description: truncate(c.description, LIMIT.optionDescription) } : {}),
      })),
    ];
  }

  private async categoryTitle(categoryId: string): Promise<string> {
    if (categoryId === ALL_PRODUCTS_ID) return 'All products';
    return (await this.categoryService.titleOf(categoryId)) ?? 'Products';
  }

  private categoryWhere(tenantId: string, categoryId: string): Prisma.ProductWhereInput {
    return categoryId === ALL_PRODUCTS_ID ? { tenantId, inStock: true } : { tenantId, inStock: true, categoryId };
  }

  /** "Add more products" must land on a real category, not the reorder pseudo-category. */
  private async browsableCategory(tenantId: string, categoryId: string): Promise<string> {
    if (categoryId && categoryId !== REORDER_ID) return categoryId;
    const [first] = await this.listCategories(tenantId);
    return first?.id ?? ALL_PRODUCTS_ID;
  }

  // ───────────────────────── WELCOME ─────────────────────────

  private async welcomeScreen(tenant: Tenant, buyerPhone: string | null): Promise<Record<string, any>> {
    const categories = await this.listCategories(tenant.id);
    const reorder = buyerPhone ? await this.reorderOption(tenant.id, buyerPhone) : null;
    const options = (reorder ? [reorder, ...categories] : categories).slice(0, MAX_WELCOME_OPTIONS);

    // A NavigationList, so choosing where to start is a single tap.
    const rows = options.map((option) => ({
      id: option.id,
      'main-content': {
        title: truncate(option.title, LIMIT.navTitle),
        ...(option.description ? { metadata: truncate(option.description, LIMIT.navMetadata) } : {}),
      },
      'on-click-action': navAction('open_category', { category: option.id, page: 1 }),
    }));
    return screen('WELCOME', { categories: rows });
  }

  private lastOrderFor(tenantId: string, buyerPhone: string) {
    return this.prisma.order.findFirst({
      where: {
        tenantId,
        buyerPhone,
        status: { notIn: [OrderStatus.CANCELLED, OrderStatus.REFUNDED] },
        items: { some: { productId: { not: null } } },
      },
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    });
  }

  private async reorderOption(tenantId: string, buyerPhone: string): Promise<Option | null> {
    const order = await this.lastOrderFor(tenantId, buyerPhone);
    if (!order) return null;

    const date = order.createdAt
      .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Accra' })
      .replace(',', '');
    return {
      id: REORDER_ID,
      title: 'Repeat my last order',
      description: `${date} · ${plural(order.items.length, 'item')} · ${ghsCompact(order.totalAmount)}`,
    };
  }

  /** Copy the last order's lines into the cart at today's prices, dropping anything unavailable. */
  private async reorderLastOrder(tenant: Tenant, cart: FlowCart, buyerPhone: string | null) {
    const order = buyerPhone ? await this.lastOrderFor(tenant.id, buyerPhone) : null;
    const lines = [...this.linesOf(cart)];

    for (const item of order?.items ?? []) {
      if (!item.productId) continue;
      const measure = item.measureCode || EACH_MEASURE;
      const existing = lines.find((l) => l.sku === item.productId && l.measure === measure);
      if (existing) {
        existing.qty = Math.min(MAX_QTY, existing.qty + item.quantity);
      } else {
        lines.push({ sku: item.productId, measure, qty: Math.min(MAX_QTY, item.quantity) });
      }
    }

    // priceCart drops out-of-stock products and measures that no longer exist.
    const saved = await this.saveCart(cart, lines, null);
    return this.basketScreen(tenant, saved, REORDER_ID);
  }

  // ───────────────────────── CATALOGUE ─────────────────────────

  private async catalogueScreen(tenant: Tenant, cart: FlowCart, category: string, requestedPage: number) {
    const where = this.categoryWhere(tenant.id, category);
    const total = await this.prisma.product.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / PRODUCTS_PER_PAGE));
    const page = Math.min(requestedPage, totalPages);

    const [products, lines, title] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { measures: true },
        orderBy: { name: 'asc' },
        skip: (page - 1) * PRODUCTS_PER_PAGE,
        take: PRODUCTS_PER_PAGE,
      }),
      this.priceCart(tenant.id, cart),
      this.categoryTitle(category),
    ]);

    const subtotal = this.subtotal(lines);
    const basketBar = {
      id: 'basket',
      'main-content': {
        title: truncate(title, LIMIT.navTitle),
        description: `page ${page} of ${totalPages}`,
        metadata: lines.length ? 'Tap here to review your basket and check out' : 'Your basket is empty',
      },
      ...(lines.length
        ? {
            end: { title: ghsCompact(subtotal, LIMIT.navEnd) },
            badge: truncate(`${lines.length} in basket`, LIMIT.badge),
          }
        : {}),
      'on-click-action': navAction('open_basket', { category, page }),
    };

    const rows: Record<string, any>[] = products.map((product) => this.productRow(product, lines, category, page));

    if (rows.length === 0) {
      rows.push({
        id: NONE,
        'main-content': { title: 'No products here yet', description: 'try another' },
        'on-click-action': navAction('open_category', { category, page: 1 }),
      });
    }
    if (page > 1) {
      rows.push({
        id: 'prev_page',
        'main-content': { title: 'Previous products', description: `page ${page - 1} of ${totalPages}` },
        'on-click-action': navAction('open_category', { category, page: page - 1 }),
      });
    }
    if (page < totalPages) {
      const remaining = Math.min(PRODUCTS_PER_PAGE, total - page * PRODUCTS_PER_PAGE);
      rows.push({
        id: 'next_page',
        'main-content': { title: `Next ${remaining} products`, description: `page ${page + 1} of ${totalPages}` },
        'on-click-action': navAction('open_category', { category, page: page + 1 }),
      });
    }

    return screen('CATALOGUE', { category, page: String(page), basket_bar: [basketBar], products: rows });
  }

  private productRow(product: CatalogProduct, lines: PricedLine[], category: string, page: number) {
    const measures = this.measuresOf(product);
    const cheapest = Math.min(...measures.map((m) => m.price));
    const inBasket = lines.filter((l) => l.sku === product.id);
    const qty = inBasket.reduce((sum, l) => sum + l.qty, 0);
    const total = inBasket.reduce((sum, l) => sum + l.total, 0);

    // WhatsApp rejects a NavigationList where only some rows have `end`, so the basket
    // count goes in the metadata line instead.
    const metadata = qty > 0 ? `✓ ${qty} in basket · ${ghsCompact(total)}` : measures.map((m) => m.label).join(' · ');
    return {
      id: product.id,
      'main-content': {
        title: truncate(product.name, LIMIT.navTitle),
        description: `from ${ghsCompact(cheapest, LIMIT.navDescription - 5)}`,
        metadata: truncate(metadata, LIMIT.navMetadata),
      },
      'on-click-action': navAction('open_product', { sku: product.id, category, page }),
    };
  }

  // ───────────────────────── PRODUCT ─────────────────────────

  private async productScreen(tenant: Tenant, cart: FlowCart, sku: string, measure: string, category: string, page: number) {
    const product = sku
      ? await this.prisma.product.findFirst({ where: { id: sku, tenantId: tenant.id, inStock: true }, include: { measures: true } })
      : null;
    if (!product) {
      return this.catalogueScreen(tenant, cart, category, page);
    }

    const lines = this.linesOf(cart);
    const fromBasket = measure !== NONE && lines.some((l) => l.sku === sku && l.measure === measure);
    const line = fromBasket ? lines.find((l) => l.sku === sku && l.measure === measure) : lines.find((l) => l.sku === sku);

    const measures = this.measuresOf(product);
    const options: Option[] = measures.map((m) => ({
      id: m.code,
      title: truncate(`${m.label} · ${ghsCompact(m.price)}`, LIMIT.optionTitle),
      ...(m.description ? { description: truncate(m.description, LIMIT.optionDescription) } : {}),
    }));
    if (line) {
      options.push({ id: REMOVE_MEASURE, title: 'Remove from basket' });
    }

    const currentMeasure = line && measures.some((m) => m.code === line.measure) ? line.measure : measures[0].code;
    await this.saveCart(cart, lines, { sku, measure: line?.measure ?? null, fromBasket });

    return screen('PRODUCT', {
      category,
      page: String(page),
      sku: product.id,
      name: truncate(product.name, LIMIT.subheading),
      photo: PLACEHOLDER_PHOTO,
      note: truncate(product.note?.trim() || 'Choose a measure and how many you want.', LIMIT.caption),
      measures: options,
      qty_options: QTY_OPTIONS,
      current_measure: currentMeasure,
      current_qty: String(Math.min(MAX_QTY, line?.qty ?? 1)),
      button_label: line ? 'Update basket' : 'Add to basket',
    });
  }

  /**
   * "Add to basket" / "Update basket". Quantities replace (never add to) the line, and
   * a changed measure replaces the line that was being edited.
   */
  private async addLine(tenant: Tenant, cart: FlowCart, data: Record<string, any>, category: string, page: number) {
    const sku = text(data.sku);
    const measure = text(data.measure);
    const qty = Math.min(MAX_QTY, normalizeQuantity(data.qty));
    const editing = this.editingOf(cart);
    const editingThis = editing?.sku === sku ? editing : null;
    let lines = this.linesOf(cart);

    if (measure === REMOVE_MEASURE) {
      // From BASKET only the tapped line goes; from CATALOGUE the row stands for the whole product.
      lines = editingThis?.fromBasket && editingThis.measure
        ? lines.filter((l) => !(l.sku === sku && l.measure === editingThis.measure))
        : lines.filter((l) => l.sku !== sku);
    } else {
      const product = await this.prisma.product.findFirst({
        where: { id: sku, tenantId: tenant.id, inStock: true },
        include: { measures: true },
      });
      if (!product || !this.measuresOf(product).some((m) => m.code === measure)) {
        this.logger.warn(`add_line ignored: unknown sku "${sku}" or measure "${measure}".`);
        return this.catalogueScreen(tenant, await this.saveCart(cart, lines, null), category, page);
      }
      if (editingThis?.measure && editingThis.measure !== measure) {
        lines = lines.filter((l) => !(l.sku === sku && l.measure === editingThis.measure));
      }
      // Re-append so the line counts as the most recent one on BASKET.
      lines = [...lines.filter((l) => !(l.sku === sku && l.measure === measure)), { sku, measure, qty }];
    }

    const saved = await this.saveCart(cart, lines, null);
    return editingThis?.fromBasket ? this.basketScreen(tenant, saved, category) : this.catalogueScreen(tenant, saved, category, page);
  }

  // ───────────────────────── BASKET ─────────────────────────

  private async basketScreen(tenant: Tenant, cart: FlowCart, requestedCategory: string) {
    const [lines, category] = await Promise.all([
      this.priceCart(tenant.id, cart),
      this.browsableCategory(tenant.id, requestedCategory),
    ]);

    const checkoutBar = lines.length
      ? {
          id: 'checkout',
          'main-content': {
            title: 'Checkout',
            description: `Total ${ghsCompact(this.subtotal(lines), LIMIT.navDescription - 6)}`,
            metadata: 'Delivery and payment are next',
          },
          badge: truncate(plural(lines.length, 'item'), LIMIT.badge),
          'on-click-action': navAction('build_summary', { category, page: 1 }),
        }
      : {
          id: 'checkout',
          'main-content': { title: 'Basket is empty', description: 'add something' },
          'on-click-action': navAction('open_category', { category, page: 1 }),
        };

    const rows: Record<string, any>[] = lines
      .slice(-BASKET_LINES_SHOWN)
      .reverse()
      .map((line) => ({
        id: `${line.sku}:${line.measure}`,
        'main-content': {
          title: truncate(line.product.name, LIMIT.navTitle),
          description: truncate(this.quantityLabel(line), LIMIT.navDescription),
          metadata: 'Tap to change or remove',
        },
        end: { title: ghsCompact(line.total, LIMIT.navEnd) },
        'on-click-action': navAction('open_product', { sku: line.sku, measure: line.measure, category, page: 1 }),
      }));

    // Kept with Checkout rather than under the lines: every basket line has `end`, and
    // WhatsApp rejects a NavigationList where only some rows do. An empty basket shows it
    // as the only row in `lines`, since a list cannot be empty.
    const addMore = {
      id: 'more',
      'main-content': { title: 'Add more products', description: 'back to the shop' },
      'on-click-action': navAction('open_category', { category, page: 1 }),
    };

    return lines.length
      ? screen('BASKET', { category, checkout_bar: [checkoutBar, addMore], lines: rows })
      : screen('BASKET', { category, checkout_bar: [checkoutBar], lines: [addMore] });
  }

  /** "2 baskets", "1 olonka", or "×3" for products sold individually. */
  private quantityLabel(line: PricedLine): string {
    if (line.measure === EACH_MEASURE) return `×${line.qty}`;
    const label = line.measureInfo.label.toLowerCase();
    return line.qty === 1 || label.endsWith('s') ? `${line.qty} ${label}` : `${line.qty} ${label}s`;
  }

  // ───────────────────────── CHECKOUT ─────────────────────────

  private deliveryAreas(tenant: Tenant): Option[] {
    const areas = this.optionList(tenant.deliveryAreas);
    return areas.length ? areas : [FALLBACK_AREA];
  }

  /** The Flow pre-selects "asap", so it is always first in the list. */
  private deliverySlots(tenant: Tenant): Option[] {
    const slots = this.optionList(tenant.deliverySlots);
    const asap = slots.find((s) => s.id === ASAP_SLOT_ID) ?? DEFAULT_ASAP_SLOT;
    return [asap, ...slots.filter((s) => s.id !== ASAP_SLOT_ID)];
  }

  private optionList(value: Prisma.JsonValue): Option[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((raw: any) => {
      if (!raw || typeof raw.id !== 'string' || typeof raw.title !== 'string' || !raw.id || !raw.title) return [];
      return [{
        id: raw.id,
        title: truncate(raw.title, LIMIT.optionTitle),
        ...(typeof raw.description === 'string' && raw.description ? { description: truncate(raw.description, LIMIT.optionDescription) } : {}),
      }];
    });
  }

  private checkoutTotals(tenant: Tenant, lines: PricedLine[]) {
    return orderTotals(
      lines.map((l) => ({ unitPrice: l.measureInfo.price, quantity: l.qty })),
      Number(tenant.deliveryFee ?? 0),
    );
  }

  /**
   * `submitted` is the form the buyer just sent, when CHECKOUT is shown again with a
   * warning, so nothing they typed is lost.
   */
  private async checkoutScreen(tenant: Tenant, cart: FlowCart, category: string, notice?: string, submitted?: Record<string, any>) {
    const lines = await this.priceCart(tenant.id, cart);
    if (lines.length === 0) {
      return this.basketScreen(tenant, cart, category);
    }

    const totals = this.checkoutTotals(tenant, lines);
    const fee = totals.deliveryFee > 0 ? ` incl. ${ghsCompact(totals.deliveryFee)} delivery` : '';
    const summary = `Total ${ghsCompact(totals.total)}${fee} · ${plural(lines.length, 'item')}`;
    const areas = this.deliveryAreas(tenant);
    const slots = this.deliverySlots(tenant);

    return screen('CHECKOUT', {
      cart_id: cart.id,
      total_text: truncate(notice ? `${notice} · ${summary}` : summary, LIMIT.subheading),
      delivery_areas: areas,
      delivery_slots: slots,
      payment_methods: PAYMENT_METHODS,
      ...(await this.checkoutPrefill(tenant.id, cart.buyerPhone, areas, slots, submitted)),
    });
  }

  /**
   * Initial values for every CHECKOUT field, so a repeat buyer only has to confirm:
   * what they just submitted, else their last Flow order, else their WhatsApp number.
   * Dropdown and radio values must be one of the offered ids.
   */
  private async checkoutPrefill(
    tenantId: string,
    buyerPhone: string,
    areas: Option[],
    slots: Option[],
    submitted: Record<string, any> = {},
  ) {
    const last = buyerPhone
      ? await this.prisma.order.findFirst({
          where: { tenantId, buyerPhone, flowCartId: { not: null } },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    const whatsapp = buyerPhone && !isHiddenNumber(buyerPhone) ? toGhanaLocal(buyerPhone) : '';
    const typed = (field: string) => text(submitted[field]);
    const offered = (options: Option[], id: unknown) => options.find((o) => o.id === id)?.id;

    const lastPaidCash = last?.paymentMethod === PaymentMethod.COD;
    return {
      init_full_name: typed('full_name') || last?.customerName || '',
      init_area: offered(areas, submitted.delivery_area) ?? areas.find((a) => a.title === last?.deliveryArea)?.id ?? areas[0].id,
      init_landmark: typed('landmark') || last?.landmark || '',
      init_phone: typed('rider_phone') || (last?.contactPhone ? toGhanaLocal(last.contactPhone) : whatsapp),
      init_slot: offered(slots, submitted.delivery_slot) ?? slots[0].id,
      init_payment: offered(PAYMENT_METHODS, submitted.payment) ?? (lastPaidCash ? 'cash' : 'momo'),
      init_momo: typed('momo_number') || last?.paymentPhone || whatsapp,
    };
  }

  // ───────────────────────── place_order -> ORDER_RECEIVED ─────────────────────────

  /**
   * Create the order. Idempotent per cart: buyers double-tap on slow networks and Meta
   * retries timeouts, so a repeat call returns the order that already exists.
   * The MoMo prompt is sent later, when the buyer taps Done (see completeOrder).
   */
  private async placeOrder(tenant: Tenant, cart: FlowCart, data: Record<string, any>, buyerPhone: string | null) {
    const existing = await this.orderService.findByFlowCart(cart.id);
    if (existing) {
      return this.orderReceivedScreen(existing);
    }
    if (data.cart_id && data.cart_id !== cart.id) {
      this.logger.warn(`place_order cart_id ${data.cart_id} does not match cart ${cart.id}; using the token's cart.`);
    }

    const lines = await this.priceCart(tenant.id, cart);
    if (lines.length === 0) {
      return this.basketScreen(tenant, cart, REORDER_ID);
    }

    const paymentMethod = data.payment === 'cash' ? PaymentMethod.COD : PaymentMethod.MOMO;
    const momoNumber = toGhanaLocal(text(data.momo_number));
    if (paymentMethod === PaymentMethod.MOMO && !isGhanaMobile(momoNumber)) {
      return this.checkoutScreen(tenant, cart, REORDER_ID, '⚠️ Enter a valid 10-digit MoMo number', data);
    }

    const area = this.deliveryAreas(tenant).find((a) => a.id === data.delivery_area);
    const slot = this.deliverySlots(tenant).find((s) => s.id === data.delivery_slot) ?? this.deliverySlots(tenant)[0];
    const areaTitle = area?.title ?? text(data.delivery_area);
    const landmark = text(data.landmark);
    const totals = this.checkoutTotals(tenant, lines);

    const orderInput = {
      buyerPhone: buyerPhone || 'unknown',
      status: paymentMethod === PaymentMethod.COD ? OrderStatus.CONFIRMED : OrderStatus.AWAITING_PAYMENT,
      paymentMethod,
      paymentPhone: paymentMethod === PaymentMethod.MOMO ? momoNumber : undefined,
      momoNetwork: paymentMethod === PaymentMethod.MOMO ? (ghanaMomoNetwork(momoNumber) ?? 'mtn') : undefined,
      fulfillment: Fulfillment.DELIVERY,
      deliveryAddress: [areaTitle, landmark].filter(Boolean).join(' — '),
      deliveryFee: totals.deliveryFee,
      items: lines.map((l) => ({
        productId: l.product.id,
        productName: l.measure === EACH_MEASURE ? l.product.name : `${l.product.name} (${l.measureInfo.label})`,
        measureCode: l.measure,
        unitPrice: l.measureInfo.price,
        quantity: l.qty,
      })),
    };
    const details = {
      customerName: text(data.full_name) || null,
      deliveryArea: areaTitle || null,
      landmark: landmark || null,
      contactPhone: text(data.rider_phone) ? toE164(text(data.rider_phone)) : null,
      deliverySlot: slot.title,
      flowCartId: cart.id,
    };

    let order;
    try {
      order = await this.orderService.createOrder(tenant.id, orderInput, details);
    } catch (err) {
      // A concurrent place_order for the same cart won the unique flowCartId race; it
      // owns the MoMo prompt and the fallback, so just show its order.
      const raced = await this.orderService.findByFlowCart(cart.id);
      if (!raced) throw err;
      return this.orderReceivedScreen(raced);
    }

    await this.saveCart(cart, this.linesOf(cart), null);
    this.logger.log(`Flow order ${order.orderNumber} placed for cart ${cart.id} (${paymentMethod}).`);
    void this.notifications.orderAlert(tenant, order);
    // The MoMo prompt pops up over WhatsApp, so it starts now, in the background: the Flow
    // response must not wait for Paystack (Meta times out at 10s).
    this.pendingPrompts.set(order.id, this.requestPayment(tenant, order).catch(() => ''));
    if (buyerPhone) {
      this.scheduleConfirmationFallback(tenant, order.orderNumber, buyerPhone);
    }
    return this.orderReceivedScreen(order);
  }

  /**
   * Receipt and pin request normally go out on Done, so they land at the bottom of the chat
   * once the buyer is back in it. This covers buyers who close the Flow instead. The timer
   * lives in memory, so a restart within the window skips it for that order.
   */
  private scheduleConfirmationFallback(tenant: Tenant, orderNumber: string, buyerPhone: string) {
    const timer = setTimeout(() => {
      const handler = this.confirmationHandler;
      handler?.(tenant, orderNumber, buyerPhone).catch((err) =>
        this.logger.warn(`Fallback confirmation for ${orderNumber} failed: ${err?.message || err}`),
      );
    }, CONFIRMATION_FALLBACK_MS);
    timer.unref?.();
  }

  private orderReceivedScreen(order: {
    orderNumber: string;
    totalAmount: number;
    paymentMethod: PaymentMethod | null;
    paymentPhone: string | null;
    deliverySlot: string | null;
  }) {
    const total = ghsCompact(order.totalAmount);
    const momo = order.paymentMethod === PaymentMethod.MOMO;

    return screen('ORDER_RECEIVED', {
      order_id: order.orderNumber,
      total_text: total,
      eta_text: truncate(`Delivery: ${order.deliverySlot || 'as soon as possible'}.`, LIMIT.subheading),
      // The MoMo prompt goes out as the order is placed; the pin request follows Done.
      payment_note: truncate(
        momo
          ? `Approve the MoMo prompt we sent to ${formatGhanaLocal(order.paymentPhone ?? '')}.`
          : `Pay ${total} in cash to the rider.`,
        LIMIT.subheading,
      ),
      next_step: momo ? 'Then tap Done and share your location pin.' : 'Tap Done and share your location pin so the rider finds you.',
    });
  }
}
