import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { FlowCryptoService, DecryptedFlowPayload, EncryptedFlowRequest } from './flow-crypto.service.js';
import { OrderStatus } from '@prisma/client';
import { PaystackService } from '../payment/paystack.service.js';

export interface CartItem {
  id: string;
  title: string;
  qty: number;
  unitPrice: number;
  total: number;
}

export interface FlowSessionState {
  selectedIds: Set<string>;
  lastVisibleIds: string[];
  cartItems?: CartItem[];
  fulfillment?: string;
  address?: string;
  paymentMethod?: string;
  momoNetwork?: string;
  momoNumber?: string;
  category?: string;
  query?: string;
  page?: number;
  subtotal?: number;
  deliveryFee?: number;
  totalAmount?: number;
  orderRef?: string;
  updatedAt: number;
}

@Injectable()
export class FlowService {
  private readonly productsPerPage = 5;
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
  ) {}

  /**
   * Process an incoming encrypted Meta WhatsApp Flow request and return encrypted response string.
   */
  async processEncryptedFlowRequest(body: EncryptedFlowRequest): Promise<string> {
    const privateKeyPem = process.env.META_FLOW_PRIVATE_KEY;
    const passphrase = process.env.META_FLOW_PASSPHRASE;

    if (!privateKeyPem) {
      this.logger.error('META_FLOW_PRIVATE_KEY is not configured in environment variables.');
      throw new BadRequestException('Flow encryption key not configured');
    }

    // 1. Decrypt request
    const { decryptedPayload, aesKey, iv } = this.flowCrypto.decryptRequest(
      body,
      privateKeyPem,
      passphrase,
    );

    this.logger.log(`Received Decrypted Flow Request: ${JSON.stringify(decryptedPayload)}`);

    // 2. Process action and generate response screen state payload
    const responsePayload = await this.handleFlowAction(decryptedPayload);

    this.logger.log(`Generated Flow Response: ${JSON.stringify(responsePayload)}`);

    // 3. Encrypt response back for Meta
    return this.flowCrypto.encryptResponse(responsePayload, aesKey, iv);
  }

  /**
   * Core logic for dynamic screen navigation for Marketix Groceries WhatsApp Flow JSON.
   * Screens: PRODUCT_SELECT -> QUANTITIES -> CHECKOUT -> DONE
   */
  async handleFlowAction(payload: DecryptedFlowPayload): Promise<Record<string, any>> {
    const { action, screen, data, flow_token } = payload;

    // Handle Health Ping from Meta
    if (action === 'ping') {
      return {
        version: '3.0',
        data: {
          status: 'active',
        },
      };
    }

    // Extract tenantId and buyerPhone from flow_token (format: "tenantId:buyerPhone:timestamp" or "tenantId:timestamp")
    let tenantId: string | null = null;
    let buyerPhoneFromToken: string | null = null;
    if (flow_token && flow_token.includes(':')) {
      const parts = flow_token.split(':');
      tenantId = parts[0];
      if (parts.length >= 3) {
        buyerPhoneFromToken = parts[1];
      }
    }

    const tenant = tenantId
      ? await this.prisma.tenant.findUnique({ where: { id: tenantId } })
      : await this.prisma.tenant.findFirst({ where: { status: 'ACTIVE' } });

    if (!tenant) {
      throw new BadRequestException(
        `No tenant found for flow_token "${flow_token ?? '(none)'}". Ensure the token is in the format "tenantId:timestamp".`,
      );
    }

    const sessionKey = flow_token ? String(flow_token).trim() : (tenant?.id || 'default');

    // Clean up expired sessions (> 2 hours)
    if (this.flowSessions.size > 200) {
      const now = Date.now();
      for (const [key, sess] of this.flowSessions.entries()) {
        if (now - sess.updatedAt > 2 * 60 * 60 * 1000) {
          this.flowSessions.delete(key);
        }
      }
    }

    let session = this.flowSessions.get(sessionKey);
    if (!session) {
      session = {
        selectedIds: new Set<string>(),
        lastVisibleIds: [],
        category: 'all',
        query: '',
        page: 1,
        updatedAt: Date.now(),
      };
      this.flowSessions.set(sessionKey, session);
    } else {
      session.updatedAt = Date.now();
    }

    const buildWhereClause = (cat: string, q: string) => {
      const where: Record<string, any> = { tenantId: tenant.id, inStock: true };
      const conditions: any[] = [];

      if (q && q.trim()) {
        conditions.push({ name: { contains: q.trim(), mode: 'insensitive' } });
      }

      if (cat && cat !== 'all' && this.categoryKeywords[cat]) {
        conditions.push({
          OR: this.categoryKeywords[cat].map((kw) => ({
            name: { contains: kw, mode: 'insensitive' },
          })),
        });
      }

      if (conditions.length === 1) {
        Object.assign(where, conditions[0]);
      } else if (conditions.length > 1) {
        where.AND = conditions;
      }

      return where;
    };

    // 1. INIT Action: Opening Flow on screen "PRODUCT_SELECT"
    if (action === 'INIT') {
      session.selectedIds.clear();
      session.lastVisibleIds = [];
      session.cartItems = [];
      session.category = 'all';
      session.query = '';
      session.page = 1;

      return this.buildProductSelectScreen(tenant.id, session, 1, 'all', '');
    }

    // 2. DATA_EXCHANGE Action: Handling screen transitions and interactions
    if (action === 'data_exchange') {
      // Sync incoming selected items from current page checkboxes
      this.syncProductSelection(session, data);

      const step =
        data?.step ||
        data?.flow_action ||
        data?.action ||
        (data?.category !== undefined && !data?.cart ? 'set_category' : undefined) ||
        (data?.query !== undefined && !data?.cart ? 'search' : undefined) ||
        (data?.page !== undefined && !data?.cart ? 'go_page' : undefined);

      // Step A: Category Change
      if (step === 'set_category') {
        const newCat = typeof data?.category === 'string' ? data.category.trim() : 'all';
        const currentQuery = typeof data?.query === 'string' ? data.query.trim() : (session.query || '');
        session.category = newCat;
        session.query = currentQuery;
        session.page = 1;
        return this.buildProductSelectScreen(tenant.id, session, 1, newCat, currentQuery);
      }

      // Step B: Search / Show All
      if (step === 'search') {
        const newQuery = typeof data?.query === 'string'
          ? data.query.trim()
          : (typeof data?.search_query === 'string' ? data.search_query.trim() : '');
        const currentCat = typeof data?.category === 'string' ? data.category.trim() : (session.category || 'all');
        session.query = newQuery;
        session.category = currentCat;
        session.page = 1;
        return this.buildProductSelectScreen(tenant.id, session, 1, currentCat, newQuery);
      }

      // Step C: Page Navigation
      if (step === 'go_page' || step === 'next_page' || step === 'previous_page') {
        const currentCat = typeof data?.category === 'string' ? data.category.trim() : (session.category || 'all');
        const currentQuery = typeof data?.query === 'string' ? data.query.trim() : (session.query || '');
        const reqPage = step === 'next_page'
          ? (session.page || 1) + 1
          : step === 'previous_page'
            ? (session.page || 1) - 1
            : parseInt(String(data?.page || data?.page_select || '1'), 10);

        session.page = Math.max(1, reqPage || 1);
        return this.buildProductSelectScreen(tenant.id, session, session.page, currentCat, currentQuery);
      }

      // Step D: Continue -> PRODUCT_SELECT to QUANTITIES
      if (step === 'continue') {
        const selectedIds = Array.from(session.selectedIds);
        if (selectedIds.length === 0) {
          return this.buildProductSelectScreen(
            tenant.id,
            session,
            session.page || 1,
            session.category || 'all',
            session.query || '',
            '⚠️ Please select at least one item before continuing.',
            true,
          );
        }

        return this.buildQuantitiesScreen(tenant.id, session);
      }

      // Step E: Quantities Submitted -> QUANTITIES to SUMMARY
      if (step === 'quantities' || screen === 'QUANTITIES') {
        return this.buildSummaryScreen(tenant.id, session, data);
      }

      // Step F: Continue to Payment -> SUMMARY to PAYMENT
      if (step === 'to_payment') {
        return this.handleToPayment(session, data);
      }

      // Step G: Pay / Place Order on PAYMENT screen -> to DONE
      if (step === 'pay') {
        return this.handlePay(tenant.id, session, data, flow_token, buyerPhoneFromToken);
      }

      // Fallback for screens if on that screen without specific step
      if (screen === 'PRODUCT_SELECT') {
        return this.buildProductSelectScreen(
          tenant.id,
          session,
          session.page || 1,
          session.category || 'all',
          session.query || '',
        );
      }

      if (screen === 'QUANTITIES') {
        return this.buildQuantitiesScreen(tenant.id, session);
      }

      if (screen === 'SUMMARY') {
        return this.buildSummaryScreen(tenant.id, session, data);
      }

      if (screen === 'PAYMENT') {
        return this.buildPaymentScreen(session);
      }

      if (screen === 'DONE') {
        return {
          version: '3.0',
          screen: 'DONE',
          data: {
            order_ref: session.orderRef || this.generateOrderRef(),
            done_message: "Order placed. We'll message you on WhatsApp with updates.",
          },
        };
      }
    }

    // Default fallback: return current screen
    return {
      version: '3.0',
      screen: screen || 'PRODUCT_SELECT',
      data: {
        ...data,
      },
    };
  }

  /**
   * Syncs checkbox selections between pages.
   */
  private syncProductSelection(session: FlowSessionState, data?: Record<string, any>) {
    const rawSelected = data?.selected_on_page ?? data?.selected_products;
    const currentOnPageIds = Array.isArray(rawSelected)
      ? rawSelected.filter((id): id is string => typeof id === 'string')
      : [];

    const visibleIds = session.lastVisibleIds || [];
    if (visibleIds.length > 0) {
      for (const id of visibleIds) {
        session.selectedIds.delete(id);
      }
      for (const id of currentOnPageIds) {
        session.selectedIds.add(id);
      }
    } else if (currentOnPageIds.length > 0) {
      for (const id of currentOnPageIds) {
        session.selectedIds.add(id);
      }
    }
  }

  /**
   * Build PRODUCT_SELECT screen payload matching user flow JSON schema.
   */
  private async buildProductSelectScreen(
    tenantId: string,
    session: FlowSessionState,
    requestedPage: number,
    cat: string,
    q: string,
    notice = ' ',
    showNotice = false,
  ): Promise<Record<string, any>> {
    const where: Record<string, any> = { tenantId, inStock: true };
    const conditions: any[] = [];

    if (q && q.trim()) {
      conditions.push({ name: { contains: q.trim(), mode: 'insensitive' } });
    }

    if (cat && cat !== 'all' && this.categoryKeywords[cat]) {
      conditions.push({
        OR: this.categoryKeywords[cat].map((kw) => ({
          name: { contains: kw, mode: 'insensitive' },
        })),
      });
    }

    if (conditions.length === 1) {
      Object.assign(where, conditions[0]);
    } else if (conditions.length > 1) {
      where.AND = conditions;
    }

    const total = await this.prisma.product.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / this.productsPerPage));
    const page = Math.min(Math.max(requestedPage, 1), totalPages);

    const products = await this.prisma.product.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * this.productsPerPage,
      take: this.productsPerPage,
    });

    const pageProducts = products.map((p) => ({
      id: p.id,
      title: this.formatProductTitle(p.name, p.image),
      description: `₵${p.price.toFixed(2)}`,
    }));

    session.lastVisibleIds = pageProducts.map((p) => p.id);
    session.page = page;
    session.category = cat;
    session.query = q;

    const allSelectedArray = Array.from(session.selectedIds);
    const onPageSelected = pageProducts
      .map((p) => p.id)
      .filter((id) => session.selectedIds.has(id));

    const pages = Array.from({ length: totalPages }, (_, index) => ({
      id: String(index + 1),
      title: `Page ${index + 1} of ${totalPages}`,
    }));

    return {
      version: '3.0',
      screen: 'PRODUCT_SELECT',
      data: {
        categories: this.flowCategories,
        category_prefill: cat,
        pages,
        page_prefill: String(page),
        products: pageProducts,
        pre_selected: onPageSelected,
        page_label: `${total} products`,
        selection_note: allSelectedArray.length
          ? `🛒 ${allSelectedArray.length} item(s) selected`
          : '🛒 Your basket is empty — tap items to add',
        search_prefill: q || ' ',
        notice: notice || ' ',
        show_notice: showNotice,
      },
    };
  }

  /**
   * Build QUANTITIES screen payload matching user flow JSON schema (slots item_0 to item_9).
   */
  private async buildQuantitiesScreen(
    tenantId: string,
    session: FlowSessionState,
  ): Promise<Record<string, any>> {
    const selectedIds = Array.from(session.selectedIds);
    const selectedProducts = await this.prisma.product.findMany({
      where: {
        tenantId,
        inStock: true,
        id: { in: selectedIds },
      },
      orderBy: { createdAt: 'desc' },
    });

    const defaultQtyOptions = Array.from({ length: 10 }, (_, i) => ({
      id: String(i + 1),
      title: String(i + 1),
    }));

    const quantitiesData: Record<string, any> = {};

    for (let i = 0; i < 10; i++) {
      const product = selectedProducts[i];
      if (product) {
        const rawTitle = this.formatProductTitle(product.name, product.image);
        let label = rawTitle;
        if (label.length > 20) {
          let sliced = label.slice(0, 17);
          const lastCharCode = sliced.charCodeAt(sliced.length - 1);
          if (lastCharCode >= 0xd800 && lastCharCode <= 0xdbff) {
            sliced = sliced.slice(0, -1);
          }
          label = `${sliced}...`;
        }

        quantitiesData[`item_${i}_id`] = product.id;
        quantitiesData[`item_${i}_label`] = label;
        quantitiesData[`item_${i}_helper`] = `₵${product.price.toFixed(2)} each`;
        quantitiesData[`show_${i}`] = true;
        quantitiesData[`item_${i}_options`] = defaultQtyOptions;
        quantitiesData[`item_${i}_default`] = '1';
      } else {
        quantitiesData[`item_${i}_id`] = ' ';
        quantitiesData[`item_${i}_label`] = ' ';
        quantitiesData[`item_${i}_helper`] = ' ';
        quantitiesData[`show_${i}`] = false;
        quantitiesData[`item_${i}_options`] = [{ id: '1', title: '1' }];
        quantitiesData[`item_${i}_default`] = '1';
      }
    }

    return {
      version: '3.0',
      screen: 'QUANTITIES',
      data: quantitiesData,
    };
  }

  /**
   * Build SUMMARY screen payload matching user flow JSON schema.
   */
  private async buildSummaryScreen(
    tenantId: string,
    session: FlowSessionState,
    data?: Record<string, any>,
    errorMessage = ' ',
    showError = false,
  ): Promise<Record<string, any>> {
    const itemSlots: Array<{ id: string; qty: number }> = [];

    for (let i = 0; i < 10; i++) {
      const itemId = String(data?.[`i${i}_id`] ?? data?.[`item_${i}_id`] ?? '').trim();
      const rawQty = data?.[`i${i}_qty`] ?? data?.[`item_${i}_qty`] ?? data?.[`qty_${i}`];
      if (itemId && itemId !== ' ') {
        const qty = Math.max(1, parseInt(String(rawQty || '1'), 10) || 1);
        itemSlots.push({ id: itemId, qty });
      }
    }

    let cartItems: CartItem[] = [];
    let subtotal = 0;
    const summaryLinesArr: string[] = [];

    if (itemSlots.length > 0) {
      const ids = itemSlots.map((s) => s.id);
      const dbProducts = await this.prisma.product.findMany({
        where: { tenantId, inStock: true, id: { in: ids } },
      });

      for (const slot of itemSlots) {
        const p = dbProducts.find((prod) => prod.id === slot.id);
        if (!p) continue;

        const lineTotal = p.price * slot.qty;
        subtotal += lineTotal;
        const formattedTitle = this.formatProductTitle(p.name, p.image);
        cartItems.push({
          id: p.id,
          title: formattedTitle,
          qty: slot.qty,
          unitPrice: p.price,
          total: lineTotal,
        });

        summaryLinesArr.push(`${formattedTitle}: ${slot.qty} × ₵${p.price.toFixed(2)} = ₵${lineTotal.toFixed(2)}`);
      }
      session.cartItems = cartItems;
    } else if (session.cartItems && session.cartItems.length > 0) {
      cartItems = session.cartItems;
      subtotal = cartItems.reduce((acc, i) => acc + (i.total || i.unitPrice * i.qty || 0), 0);
      for (const i of cartItems) {
        summaryLinesArr.push(`${i.title}: ${i.qty} × ₵${Number(i.unitPrice).toFixed(2)} = ₵${Number(i.total).toFixed(2)}`);
      }
    }

    const fulfillment = session.fulfillment || 'delivery';
    const deliveryFee = fulfillment === 'delivery' ? 5.0 : 0.0;
    const total = subtotal + deliveryFee;

    session.subtotal = subtotal;
    session.deliveryFee = deliveryFee;
    session.totalAmount = total;

    const summaryLines = summaryLinesArr.length > 0 ? summaryLinesArr.join('\n') : 'No items selected.';
    const orderTotalStr = fulfillment === 'delivery'
      ? `💰 Total: ₵${total.toFixed(2)} (incl. ₵${deliveryFee.toFixed(2)} delivery)`
      : `💰 Total: ₵${total.toFixed(2)} (Pickup)`;

    return {
      version: '3.0',
      screen: 'SUMMARY',
      data: {
        summary_lines: summaryLines,
        order_total: orderTotalStr,
        cart_json: JSON.stringify(cartItems),
        error_message: errorMessage || ' ',
        show_error: showError,
        fulfillment_prefill: fulfillment,
        pickup_note: 'Pick up at Marketix Store, Osu. Ready in about 30 minutes.',
      },
    };
  }

  /**
   * Handle transition from SUMMARY to PAYMENT screen.
   */
  private handleToPayment(
    session: FlowSessionState,
    data?: Record<string, any>,
  ): Record<string, any> {
    const rawCart = data?.cart;
    let cartItems: CartItem[] = [];
    try {
      cartItems = typeof rawCart === 'string' ? JSON.parse(rawCart) : (Array.isArray(rawCart) ? rawCart : []);
    } catch {
      cartItems = session.cartItems || [];
    }

    if (cartItems.length > 0) {
      session.cartItems = cartItems;
    } else {
      cartItems = session.cartItems || [];
    }

    const fulfillment = typeof data?.fulfillment === 'string' ? data.fulfillment.trim() : 'delivery';
    const address = typeof data?.address === 'string' ? data.address.trim() : '';

    const subtotal = cartItems.reduce((acc, i) => acc + (i.total || (i.unitPrice * i.qty) || 0), 0);
    const deliveryFee = fulfillment === 'delivery' ? 5.0 : 0.0;
    const total = subtotal + deliveryFee;

    session.fulfillment = fulfillment;
    session.address = address;
    session.subtotal = subtotal;
    session.deliveryFee = deliveryFee;
    session.totalAmount = total;

    // Validate delivery address
    if (fulfillment === 'delivery' && !address) {
      const summaryLines = cartItems.length > 0
        ? cartItems.map((i) => `${i.title}: ${i.qty} × ₵${Number(i.unitPrice).toFixed(2)} = ₵${Number(i.total).toFixed(2)}`).join('\n')
        : ' ';

      return {
        version: '3.0',
        screen: 'SUMMARY',
        data: {
          summary_lines: summaryLines,
          order_total: `💰 Total: ₵${total.toFixed(2)} (incl. ₵5.00 delivery)`,
          cart_json: JSON.stringify(cartItems),
          error_message: '⚠️ Please enter your delivery address / landmark before continuing.',
          show_error: true,
          fulfillment_prefill: fulfillment,
          pickup_note: 'Pick up at Marketix Store, Osu. Ready in about 30 minutes.',
        },
      };
    }

    return this.buildPaymentScreen(session);
  }

  /**
   * Build PAYMENT screen payload matching user flow JSON schema.
   */
  private buildPaymentScreen(
    session: FlowSessionState,
    errorMessage = ' ',
    showError = false,
  ): Record<string, any> {
    const total = session.totalAmount || 0;
    const networks = [
      { id: 'mtn', title: 'MTN MoMo' },
      { id: 'telecel', title: 'Telecel Cash' },
      { id: 'airteltigo', title: 'AirtelTigo Money' },
    ];

    return {
      version: '3.0',
      screen: 'PAYMENT',
      data: {
        order_total: `Total: ₵${total.toFixed(2)}`,
        pay_label: `Pay ₵${total.toFixed(2)}`,
        networks,
        error_message: errorMessage || ' ',
        show_error: showError,
        network_prefill: session.momoNetwork || 'mtn',
        number_prefill: session.momoNumber || '',
      },
    };
  }

  /**
   * Handle order payment submission on PAYMENT screen -> to DONE.
   * Initiates direct Paystack MoMo push prompt on the customer's phone if paymentMethod is 'momo'.
   */
  private async handlePay(
    tenantId: string,
    session: FlowSessionState,
    data?: Record<string, any>,
    flow_token?: string,
    buyerPhoneFromToken?: string | null,
  ): Promise<Record<string, any>> {
    const paymentMethod = typeof data?.payment_method === 'string' ? data.payment_method.trim() : 'momo';
    const momoNetwork = typeof data?.momo_network === 'string' ? data.momo_network.trim() : 'mtn';
    const momoNumber = typeof data?.momo_number === 'string' ? data.momo_number.trim() : '';

    session.paymentMethod = paymentMethod;
    session.momoNetwork = momoNetwork;
    session.momoNumber = momoNumber;

    if (paymentMethod === 'momo') {
      const normalizedPhone = this.paystackService.normalizeGhanaPhone(momoNumber);
      if (!normalizedPhone || normalizedPhone.length < 10) {
        return this.buildPaymentScreen(
          session,
          '⚠️ Please enter a valid 10-digit mobile money number (e.g. 0244123456).',
          true,
        );
      }
    }

    const cartItems = session.cartItems || [];
    const subtotal = session.subtotal ?? cartItems.reduce((acc, i) => acc + (i.total || (i.unitPrice * i.qty) || 0), 0);
    const fulfillment = session.fulfillment || 'delivery';
    const deliveryFee = session.deliveryFee ?? (fulfillment === 'delivery' ? 5.0 : 0.0);
    const total = session.totalAmount ?? (subtotal + deliveryFee);
    const address = session.address || '';

    const orderNumber = session.orderRef || this.generateOrderRef();
    const buyerPhone = momoNumber || buyerPhoneFromToken || (flow_token && flow_token.includes(':') ? flow_token.split(':')[1] : 'flow-buyer');

    // Fetch tenant and user to obtain tenant email for Paystack charge
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: { user: true },
    });
    const tenantEmail = tenant?.user?.email || 'orders@marketix.app';

    // Initiate direct Mobile Money USSD push charge via Paystack
    let paystackResult: any = null;
    if (paymentMethod === 'momo') {
      paystackResult = await this.paystackService.initiateMoMoCharge({
        amount: total,
        momoNumber,
        provider: momoNetwork,
        email: tenantEmail,
        reference: orderNumber,
        metadata: {
          tenantId,
          orderNumber,
          buyerPhone,
          fulfillment,
          address,
        },
      });

      if (!paystackResult.success) {
        return this.buildPaymentScreen(
          session,
          `⚠️ Payment initiation failed: ${paystackResult.message}. Please verify your phone number and network.`,
          true,
        );
      }
    }

    const paymentNotes = paymentMethod === 'momo'
      ? `Payment: MoMo (${momoNetwork} - ${momoNumber}) [Paystack Prompt Sent]`
      : paymentMethod === 'card'
        ? 'Payment: Card Link on WhatsApp'
        : 'Payment: Pay on delivery / pickup';

    const notes = [
      fulfillment === 'delivery' && address ? `Fulfillment: Delivery. Address: ${address}` : 'Fulfillment: Pickup',
      paymentNotes,
      `Subtotal: ₵${subtotal.toFixed(2)}`,
      `Delivery Fee: ₵${deliveryFee.toFixed(2)}`,
      `Total: ₵${total.toFixed(2)}`,
    ].filter(Boolean).join(' | ');

    try {
      await this.prisma.order.create({
        data: {
          tenantId,
          buyerPhone,
          notes,
          orderNumber,
          status: paymentMethod === 'momo' ? OrderStatus.AWAITING_PAYMENT : OrderStatus.PENDING,
          totalAmount: total,
          items: {
            create: cartItems.map((i) => ({
              productId: i.id,
              productName: i.title,
              unitPrice: i.unitPrice,
              quantity: i.qty,
              totalPrice: i.total,
            })),
          },
        },
      });
    } catch (err) {
      this.logger.warn(`Could not persist order ${orderNumber}: ${err}`);
    }

    // Clear session selections after placing order
    session.selectedIds.clear();
    session.cartItems = [];

    const doneMsg = paymentMethod === 'momo'
      ? `Order placed! A payment prompt has been sent to your phone (${momoNumber}). Please approve it with your MoMo PIN to complete the order.`
      : paymentMethod === 'card'
        ? "Order placed. We will send you a secure payment link on WhatsApp shortly."
        : "Order placed. You can pay on delivery or upon pickup. We'll message you on WhatsApp with updates.";

    return {
      version: '3.0',
      screen: 'DONE',
      data: {
        order_ref: orderNumber,
        done_message: doneMsg,
      },
    };
  }

  /**
   * Helper to generate a friendly order reference like "MX-1042".
   */
  private generateOrderRef(): string {
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    return `MX-${randomNum}`;
  }

  /**
   * Build initial Flow payload when dispatching flow messages to WhatsApp.
   */
  async buildFlowInitData(tenantId: string, screen = 'PRODUCT_SELECT'): Promise<Record<string, any>> {
    const where = { tenantId, inStock: true };
    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: this.productsPerPage,
      }),
      this.prisma.product.count({ where }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / this.productsPerPage));
    const pages = Array.from({ length: totalPages }, (_, index) => ({
      id: String(index + 1),
      title: `Page ${index + 1} of ${totalPages}`,
    }));

    return {
      categories: this.flowCategories,
      category_prefill: 'all',
      pages,
      page_prefill: '1',
      products: products.map((p) => ({
        id: p.id,
        title: this.formatProductTitle(p.name, p.image),
        description: `₵${p.price.toFixed(2)}`,
      })),
      pre_selected: [],
      page_label: `${total} products`,
      selection_note: '🛒 Your basket is empty — tap items to add',
      search_prefill: ' ',
      notice: ' ',
      show_notice: false,
    };
  }

  /**
   * Format product title with an emoji icon from product.image or inferred from product name.
   */
  public formatProductTitle(name: string, image?: string | null): string {
    const trimmed = name?.trim() || '';
    if (!trimmed) return trimmed;

    let title: string;

    const startsWithEmoji = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation})/u.test(trimmed);
    if (startsWithEmoji) {
      title = trimmed;
    } else if (image && image.trim() && image.trim().length <= 4) {
      title = `${image.trim()} ${trimmed}`;
    } else {
      const lower = trimmed.toLowerCase();
      let icon = '🛒';

      if (lower.includes('tomato')) icon = '🍅';
      else if (lower.includes('onion')) icon = '🧅';
      else if (lower.includes('pepper') || lower.includes('chili') || lower.includes('chilli') || lower.includes('shito')) icon = '🌶️';
      else if (lower.includes('carrot')) icon = '🥕';
      else if (lower.includes('cabbage') || lower.includes('lettuce') || lower.includes('spinach') || lower.includes('kontomire') || lower.includes('green') || lower.includes('veg')) icon = '🥬';
      else if (lower.includes('okra') || lower.includes('okro')) icon = '🌱';
      else if (lower.includes('watermelon') || lower.includes('melon')) icon = '🍉';
      else if (lower.includes('banana') || lower.includes('plantain')) icon = '🍌';
      else if (lower.includes('apple')) icon = '🍎';
      else if (lower.includes('orange') || lower.includes('citrus')) icon = '🍊';
      else if (lower.includes('mango')) icon = '🥭';
      else if (lower.includes('pineapple')) icon = '🍍';
      else if (lower.includes('avocado') || lower.includes('pear')) icon = '🥑';
      else if (lower.includes('potato') || lower.includes('yam') || lower.includes('cassava')) icon = '🥔';
      else if (lower.includes('egg')) icon = '🥚';
      else if (lower.includes('bread')) icon = '🍞';
      else if (lower.includes('meat') || lower.includes('beef') || lower.includes('pork') || lower.includes('goat') || lower.includes('steak')) icon = '🥩';
      else if (lower.includes('chicken') || lower.includes('poultry')) icon = '🍗';
      else if (lower.includes('fish') || lower.includes('tilapia') || lower.includes('salmon')) icon = '🐟';
      else if (lower.includes('rice')) icon = '🍚';
      else if (lower.includes('milk') || lower.includes('dairy') || lower.includes('yogurt')) icon = '🥛';
      else if (lower.includes('oil')) icon = '🌻';
      else if (lower.includes('garlic') || lower.includes('ginger')) icon = '🧄';
      else if (lower.includes('corn') || lower.includes('maize')) icon = '🌽';
      else if (lower.includes('cucumber')) icon = '🥒';
      else if (lower.includes('lemon') || lower.includes('lime')) icon = '🍋';
      else if (lower.includes('grape')) icon = '🍇';
      else if (lower.includes('strawberry') || lower.includes('berry')) icon = '🍓';
      else if (lower.includes('bean') || lower.includes('pea')) icon = '🫘';
      else if (lower.includes('water')) icon = '💧';
      else if (lower.includes('drink') || lower.includes('juice') || lower.includes('soda')) icon = '🧃';
      else if (lower.includes('soap') || lower.includes('detergent')) icon = '🧼';

      title = `${icon} ${trimmed}`;
    }

    if (title.length > 30) {
      let sliced = title.slice(0, 27);
      const lastCharCode = sliced.charCodeAt(sliced.length - 1);
      if (lastCharCode >= 0xd800 && lastCharCode <= 0xdbff) {
        sliced = sliced.slice(0, -1);
      }
      return `${sliced}...`;
    }

    return title;
  }
}
