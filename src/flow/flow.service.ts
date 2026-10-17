import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { FlowCryptoService, DecryptedFlowPayload, EncryptedFlowRequest } from './flow-crypto.service.js';

@Injectable()
export class FlowService {
  private readonly productsPerPage = 5;

  /** Categories served by this flow. Keep in sync with the Flow JSON. */
  private readonly flowCategories: { id: string; title: string }[] = [
    { id: 'all', title: '🛒 All Products' },
    { id: 'vegetables', title: '🥦 Vegetables' },
    { id: 'grains', title: '🌾 Grains & Staples' },
    { id: 'spices', title: '🌶️ Spices' },
    { id: 'snacks', title: '🥜 Snacks' },
  ];

  /** Map category id → product name keywords for DB filtering. */
  private readonly categoryKeywords: Record<string, string[]> = {
    vegetables: ['tomato', 'onion', 'pepper', 'carrot', 'cabbage', 'lettuce', 'spinach', 'okra', 'okro', 'green', 'veg', 'cucumber', 'kontomire'],
    grains: ['rice', 'maize', 'corn', 'wheat', 'oat', 'millet', 'sorghum', 'bread', 'cassava', 'yam', 'potato', 'bean', 'pea'],
    spices: ['pepper', 'chili', 'chilli', 'shito', 'garlic', 'ginger', 'spice', 'seasoning', 'curry', 'turmeric'],
    snacks: ['peanut', 'groundnut', 'chin chin', 'biscuit', 'chips', 'snack', 'nut', 'cracker', 'wafer'],
  };
  private readonly logger = new Logger(FlowService.name);
  private readonly flowSessions = new Map<
    string,
    {
      selectedIds: Set<string>;
      lastVisibleIds: string[];
      cartItems?: Array<{ id: string; title: string; qty: number; unitPrice: number; total: number }>;
      fulfillment?: string;
      address?: string;
      updatedAt: number;
    }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly flowCrypto: FlowCryptoService,
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
   * Core logic for dynamic screen navigation for the Marketix Groceries / Catalog Flow JSON.
   */
  private async handleFlowAction(payload: DecryptedFlowPayload): Promise<Record<string, any>> {
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

    // Attempt to extract tenantId from flow_token (format: "tenantId:timestamp" or fallback to active tenant)
    let tenantId: string | null = null;
    if (flow_token && flow_token.includes(':')) {
      tenantId = flow_token.split(':')[0];
    }

    let tenant = tenantId
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

    const query = typeof data?.query === 'string' ? data.query.trim() : '';
    const category = typeof data?.category === 'string' ? data.category.trim() : 'all';

    const buildWhere = (q: string, cat: string) => {
      const keywords = cat !== 'all' ? (this.categoryKeywords[cat] ?? []) : [];
      const nameConditions: Record<string, any>[] = [];

      if (q) {
        nameConditions.push({ name: { contains: q, mode: 'insensitive' as const } });
      }
      if (keywords.length > 0) {
        nameConditions.push(...keywords.map((kw) => ({ name: { contains: kw, mode: 'insensitive' as const } })));
      }

      return {
        tenantId: tenant?.id ?? '',
        inStock: true,
        ...(nameConditions.length > 0 ? { OR: nameConditions } : {}),
      };
    };

    const where = buildWhere(query, category);

    const getPage = async (requestedPage: number, overrideWhere?: Record<string, any>) => {
      const effectiveWhere = overrideWhere ?? where;
      const total = tenant ? await this.prisma.product.count({ where: effectiveWhere }) : 0;
      const totalPages = Math.max(1, Math.ceil(total / this.productsPerPage));
      const page = Math.min(Math.max(requestedPage, 1), totalPages);
      const products = tenant
        ? await this.prisma.product.findMany({
            where: effectiveWhere,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * this.productsPerPage,
            take: this.productsPerPage,
          })
        : [];

      return {
        products: products.map((product) => ({
          id: product.id,
          title: this.formatProductTitle(product.name, product.image),
          description: `₵${product.price.toFixed(2)}`,
          price: product.price,
        })),
        total,
        totalPages,
        page,
      };
    };

    const buildProductSelectResponse = (
      products: Array<{ id: string; title: string; description: string }>,
      total: number,
      totalPages: number,
      page: number,
      selectedIds: string[] = [],
      notice = ' ',
      showNotice = false,
      activeCategory = 'all',
      activeQuery = query,
    ) => {
      const pageSelected = products
        .map(({ id }) => id)
        .filter((id) => selectedIds.includes(id));

      const pages = Array.from({ length: totalPages }, (_, index) => ({
        id: String(index + 1),
        title: `Page ${index + 1} of ${totalPages}`,
      }));

      return {
        version: '3.0',
        screen: 'PRODUCT_SELECT',
        data: {
          categories: this.flowCategories,
          category_prefill: activeCategory,
          pages,
          page_prefill: String(page),
          products,
          pre_selected: pageSelected,
          page_label: `${total} products`,
          selection_note: selectedIds.length
            ? `🛒 ${selectedIds.length} item(s) selected`
            : '🛒 Your basket is empty — tap items to add',
          search_prefill: activeQuery || ' ',
          notice,
          show_notice: showNotice,
        },
      };
    };

    // 1. INIT Action: Opening Flow on screen "MENU" or "PRODUCT_SELECT"
    if (action === 'INIT') {
      this.flowSessions.set(sessionKey, {
        selectedIds: new Set<string>(),
        lastVisibleIds: [],
        updatedAt: Date.now(),
      });

      if (screen === 'PRODUCT_SELECT') {
        const catalog = await getPage(1);
        const session = this.flowSessions.get(sessionKey);
        if (session) {
          session.lastVisibleIds = catalog.products.map(({ id }) => id);
        }
        return buildProductSelectResponse(
          catalog.products,
          catalog.total,
          catalog.totalPages,
          catalog.page,
          [],
          ' ',
          false,
          category,
          query,
        );
      }

      return {
        version: '3.0',
        screen: 'MENU',
        data: {
          store_name: tenant?.name || 'Our Store',
          welcome_title: `Welcome to ${tenant?.name || 'Our Store'}`,
          welcome_body: 'Hi 👋 What would you like to do today?',
          menu_options: [
            { id: 'SHOP', title: '🛍️ Shop products' },
            { id: 'TRACK', title: '📦 Track my order' },
            { id: 'HUMAN', title: '💬 Talk to us' },
          ],
        },
      };
    }

    // 2. DATA_EXCHANGE Action: Handling user interactions and screen transitions
    if (action === 'data_exchange') {
      let session = this.flowSessions.get(sessionKey);
      if (!session) {
        session = {
          selectedIds: new Set<string>(),
          lastVisibleIds: [],
          updatedAt: Date.now(),
        };
        this.flowSessions.set(sessionKey, session);
      }

      // Merge incoming selected items from this screen
      const rawSelected =
        data?.selected_products ??
        data?.selected_on_page ??
        data?.products_selected;

      const currentOnPageIds = Array.isArray(rawSelected)
        ? rawSelected.filter((id): id is string => typeof id === 'string')
        : [];

      const visibleIds: string[] =
        Array.isArray(data?.visible_product_ids) && data.visible_product_ids.length > 0
          ? data.visible_product_ids.filter((id): id is string => typeof id === 'string')
          : session.lastVisibleIds;

      // Also import any selected_ids explicitly supplied in payload
      if (Array.isArray(data?.selected_ids)) {
        for (const id of data.selected_ids) {
          if (typeof id === 'string') session.selectedIds.add(id);
        }
      }

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

      session.updatedAt = Date.now();

      const step = data?.step;
      const menuSelection = data?.menu_selection || data?.menu_option;

      // Handle Menu Selection navigation
      if (menuSelection === 'SHOP' || step === 'menu_shop') {
        const catalog = await getPage(1);
        session.lastVisibleIds = catalog.products.map(({ id }) => id);
        return buildProductSelectResponse(
          catalog.products,
          catalog.total,
          catalog.totalPages,
          catalog.page,
          Array.from(session.selectedIds),
          ' ',
          false,
          category,
          query,
        );
      }

      if (menuSelection === 'TRACK' || step === 'menu_track') {
        return {
          version: '3.0',
          screen: 'TRACK_ORDER',
          data: {
            title: '📦 Track My Order',
            instructions: 'Please enter your order number below to check its status:',
            order_number_prefill: '',
          },
        };
      }

      if (menuSelection === 'HUMAN' || step === 'menu_human') {
        return {
          version: '3.0',
          screen: 'SUPPORT_MESSAGE',
          data: {
            title: '💬 Customer Support',
            instructions: 'Type your question or message below and a representative will get back to you shortly:',
            message_prefill: '',
          },
        };
      }

      // Handle category change (set_category step from Dropdown on-select-action).
      if (step === 'set_category') {
        const newCategory = typeof data?.category === 'string' ? data.category.trim() : 'all';
        const newQuery = typeof data?.query === 'string' ? data.query.trim() : '';
        const newWhere = buildWhere(newQuery, newCategory);
        const catalog = await getPage(1, newWhere);
        session.lastVisibleIds = catalog.products.map(({ id }) => id);
        const selectedIds = Array.from(session.selectedIds);

        return buildProductSelectResponse(
          catalog.products.map(({ id, title, description }) => ({ id, title, description })),
          catalog.total,
          catalog.totalPages,
          catalog.page,
          selectedIds,
          ' ',
          false,
          newCategory,
          newQuery,
        );
      }

      // Handle searching and page navigation within PRODUCT_SELECT.
      if (
        step === 'search' ||
        step === 'go_page' ||
        step === 'goto_page' ||
        step === 'next_page' ||
        step === 'previous_page'
      ) {
        const navCategory = typeof data?.category === 'string' ? data.category.trim() : category;
        const navQuery = typeof data?.query === 'string' ? data.query.trim() : query;
        const navWhere = buildWhere(navQuery, navCategory);
        const currentPage = Number.parseInt(
          String(data?.page ?? data?.page_select ?? data?.page_prefill ?? '1'),
          10,
        );
        const requestedPage =
          step === 'next_page'
            ? currentPage + 1
            : step === 'previous_page'
              ? currentPage - 1
              : step === 'search'
                ? 1
                : currentPage;
        const catalog = await getPage(Number.isFinite(requestedPage) ? requestedPage : 1, navWhere);
        session.lastVisibleIds = catalog.products.map(({ id }) => id);
        const selectedIds = Array.from(session.selectedIds);

        return buildProductSelectResponse(
          catalog.products.map(({ id, title, description }) => ({
            id,
            title,
            description,
          })),
          catalog.total,
          catalog.totalPages,
          catalog.page,
          selectedIds,
          ' ',
          false,
          navCategory,
          navQuery,
        );
      }

      // Transition: PRODUCT_SELECT -> QUANTITIES (step: "continue")
      if (step === 'continue') {
        const contCategory = typeof data?.category === 'string' ? data.category.trim() : category;
        const contQuery = typeof data?.query === 'string' ? data.query.trim() : query;
        const contWhere = buildWhere(contQuery, contCategory);
        const requestedPage = Number.parseInt(
          String(data?.page ?? data?.page_select ?? data?.page_prefill ?? '1'),
          10,
        );
        const catalog = await getPage(
          Number.isFinite(requestedPage) ? requestedPage : 1,
          contWhere,
        );
        const selectedIds = Array.from(session.selectedIds);

        if (selectedIds.length === 0) {
          return buildProductSelectResponse(
            catalog.products.map(({ id, title, description }) => ({
              id,
              title,
              description,
            })),
            catalog.total,
            catalog.totalPages,
            catalog.page,
            selectedIds,
            '⚠️ Please select at least one item before continuing.',
            true,
            contCategory,
            contQuery,
          );
        }

        // Resolve selected products against this tenant's available inventory.
        const selectedProducts = tenant
          ? await this.prisma.product.findMany({
              where: {
                tenantId: tenant.id,
                inStock: true,
                id: { in: selectedIds },
              },
              orderBy: { createdAt: 'desc' },
            })
          : [];

        // Prepare fields declared in the QUANTITIES screen data schema.
        const quantitiesData: Record<string, any> = {};
        const defaultQtyOptions = [
          { id: '1', title: '1' },
          { id: '2', title: '2' },
          { id: '3', title: '3' },
          { id: '4', title: '4' },
          { id: '5', title: '5' },
          { id: '6', title: '6' },
          { id: '7', title: '7' },
          { id: '8', title: '8' },
          { id: '9', title: '9' },
          { id: '10', title: '10' },
        ];

        for (let i = 0; i < 10; i++) {
          const product = selectedProducts[i];
          const item = product
            ? {
                id: product.id,
                title: this.formatProductTitle(product.name, product.image),
                price: product.price,
              }
            : undefined;
          if (item) {
            const itemIdKey = `item_${i}_id`;
            const itemLabelKey = `item_${i}_label`;
            const itemHelperKey = `item_${i}_helper`;
            const itemOptionsKey = `item_${i}_options`;
            const itemDefaultKey = `item_${i}_default`;
            const showKey = `show_${i}`;

            const rawTitle = item.title.trim();
            let label: string;
            if (rawTitle.length <= 20) {
              label = rawTitle;
            } else {
              let sliced = rawTitle.slice(0, 17);
              const lastCharCode = sliced.charCodeAt(sliced.length - 1);
              if (lastCharCode >= 0xd800 && lastCharCode <= 0xdbff) {
                sliced = sliced.slice(0, -1);
              }
              label = `${sliced}...`;
            }

            const formattedPrice = `₵${item.price.toFixed(2)}`;

            quantitiesData[itemIdKey] = item.id;
            quantitiesData[itemLabelKey] = label;
            quantitiesData[itemHelperKey] = `${formattedPrice} each`;
            quantitiesData[itemOptionsKey] = defaultQtyOptions;
            quantitiesData[itemDefaultKey] = '1';
            quantitiesData[showKey] = true;
          } else {
            quantitiesData[`item_${i}_id`] = ' ';
            quantitiesData[`item_${i}_label`] = ' ';
            quantitiesData[`item_${i}_helper`] = ' ';
            quantitiesData[`item_${i}_options`] = [{ id: '1', title: '1' }];
            quantitiesData[`item_${i}_default`] = '1';
            quantitiesData[`show_${i}`] = false;
          }
        }

        return {
          version: '3.0',
          screen: 'QUANTITIES',
          data: quantitiesData,
        };
      }

      // Transition: QUANTITIES -> SUMMARY (step: "quantities")
      if (step === 'quantities') {
        const itemIds = Array.from({ length: 10 }, (_, index) =>
          String(data?.[`i${index}_id`] ?? data?.[`item_${index}_id`] ?? '').trim(),
        ).filter((id) => id && id !== ' ');

        const selectedProducts = tenant
          ? await this.prisma.product.findMany({
              where: {
                tenantId: tenant.id,
                inStock: true,
                id: { in: itemIds },
              },
            })
          : [];
        const catalogProducts = selectedProducts.map((product) => ({
          id: product.id,
          title: this.formatProductTitle(product.name, product.image),
          description: `₵${product.price.toFixed(2)}`,
          price: product.price,
        }));
        const cartItems: Array<{ id: string; title: string; qty: number; unitPrice: number; total: number }> = [];
        let grandTotal = 0;
        const summaryLinesArr: string[] = [];

        for (let i = 0; i < 10; i++) {
          const itemId = (data?.[`i${i}_id`] ?? data?.[`item_${i}_id`] ?? '').toString().trim();
          if (!itemId || itemId === ' ') continue;

          const product = catalogProducts.find((p) => p.id === itemId);
          if (!product) continue;

          const rawQty = data?.[`i${i}_qty`] ?? data?.[`item_${i}_qty`];
          const qty = rawQty && !isNaN(parseInt(String(rawQty), 10)) ? Math.max(1, parseInt(String(rawQty), 10)) : 1;
          const itemTotal = product.price * qty;

          grandTotal += itemTotal;

          cartItems.push({
            id: product.id,
            title: product.title,
            qty,
            unitPrice: product.price,
            total: itemTotal,
          });

          summaryLinesArr.push(`${product.title}: ${qty} × ₵${product.price.toFixed(2)} = ₵${itemTotal.toFixed(2)}`);
        }

        const summaryLines = summaryLinesArr.length > 0
          ? summaryLinesArr.join('\n')
          : 'No items in order.';

        session.cartItems = cartItems;

        return {
          version: '3.0',
          screen: 'SUMMARY',
          data: {
            summary_lines: summaryLines,
            order_total: `💰 Total: ₵${grandTotal.toFixed(2)}`,
            cart_json: JSON.stringify(cartItems),
            fulfillment_prefill: 'delivery',
            pickup_note: 'Pick up at Marketix Store, Osu. Ready in about 30 minutes.',
            error_message: ' ',
            show_error: false,
          },
        };
      }

      // Transition: SUMMARY -> PAYMENT (step: "to_payment")
      if (step === 'to_payment') {
        let cartItems: Array<{ id: string; title?: string; qty: number; unitPrice?: number }> = [];
        try {
          const rawCart = data?.cart;
          cartItems = typeof rawCart === 'string' ? JSON.parse(rawCart) : (Array.isArray(rawCart) ? rawCart : []);
        } catch {
          cartItems = session.cartItems || [];
        }

        const fulfillment = typeof data?.fulfillment === 'string' ? data.fulfillment.trim() : 'delivery';
        const address = typeof data?.address === 'string' ? data.address.trim() : '';

        if (fulfillment === 'delivery' && !address) {
          return {
            version: '3.0',
            screen: 'SUMMARY',
            data: {
              summary_lines: session.cartItems
                ? session.cartItems.map((i) => `${i.title}: ${i.qty} × ₵${i.unitPrice.toFixed(2)} = ₵${i.total.toFixed(2)}`).join('\n')
                : ' ',
              order_total: session.cartItems
                ? `💰 Total: ₵${session.cartItems.reduce((s, i) => s + i.total, 0).toFixed(2)}`
                : ' ',
              cart_json: data?.cart ?? '[]',
              fulfillment_prefill: 'delivery',
              pickup_note: 'Pick up at Marketix Store, Osu. Ready in about 30 minutes.',
              error_message: '⚠️ Please enter a delivery address before continuing.',
              show_error: true,
            },
          };
        }

        if (cartItems.length === 0) {
          return {
            version: '3.0',
            screen: 'SUMMARY',
            data: {
              summary_lines: ' ',
              order_total: ' ',
              cart_json: '[]',
              fulfillment_prefill: fulfillment || 'delivery',
              pickup_note: 'Pick up at Marketix Store, Osu. Ready in about 30 minutes.',
              error_message: '⚠️ Your cart is empty. Please go back and select items.',
              show_error: true,
            },
          };
        }

        const itemIds = cartItems.map((c) => c.id).filter(Boolean);
        const dbProducts = (tenant
          ? await this.prisma.product.findMany({
              where: { tenantId: tenant.id, inStock: true, id: { in: itemIds } },
            })
          : []) || [];

        let grandTotal = 0;
        for (const item of cartItems) {
          const dbP = dbProducts.find((p) => p.id === item.id);
          const price = dbP ? dbP.price : (item.unitPrice || 0);
          grandTotal += price * Math.max(1, Number(item.qty) || 1);
        }

        session.fulfillment = fulfillment;
        session.address = address;
        session.cartItems = cartItems.map((c) => {
          const dbP = dbProducts.find((p) => p.id === c.id);
          const unitPrice = dbP ? dbP.price : (c.unitPrice || 0);
          const qty = Math.max(1, Number(c.qty) || 1);
          return {
            id: c.id,
            title: dbP ? this.formatProductTitle(dbP.name, dbP.image) : (c.title || c.id),
            qty,
            unitPrice,
            total: unitPrice * qty,
          };
        });

        let numberPrefill = '';
        if (flow_token && flow_token.includes(':') && flow_token.split(':').length > 1) {
          const secondPart = flow_token.split(':')[1];
          if (/^\+?\d{8,15}$/.test(secondPart)) {
            numberPrefill = secondPart;
          }
        }

        return {
          version: '3.0',
          screen: 'PAYMENT',
          data: {
            order_total: `Total: ₵${grandTotal.toFixed(2)}`,
            pay_label: `Pay ₵${grandTotal.toFixed(2)}`,
            networks: [
              { id: 'mtn', title: 'MTN MoMo' },
              { id: 'telecel', title: 'Telecel Cash' },
              { id: 'airteltigo', title: 'AirtelTigo Money' },
            ],
            network_prefill: 'mtn',
            number_prefill: numberPrefill || ' ',
            error_message: ' ',
            show_error: false,
          },
        };
      }

      // Transition: PAYMENT -> DONE (step: "pay" or "confirm")
      if (step === 'pay' || step === 'confirm') {
        const paymentMethod = typeof data?.payment_method === 'string' ? data.payment_method.trim() : 'momo';
        const momoNetwork = typeof data?.momo_network === 'string' ? data.momo_network.trim() : 'mtn';
        const momoNumber = typeof data?.momo_number === 'string' ? data.momo_number.trim() : '';

        const fulfillment = typeof data?.fulfillment === 'string' ? data.fulfillment.trim() : (session.fulfillment || 'delivery');
        const address = typeof data?.address === 'string' ? data.address.trim() : (session.address || '');

        if (fulfillment === 'delivery' && !address) {
          return {
            version: '3.0',
            screen: 'SUMMARY',
            data: {
              summary_lines: ' ',
              order_total: ' ',
              cart_json: data?.cart ?? '[]',
              fulfillment_prefill: 'delivery',
              pickup_note: 'Pick up at Marketix Store, Osu. Ready in about 30 minutes.',
              error_message: '⚠️ Please enter a delivery address before confirming.',
              show_error: true,
            },
          };
        }

        if (step === 'pay' && paymentMethod === 'momo' && !momoNumber) {
          const currentTotal = session.cartItems
            ? session.cartItems.reduce((sum, item) => sum + item.total, 0)
            : 0;
          return {
            version: '3.0',
            screen: 'PAYMENT',
            data: {
              order_total: `Total: ₵${currentTotal.toFixed(2)}`,
              pay_label: `Pay ₵${currentTotal.toFixed(2)}`,
              networks: [
                { id: 'mtn', title: 'MTN MoMo' },
                { id: 'telecel', title: 'Telecel Cash' },
                { id: 'airteltigo', title: 'AirtelTigo Money' },
              ],
              network_prefill: momoNetwork || 'mtn',
              number_prefill: ' ',
              error_message: '⚠️ Please enter your mobile money number before paying.',
              show_error: true,
            },
          };
        }

        let cartItems: Array<{ id: string; qty: number }> = [];
        if (data?.cart) {
          try {
            const rawCart = data.cart;
            cartItems = typeof rawCart === 'string' ? JSON.parse(rawCart) : (Array.isArray(rawCart) ? rawCart : []);
          } catch {
            cartItems = [];
          }
        }
        if (cartItems.length === 0 && session.cartItems) {
          cartItems = session.cartItems.map((item) => ({ id: item.id, qty: item.qty }));
        }

        const itemIds = cartItems.map((c) => c.id).filter(Boolean);
        const dbProducts = (tenant
          ? await this.prisma.product.findMany({
              where: { tenantId: tenant.id, inStock: true, id: { in: itemIds } },
            })
          : []) || [];

        const orderItems = cartItems
          .map((c) => {
            const product = dbProducts.find((p) => p.id === c.id);
            if (!product) return null;
            const qty = Math.max(1, Number(c.qty) || 1);
            return {
              productId: product.id,
              productName: this.formatProductTitle(product.name, product.image),
              unitPrice: product.price,
              quantity: qty,
            };
          })
          .filter((item): item is NonNullable<typeof item> => item !== null);

        if (orderItems.length === 0) {
          return {
            version: '3.0',
            screen: 'SUMMARY',
            data: {
              summary_lines: ' ',
              order_total: ' ',
              cart_json: '[]',
              fulfillment_prefill: fulfillment,
              pickup_note: 'Pick up at Marketix Store, Osu. Ready in about 30 minutes.',
              error_message: '⚠️ None of the selected products are available. Please go back.',
              show_error: true,
            },
          };
        }

        const buyerPhone = momoNumber || (flow_token && flow_token.includes(':') ? flow_token : (flow_token ?? 'flow-buyer'));

        const paymentNotes = paymentMethod === 'momo'
          ? `Payment: MoMo (${momoNetwork} - ${momoNumber})`
          : paymentMethod === 'card'
            ? 'Payment: Card Link on WhatsApp'
            : 'Payment: Pay on delivery / pickup';

        const notes = [
          fulfillment === 'delivery' && address ? `Fulfillment: Delivery. Address: ${address}` : 'Fulfillment: Pickup',
          paymentNotes,
        ].filter(Boolean).join(' | ');

        const createdOrder = await this.prisma.order.create({
          data: {
            tenantId: tenant.id,
            buyerPhone,
            notes: notes ?? null,
            totalAmount: orderItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0),
            items: {
              create: orderItems.map((i) => ({
                productId: i.productId,
                productName: i.productName,
                unitPrice: i.unitPrice,
                quantity: i.quantity,
                totalPrice: i.unitPrice * i.quantity,
              })),
            },
          },
          select: { orderNumber: true },
        });

        // Clear this flow session after a successful order.
        this.flowSessions.delete(sessionKey);

        const orderRef = createdOrder.orderNumber.slice(-8).toUpperCase();

        const doneMsg = paymentMethod === 'momo'
          ? 'Order placed. Approve the payment prompt on your phone. We\'ll message you on WhatsApp with updates.'
          : paymentMethod === 'card'
            ? 'Order placed. We will send you a secure payment link on WhatsApp shortly.'
            : 'Order placed. You can pay on delivery or upon pickup. We\'ll message you on WhatsApp with updates.';

        return {
          version: '3.0',
          screen: 'DONE',
          data: {
            order_ref: `MX-${orderRef}`,
            done_message: doneMsg,
          },
        };
      }
    }

    // Default fallback
    return {
      version: '3.0',
      screen: screen || 'PRODUCT_SELECT',
      data: {
        ...data,
      },
    };
  }

  /**
   * Build the initial Flow screen payload (PRODUCT_SELECT, page 1) for a given tenant.
   * Used by ChatService and FlowController to avoid duplicating catalog-payload logic.
   */
  async buildFlowInitData(tenantId: string): Promise<{
    categories: { id: string; title: string }[];
    category_prefill: string;
    pages: { id: string; title: string }[];
    page_prefill: string;
    products: { id: string; title: string; description: string }[];
    pre_selected: string[];
    page_label: string;
    selection_note: string;
    search_prefill: string;
    notice: string;
    show_notice: boolean;
  }> {
    const where = { tenantId, inStock: true };
    const [products, totalProducts] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: this.productsPerPage,
      }),
      this.prisma.product.count({ where }),
    ]);
    const totalPages = Math.max(1, Math.ceil(totalProducts / this.productsPerPage));
    const pagesList = Array.from({ length: totalPages }, (_, i) => ({
      id: String(i + 1),
      title: `Page ${i + 1} of ${totalPages}`,
    }));

    return {
      categories: this.flowCategories,
      category_prefill: 'all',
      pages: pagesList,
      page_prefill: '1',
      products: products.map((p) => ({
        id: p.id,
        title: this.formatProductTitle(p.name, p.image),
        description: `₵${p.price.toFixed(2)}`,
      })),
      pre_selected: [],
      page_label: `${totalProducts} products`,
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

    // If name already starts with an emoji icon, preserve it
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
      else if (lower.includes('oil')) icon = '🫒';
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
