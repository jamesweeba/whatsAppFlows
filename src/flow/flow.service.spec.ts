import { OrderStatus, PaymentMethod, Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CategoryService } from '../category/category.service.js';
import { ADD_MORE_ICON, BASKET_EMPTY_ICON, BASKET_ICON, CHECKOUT_ICON } from './basket-icons.js';
import { PLACEHOLDER_PHOTO } from './placeholder-image.js';
import { FlowService } from './flow.service.js';

const TOKEN = 'tenant-1:+233240000000:1';

/** Minimal in-memory stand-in for the Prisma calls FlowService makes. */
function fakePrisma(state: { products: any[]; categories: any[]; carts: any[]; lastOrder: any }) {
  const contains = (value: string | null | undefined, filter: any) =>
    !!value && value.toLowerCase().includes(String(filter.contains).toLowerCase());
  // Only the shapes FlowService builds: { name|note: { contains } } and { category: { title: { contains } } }.
  const matchesClause = (p: any, clause: any): boolean =>
    (clause.name && contains(p.name, clause.name)) ||
    (clause.note && contains(p.note, clause.note)) ||
    (clause.category && contains(state.categories.find((c) => c.id === p.categoryId)?.title, clause.category.title));

  const matches = (p: any, where: any = {}) =>
    (where.AND === undefined || where.AND.every((part: any) => part.OR.some((clause: any) => matchesClause(p, clause)))) &&
    (where.tenantId === undefined || p.tenantId === where.tenantId) &&
    (where.inStock === undefined || p.inStock === where.inStock) &&
    (where.id === undefined || (typeof where.id === 'string' ? p.id === where.id : where.id.in.includes(p.id))) &&
    (where.categoryId === undefined || p.categoryId === where.categoryId);

  return {
    tenant: { findUnique: vi.fn() },
    flowCart: {
      upsert: vi.fn(async ({ where, create }: any) => {
        let cart = state.carts.find((c) => c.flowToken === where.flowToken);
        if (!cart) {
          cart = { id: `cart-${state.carts.length + 1}`, lines: [], editing: null, updatedAt: new Date(), ...create };
          state.carts.push(cart);
        }
        return cart;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const cart = state.carts.find((c) => c.id === where.id);
        if (data.lines !== undefined) cart.lines = structuredClone(data.lines);
        if (data.editing !== undefined) cart.editing = data.editing === Prisma.DbNull ? null : structuredClone(data.editing);
        cart.updatedAt = new Date();
        return cart;
      }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    product: {
      findMany: vi.fn(async ({ where, skip = 0, take }: any) => {
        const found = state.products.filter((p) => matches(p, where)).sort((a, b) => a.name.localeCompare(b.name));
        return found.slice(skip, take ? skip + take : undefined).map(withVideos);
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const found = state.products.find((p) => matches(p, where));
        return found ? withVideos(found) : null;
      }),
      count: vi.fn(async ({ where }: any) => state.products.filter((p) => matches(p, where)).length),
    },
    category: {
      findMany: vi.fn(async ({ where }: any) =>
        state.categories.filter((c) => state.products.some((p) => p.categoryId === c.id && p.inStock && p.tenantId === where.products.some.tenantId)),
      ),
      findUnique: vi.fn(async ({ where }: any) => state.categories.find((c) => c.id === where.id) ?? null),
    },
    order: { findFirst: vi.fn(async () => state.lastOrder) },
  };
}

/** Products as Prisma returns them with `videos` included: the live videos' measure codes ('' = whole product). */
const withVideos = (p: any) => ({ ...p, videos: p.videos ?? [] });

const measure = (code: string, label: string, price: number, sortOrder = 0) => ({ code, label, price, sortOrder, description: null });

describe('FlowService (WELCOME -> CATALOGUE -> PRODUCT -> BASKET -> CHECKOUT -> ORDER_RECEIVED)', () => {
  let service: FlowService;
  let state: { products: any[]; categories: any[]; carts: any[]; lastOrder: any };
  let prisma: ReturnType<typeof fakePrisma>;
  let paystack: any;
  let orderService: any;
  let waba: any;
  let productPhotos: any;
  let productVideos: any;
  let banners: any;

  const tenant = {
    id: 'tenant-1',
    name: 'MarketiX Tech',
    status: 'ACTIVE',
    whatsappPhoneNumberId: 'phone-1',
    deliveryFee: 10,
    deliveryAreas: [{ id: 'knust', title: 'KNUST Campus' }, { id: 'ayigya', title: 'Ayigya' }],
    deliverySlots: [{ id: 'today_pm', title: 'Today, 5 pm – 7 pm' }],
  };

  const tomatoes = () => state.products.find((p) => p.id === 'sku_tomatoes');

  const act = (action: string, data: Record<string, any> = {}) =>
    service.handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      flow_token: TOKEN,
      data: { step: action, sku: 'none', measure: 'none', category: 'veg_fruits', page: '1', ...data },
    });

  beforeEach(() => {
    state = {
      categories: [
        { id: 'veg_fruits', title: 'Vegetables & fruits', description: 'Tomatoes, onions, pepper' },
        { id: 'drinks', title: 'Drinks & water', description: 'Water, juice, soft drinks' },
      ],
      products: [
        {
          id: 'sku_tomatoes', tenantId: 'tenant-1', name: 'Tomatoes', price: 10, inStock: true, categoryId: 'veg_fruits', note: 'Olonka ≈ 2 kg',
          measures: [measure('olonka', 'Olonka', 25, 0), measure('basket', 'Basket', 120, 1), measure('tabletop', 'Table top', 10, 2)],
        },
        { id: 'sku_onions', tenantId: 'tenant-1', name: 'Onions', price: 5, inStock: true, categoryId: 'veg_fruits', note: null, measures: [] },
        { id: 'sku_soap', tenantId: 'tenant-1', name: 'Soap', price: 8, inStock: true, categoryId: null, note: null, measures: [] },
      ],
      carts: [],
      lastOrder: null,
    };
    prisma = fakePrisma(state);
    prisma.tenant.findUnique.mockResolvedValue(tenant);

    paystack = {
      initiateMoMoCharge: vi.fn().mockResolvedValue({ success: true, status: 'pay_offline', reference: 'MX-1', message: 'ok' }),
    };

    let created: any = null;
    orderService = {
      createOrder: vi.fn().mockImplementation(async (_tenantId: string, dto: any, details: any) => {
        const subtotal = dto.items.reduce((s: number, i: any) => s + i.unitPrice * i.quantity, 0);
        created = { id: 'order-1', orderNumber: 'MX-ABC123', totalAmount: subtotal + dto.deliveryFee, ...dto, ...details };
        return created;
      }),
      findByFlowCart: vi.fn(async () => created),
      findByOrderNumber: vi.fn(),
      claimPaymentRequest: vi.fn().mockResolvedValue(true),
      claimConfirmation: vi.fn().mockResolvedValue(true),
      releasePaymentRequest: vi.fn().mockResolvedValue(undefined),
      markLocationRequested: vi.fn().mockResolvedValue(undefined),
    };

    banners = { flowThumbnailBase64: vi.fn().mockResolvedValue(null) };
    productPhotos = { flowPhotoBase64: vi.fn().mockResolvedValue(null), flowThumbnailBase64: vi.fn().mockResolvedValue(null) };
    productVideos = {
      // Like the real one: the chosen measure's live video, or else the whole product's.
      liveVideoFor: vi.fn(async (productId: string, measureCode: string | null) => {
        const videos: { measureCode: string }[] = state.products.find((p) => p.id === productId)?.videos ?? [];
        const pick = videos.find((v) => measureCode && v.measureCode === measureCode) ?? videos.find((v) => v.measureCode === '');
        return pick ? { id: `video-${productId}-${pick.measureCode}`, productId, measureCode: pick.measureCode } : null;
      }),
      sendToBuyer: vi.fn().mockResolvedValue('sent'),
    };

    waba = {
      sendFlowMessage: vi.fn().mockResolvedValue({ messageId: 'wamid-flow' }),
      sendLocationRequest: vi.fn().mockResolvedValue({ messageId: 'wamid-loc' }),
      sendTextMessage: vi.fn().mockResolvedValue({ messageId: 'wamid-text' }),
    };

    service = new FlowService(prisma as any, {} as any, paystack, orderService, waba, { orderAlert: vi.fn().mockResolvedValue(true) } as any, new CategoryService(prisma as any, {} as any), productPhotos as any, productVideos as any, banners);
  });

  it('answers the health-check ping', async () => {
    const result = await service.handleFlowAction({ version: '3.0', action: 'ping' });
    expect(result.data).toEqual({ status: 'active' });
  });

  it('acknowledges client error notifications', async () => {
    const result = await service.handleFlowAction({ version: '3.0', action: 'data_exchange', flow_token: TOKEN, data: { error: 'boom' } });
    expect(result.data).toEqual({ acknowledged: true });
  });

  it('still routes Flows uploaded before the payload key was renamed from "action" to "step"', async () => {
    const result = await service.handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      flow_token: TOKEN,
      data: { action: 'open_category', category: 'veg_fruits', page: '1' },
    });
    expect(result.screen).toBe('CATALOGUE');
  });

  describe('when WhatsApp drops the step from the payload', () => {
    const bare = (screen: string, data: Record<string, any>) =>
      service.handleFlowAction({ version: '3.0', action: 'data_exchange', screen, flow_token: TOKEN, data });

    it('treats a PRODUCT request carrying `video` as "Watch video", never as Add to basket', async () => {
      state.products.find((p) => p.id === 'sku_tomatoes').videos = [{ measureCode: '' }];
      const result = await bare('PRODUCT', { sku: 'sku_tomatoes', measure: 'basket', category: 'veg_fruits', page: '1', video: '1' });
      expect(result.screen).toBe('PRODUCT');
      expect(productVideos.sendToBuyer).toHaveBeenCalled();
      expect(state.carts[0]?.lines ?? []).toEqual([]);
    });

    it('opens the category chosen on WELCOME (the request seen in production)', async () => {
      const result = await bare('WELCOME', { category: 'veg_fruits', page: '1' });
      expect(result.screen).toBe('CATALOGUE');
    });

    it('adds a line from the PRODUCT footer and goes back from its link', async () => {
      await bare('PRODUCT', { sku: 'sku_tomatoes', measure: 'basket', qty: '2', category: 'veg_fruits', page: '1' });
      expect(state.carts[0].lines).toEqual([{ sku: 'sku_tomatoes', measure: 'basket', qty: 2 }]);

      expect((await bare('PRODUCT', { category: 'veg_fruits', page: '1' })).screen).toBe('CATALOGUE');
    });

    it('follows NavigationList rows using the step carried in sku', async () => {
      const catalogue = await act('open_category');
      const { step: _, ...basketRow } = catalogue.data.basket_bar[0]['on-click-action'].payload;
      expect((await bare('CATALOGUE', basketRow)).screen).toBe('BASKET');

      const { step: __, ...productRow } = catalogue.data.products[1]['on-click-action'].payload;
      expect((await bare('CATALOGUE', productRow)).screen).toBe('PRODUCT');
    });
  });

  it('builds every NavigationList the way WhatsApp accepts it: 1-20 rows, `end` on all rows or none', async () => {
    for (let i = 0; i < 18; i++) {
      state.products.push({ id: `p${i}`, tenantId: 'tenant-1', name: `Item ${i}`, price: 1, inStock: true, categoryId: 'veg_fruits', measures: [] });
    }
    const responses = [
      await service.handleFlowAction({ version: '3.0', action: 'INIT', flow_token: TOKEN }),
      await act('open_basket'),
      await act('add_line', { sku: 'sku_tomatoes', measure: 'basket', qty: '2' }),
      await act('open_category', { page: '2' }),
      await act('open_basket'),
      await act('search', { query: 'item' }),
      await act('search', { query: 'nothing like this' }),
    ];

    for (const response of responses) {
      for (const [key, value] of Object.entries(response.data)) {
        if (!Array.isArray(value) || !value.every((row: any) => row && 'main-content' in row)) continue;
        const where = `${response.screen}.${key}`;
        expect(value.length, where).toBeGreaterThanOrEqual(1);
        expect(value.length, where).toBeLessThanOrEqual(20);
        const withEnd = value.filter((row: any) => row.end).length;
        expect([0, value.length], where).toContain(withEnd);
      }
    }
  });

  it('refuses every step for a shop that is not ACTIVE, even from a Flow already open', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ ...tenant, status: 'SUSPENDED' });

    await expect(act('open_category')).rejects.toThrow('not taking orders');
    await expect(act('place_order', { cart_id: 'cart-1', payment: 'cash' })).rejects.toThrow('not taking orders');
    expect(orderService.createOrder).not.toHaveBeenCalled();
    expect(prisma.flowCart.upsert).not.toHaveBeenCalled();
  });

  it('rejects requests whose flow token carries no tenant', async () => {
    await expect(service.handleFlowAction({ version: '3.0', action: 'INIT' })).rejects.toThrow('tenant');
  });

  it('sends the Flow with a data_exchange INIT and the buyer phone in the token', async () => {
    process.env.META_FLOW_ID = 'flow-1';
    await service.dispatchFlow({ tenant: tenant as any, toPhone: '+233240000000', cta: 'Shop', bodyText: 'Hi' });
    expect(waba.sendFlowMessage).toHaveBeenCalledWith(
      expect.objectContaining({ flowAction: 'data_exchange', screen: 'WELCOME', flowToken: expect.stringMatching(/^tenant-1:\+233240000000:\d+$/) }),
    );
  });

  describe('WELCOME', () => {
    it('lists Search, then "All products", then only the predefined categories this shop sells in', async () => {
      state.products.push({ id: 'sku_cola', tenantId: 'another-shop', name: 'Cola', price: 5, inStock: true, categoryId: 'drinks', measures: [] });

      const result = await service.handleFlowAction({ version: '3.0', action: 'INIT', flow_token: TOKEN });
      expect(result.screen).toBe('WELCOME');
      expect(result.data.categories.map((row: any) => [row.id, row['main-content']])).toEqual([
        ['search', { title: '🔍 Search products', metadata: 'Find an item by name' }],
        ['all', { title: 'All products', metadata: 'Everything in stock · 3 products' }],
        ['veg_fruits', { title: 'Vegetables & fruits', metadata: 'Tomatoes, onions, pepper' }],
      ]);
    });

    it('adds no shop row for a shop without an approved banner', async () => {
      const result = await service.handleFlowAction({ version: '3.0', action: 'INIT', flow_token: TOKEN });
      expect(result.data.categories.map((row: any) => row.id).slice(0, 2)).toEqual(['search', 'all']);
    });

    it("puts the shop's approved banner as a logo row on top, which opens every product", async () => {
      banners.flowThumbnailBase64.mockResolvedValue('bG9nbw==');
      const result = await service.handleFlowAction({ version: '3.0', action: 'INIT', flow_token: TOKEN });
      const [shop, search, next] = result.data.categories;
      expect(shop).toMatchObject({
        id: 'shop',
        'main-content': { title: 'MarketiX Tech' },
        start: { image: 'bG9nbw==', 'alt-text': 'MarketiX Tech' },
      });
      expect(shop['on-click-action'].payload).toMatchObject({ step: 'open_category', category: 'all', page: '1' });
      expect(search.id).toBe('search');
      expect(next.id).toBe('all');
      expect(banners.flowThumbnailBase64).toHaveBeenCalledWith(expect.objectContaining({ id: 'tenant-1' }));
      expect(result.data.categories.length).toBeLessThanOrEqual(20);
    });

    it("titles WELCOME and the Shop page with the vendor's shop name", async () => {
      prisma.tenant.findUnique.mockResolvedValue({ ...tenant, name: 'Stylix' });
      const welcome = await service.handleFlowAction({ version: '3.0', action: 'INIT', flow_token: TOKEN });
      expect(welcome.data.shop_name).toBe('Stylix');
      expect((await act('open_category', { category: 'all' })).data.shop_name).toBe('Stylix');
    });

    it("shows the shop's own description under the category list, or a neutral line without one", async () => {
      prisma.tenant.findUnique.mockResolvedValue({ ...tenant, name: 'Stylix', description: '  Nice\n fragrances ' });
      expect((await service.handleFlowAction({ version: '3.0', action: 'INIT', flow_token: TOKEN })).data.shop_tagline).toBe('Nice fragrances');

      prisma.tenant.findUnique.mockResolvedValue({ ...tenant, name: 'Stylix', description: null });
      expect((await service.handleFlowAction({ version: '3.0', action: 'INIT', flow_token: TOKEN })).data.shop_tagline).toBe(
        'Order from Stylix right here on WhatsApp.',
      );

      prisma.tenant.findUnique.mockResolvedValue({ ...tenant, description: 'x'.repeat(200) });
      expect((await service.handleFlowAction({ version: '3.0', action: 'INIT', flow_token: TOKEN })).data.shop_tagline.length).toBeLessThanOrEqual(80);
    });

    it('cuts a very long shop name so the title bar stays on one line', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ ...tenant, name: 'The Very Best Fragrances And Cosmetics Shop Ltd' });
      const welcome = await service.handleFlowAction({ version: '3.0', action: 'INIT', flow_token: TOKEN });
      expect(welcome.data.shop_name.length).toBeLessThanOrEqual(30);
    });

    it('shows every in-stock product under "All products", categorised or not', async () => {
      const result = await act('open_category', { category: 'all' });
      expect(result.data.basket_bar[0]['main-content'].title).toBe('All products');
      expect(result.data.products.map((row: any) => row.id)).toEqual(['search', 'sku_onions', 'sku_soap', 'sku_tomatoes']);
    });

    it('opens a category with one tap on its row', async () => {
      const result = await service.handleFlowAction({ version: '3.0', action: 'INIT', flow_token: TOKEN });
      expect(result.data.categories[2]['on-click-action'].payload).toEqual({
        step: 'open_category', sku: 'open_category', measure: 'none', category: 'veg_fruits', page: '1',
      });
    });

    it('puts "Repeat my last order" first when the buyer has ordered before', async () => {
      state.lastOrder = {
        createdAt: new Date('2026-10-28T10:00:00Z'),
        totalAmount: 95,
        items: [{ productId: 'sku_tomatoes', measureCode: 'olonka', quantity: 2 }],
      };
      const result = await service.handleFlowAction({ version: '3.0', action: 'INIT', flow_token: TOKEN });
      expect(result.data.categories[1]).toMatchObject({
        id: 'reorder_last',
        'main-content': { title: 'Repeat my last order', metadata: 'Wed 28 Oct · 1 item · GH₵ 95' },
      });
    });
  });

  describe('CATALOGUE', () => {
    it('renders the empty basket bar and product rows with every payload key', async () => {
      const result = await act('open_category');
      expect(result.screen).toBe('CATALOGUE');
      expect(result.data.basket_bar).toEqual([
        expect.objectContaining({
          id: 'basket',
          'main-content': expect.objectContaining({ title: 'Vegetables & fruits', description: 'page 1 of 1' }),
        }),
      ]);
      expect(result.data.basket_bar[0].badge).toBeUndefined();
      expect(result.data.basket_bar[0].start).toEqual({ image: BASKET_EMPTY_ICON, 'alt-text': 'Basket' });

      const [search, onions, tomatoes] = result.data.products;
      expect(search.id).toBe('search');
      expect(tomatoes['main-content']).toEqual({ title: 'Tomatoes', description: 'from GH₵ 10', metadata: 'Olonka · Basket · Table top' });
      expect(onions['main-content'].metadata).toBe('Each');
      expect(tomatoes['on-click-action'].payload).toEqual({
        step: 'open_product', sku: 'sku_tomatoes', measure: 'none', category: 'veg_fruits', page: '1',
      });
    });

    it('pages 15 products at a time with Next and Previous rows', async () => {
      // 2 seeded veg products + 18 more = 20 products = 2 pages.
      for (let i = 0; i < 18; i++) {
        state.products.push({ id: `p${i}`, tenantId: 'tenant-1', name: `Item ${i}`, price: 1, inStock: true, categoryId: 'veg_fruits', measures: [] });
      }
      const first = await act('open_category');
      expect(first.data.products).toHaveLength(17);
      expect(first.data.products.at(-1)).toMatchObject({ id: 'next_page', 'main-content': { title: 'Next 5 products', description: 'page 2 of 2' } });

      const second = await act('open_category', { page: '2' });
      expect(second.data.page).toBe('2');
      expect(second.data.products).toHaveLength(7);
      expect(second.data.products.map((r: any) => r.id)).toContain('prev_page');
      expect(second.data.products.map((r: any) => r.id)).not.toContain('next_page');
    });

    it('adds a thumbnail only to products that have a photo', async () => {
      productPhotos.flowThumbnailBase64.mockImplementation(async (p: any) => (p.id === 'sku_tomatoes' ? 'dGh1bWI=' : null));
      const result = await act('open_category', { category: 'all' });
      const tomatoes = result.data.products.find((r: any) => r.id === 'sku_tomatoes');
      expect(tomatoes.start).toEqual({ image: 'dGh1bWI=', 'alt-text': 'Tomatoes' });
      const others = result.data.products.filter((r: any) => r.id !== 'sku_tomatoes');
      expect(others.length).toBeGreaterThan(0);
      others.forEach((r: any) => expect(r.start).toBeUndefined());
    });

    it('shows a single "No products here yet" row for an empty category', async () => {
      const result = await act('open_category', { category: 'drinks' });
      expect(result.data.products).toEqual([expect.objectContaining({ id: 'search' }), expect.objectContaining({ id: 'none' })]);
    });
  });

  describe('SEARCH', () => {
    const search = (query: string) => act('search', { query });
    const ids = (result: any) => result.data.products.map((row: any) => row.id);

    it('opens an empty search box from WELCOME and from a category', async () => {
      const welcome = await service.handleFlowAction({ version: '3.0', action: 'INIT', flow_token: TOKEN });
      const row = welcome.data.categories.find((r: any) => r.id === 'search');
      expect(row['on-click-action'].payload).toEqual({ step: 'open_search', sku: 'open_search', measure: 'none', category: 'all', page: '1' });
      expect(await act('open_search', row['on-click-action'].payload)).toMatchObject({ version: '3.0', screen: 'SEARCH', data: { init_query: '', category: 'all' } });

      const catalogue = await act('open_category');
      expect(catalogue.data.products[0]['main-content'].title).toBe('🔍 Search products');
      expect((await act('open_search', catalogue.data.products[0]['on-click-action'].payload)).data.init_query).toBe('');
    });

    it('searches the whole shop by name, note and category title, ignoring case', async () => {
      expect(ids(await search('TOMA'))).toEqual(['search', 'sku_tomatoes']);
      expect(ids(await search('2 kg'))).toEqual(['search', 'sku_tomatoes']); // note "Olonka ≈ 2 kg"
      expect(ids(await search('vegetables'))).toEqual(['search', 'sku_onions', 'sku_tomatoes']); // category title
      expect(ids(await search('soap'))).toEqual(['search', 'sku_soap']); // uncategorised product
    });

    it('needs every word to match', async () => {
      expect(ids(await search('  olonka   tomatoes '))).toEqual(['search', 'sku_tomatoes']);
      expect(ids(await search('olonka soap'))).toEqual(['search']);
    });

    it('titles the results and keeps the term on every row, so paging and Back re-run the search', async () => {
      const result = await search('onion');
      expect(result.screen).toBe('CATALOGUE');
      expect(result.data.category).toBe('search:onion');
      expect(result.data.basket_bar[0]['main-content'].title).toBe('Results for "onion"');
      expect(result.data.products[0]['main-content']).toEqual({ title: '🔍 Search again', metadata: 'Showing results for "onion"' });
      expect(result.data.products[1]['on-click-action'].payload).toMatchObject({ step: 'open_product', category: 'search:onion' });

      const back = await act('open_category', { category: 'search:onion' });
      expect(ids(back)).toEqual(['search', 'sku_onions']);
    });

    it('pre-fills the box with the last term on "Search again"', async () => {
      const result = await search('onion');
      const again = await act('open_search', result.data.products[0]['on-click-action'].payload);
      expect(again).toMatchObject({ screen: 'SEARCH', data: { init_query: 'onion' } });
    });

    it('says when nothing matches, with no extra empty row', async () => {
      const result = await search('fufu');
      expect(result.data.products).toEqual([
        expect.objectContaining({
          id: 'search',
          'main-content': { title: '🔍 Search again', metadata: 'Nothing found for "fufu" · tap to try another word' },
        }),
      ]);
    });

    it('stays on the search box when the term is shorter than 2 letters', async () => {
      expect(await search(' t ')).toMatchObject({ version: '3.0', screen: 'SEARCH', data: { init_query: 't' } });
    });

    it('only finds in-stock products of this shop', async () => {
      state.products.push(
        { id: 'sku_tomato_paste', tenantId: 'tenant-1', name: 'Tomato paste', price: 6, inStock: false, categoryId: null, measures: [] },
        { id: 'sku_tomato_other', tenantId: 'another-shop', name: 'Tomato', price: 6, inStock: true, categoryId: null, measures: [] },
      );
      expect(ids(await search('tomato'))).toEqual(['search', 'sku_tomatoes']);
    });

    it('shows what the shop sells: its categories, and every in-stock product to pick', async () => {
      state.products.push({ id: 'sku_gone', tenantId: 'tenant-1', name: 'Gone', price: 1, inStock: false, categoryId: 'drinks', measures: [] });
      const result = await act('open_search');
      expect(result.data.shop_summary).toBe('Vegetables & fruits');
      expect(result.data.products).toEqual([
        { id: 'sku_onions', title: 'Onions', description: 'from GH₵ 5' },
        { id: 'sku_soap', title: 'Soap', description: 'from GH₵ 8' },
        { id: 'sku_tomatoes', title: 'Tomatoes', description: 'from GH₵ 10' },
      ]);
    });

    it('lists product names when the shop has no categories, and a placeholder when it has nothing', async () => {
      state.products.forEach((p) => (p.categoryId = null));
      expect((await act('open_search')).data.shop_summary).toBe('Onions, Soap, Tomatoes');

      state.products.forEach((p) => (p.inStock = false));
      const empty = await act('open_search');
      expect(empty.data.shop_summary).toBe('Nothing in stock right now.');
      expect(empty.data.products).toEqual([{ id: 'none', title: 'Nothing in stock yet' }]);
    });

    it('opens a picked product, and its Back link returns to where search was opened', async () => {
      const picked = await act('open_product', { sku: 'sku_soap', category: 'veg_fruits' });
      expect(picked.screen).toBe('PRODUCT');
      expect(picked.data).toMatchObject({ sku: 'sku_soap', category: 'veg_fruits' });
    });

    it('routes a search even when WhatsApp drops the step', async () => {
      const pick = await service.handleFlowAction({
        version: '3.0', action: 'data_exchange', screen: 'SEARCH', flow_token: TOKEN,
        data: { sku: 'sku_soap', measure: 'none', category: 'all', page: '1' },
      });
      expect(pick.screen).toBe('PRODUCT');

      const result = await service.handleFlowAction({ version: '3.0', action: 'data_exchange', screen: 'SEARCH', flow_token: TOKEN, data: { query: 'soap' } });
      expect(ids(result)).toEqual(['search', 'sku_soap']);

      const welcome = await service.handleFlowAction({
        version: '3.0', action: 'data_exchange', screen: 'WELCOME', flow_token: TOKEN,
        data: { sku: 'open_search', measure: 'none', category: 'all', page: '1' },
      });
      expect(welcome.screen).toBe('SEARCH');
    });
  });

  describe('PRODUCT and add_line', () => {
    it('opens a new product with "Add to basket", the first measure and quantity 1', async () => {
      const result = await act('open_product', { sku: 'sku_tomatoes' });
      expect(result.screen).toBe('PRODUCT');
      expect(result.data).toMatchObject({
        sku: 'sku_tomatoes', name: 'Tomatoes', note: 'Olonka ≈ 2 kg', current_measure: 'olonka', current_qty: '1', button_label: 'Add to basket',
      });
      expect(result.data.measures.map((m: any) => m.title)).toEqual(['Olonka · GH₵ 25', 'Basket · GH₵ 120', 'Table top · GH₵ 10']);
      expect(result.data.qty_options).toHaveLength(10);
      expect(result.data.photo).toBe(PLACEHOLDER_PHOTO);
    });

    it('offers "Watch video" only for products with an approved video, and marks them in the catalogue', async () => {
      expect((await act('open_product', { sku: 'sku_tomatoes' })).data).toMatchObject({ has_video: false, has_video_note: false, video_link_label: '🎥 Watch video' });

      tomatoes().videos = [{ measureCode: '' }];
      expect((await act('open_product', { sku: 'sku_tomatoes' })).data.has_video).toBe(true);
      const catalogue = await act('open_category');
      const row = catalogue.data.products.find((r: any) => r.id === 'sku_tomatoes');
      expect(row['main-content'].metadata).toMatch(/^🎥 Video · /);
    });

    it('marks the measures that have their own video', async () => {
      tomatoes().videos = [{ measureCode: 'basket' }];
      const result = await act('open_product', { sku: 'sku_tomatoes' });
      expect(result.data.has_video).toBe(true);
      const byId = Object.fromEntries(result.data.measures.map((m: any) => [m.id, m.description]));
      expect(byId).toEqual({ olonka: undefined, basket: '🎥 Video', tabletop: undefined });
    });

    it("sends the chosen measure's video, keeps that measure selected, and says so", async () => {
      tomatoes().videos = [{ measureCode: '' }, { measureCode: 'basket' }];
      const result = await act('send_video', { sku: 'sku_tomatoes', measure: 'basket', video: '1' });

      expect(result.screen).toBe('PRODUCT');
      expect(result.data).toMatchObject({
        current_measure: 'basket',
        video_link_label: '✅ Sent to your chat',
        has_video_note: true,
        video_note: expect.stringContaining('The Basket video is on its way to your chat'),
      });
      expect(productVideos.liveVideoFor).toHaveBeenCalledWith('sku_tomatoes', 'basket');
      expect(productVideos.sendToBuyer).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tenant-1' }),
        expect.objectContaining({ measureCode: 'basket' }),
        expect.any(String),
        'Tomatoes · Basket',
      );
      expect(state.carts[0]?.lines ?? []).toEqual([]); // nothing added to the basket
    });

    it("falls back to the whole product's video for a measure without one", async () => {
      tomatoes().videos = [{ measureCode: '' }];
      const result = await act('send_video', { sku: 'sku_tomatoes', measure: 'olonka', video: '1' });
      expect(productVideos.sendToBuyer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ measureCode: '' }), expect.any(String), 'Tomatoes');
      expect(result.data.video_note).toContain('The video is on its way');
    });

    it("says so when the chosen measure has no video and there's no product video", async () => {
      tomatoes().videos = [{ measureCode: 'basket' }];
      const result = await act('send_video', { sku: 'sku_tomatoes', measure: 'tabletop', video: '1' });
      expect(productVideos.sendToBuyer).not.toHaveBeenCalled();
      expect(result.data).toMatchObject({
        current_measure: 'tabletop',
        video_link_label: '🎥 Watch video',
        video_note: expect.stringContaining('There’s no video for Table top yet'),
      });
    });

    it('apologises in the chat when the video could not be sent', async () => {
      tomatoes().videos = [{ measureCode: '' }];
      productVideos.sendToBuyer.mockResolvedValue('failed');
      await act('send_video', { sku: 'sku_tomatoes', video: '1' });
      await vi.waitFor(() => expect(waba.sendTextMessage).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.stringContaining('couldn’t send that video')));
    });

    it("shows the product's own photo when it has one", async () => {
      productPhotos.flowPhotoBase64.mockResolvedValue('cmVhbC1waG90bw==');
      const result = await act('open_product', { sku: 'sku_tomatoes' });
      expect(result.data.photo).toBe('cmVhbC1waG90bw==');
      expect(productPhotos.flowPhotoBase64).toHaveBeenCalledWith(expect.objectContaining({ id: 'sku_tomatoes' }));
    });

    it('adds a line and returns to CATALOGUE with the basket counters updated', async () => {
      await act('open_product', { sku: 'sku_tomatoes' });
      const result = await act('add_line', { sku: 'sku_tomatoes', measure: 'basket', qty: '2' });

      expect(result.screen).toBe('CATALOGUE');
      expect(result.data.basket_bar[0]).toMatchObject({
        'main-content': {
          title: 'View basket & checkout',
          description: '1 item in basket',
          metadata: 'Vegetables & fruits · page 1 of 1 · tap here to review your basket and pay',
        },
        start: { image: BASKET_ICON, 'alt-text': 'Basket' },
        end: { title: 'GH₵ 240' },
        badge: 'Tap to checkout',
      });
      const tomatoes = result.data.products.find((r: any) => r.id === 'sku_tomatoes');
      expect(tomatoes['main-content'].metadata).toBe('✓ 2 in basket · GH₵ 240');
      expect(tomatoes.end).toBeUndefined();
    });

    it('edits an existing line: pre-fills it, offers Remove, and a new measure replaces the old line', async () => {
      await act('open_product', { sku: 'sku_tomatoes' });
      await act('add_line', { sku: 'sku_tomatoes', measure: 'basket', qty: '2' });

      const editing = await act('open_product', { sku: 'sku_tomatoes' });
      expect(editing.data).toMatchObject({ current_measure: 'basket', current_qty: '2', button_label: 'Update basket' });
      expect(editing.data.measures.at(-1)).toEqual({ id: 'remove', title: 'Remove from basket' });

      await act('add_line', { sku: 'sku_tomatoes', measure: 'olonka', qty: '3' });
      expect(state.carts[0].lines).toEqual([{ sku: 'sku_tomatoes', measure: 'olonka', qty: 3 }]);
    });

    it('returns to BASKET when the edit started from a basket line', async () => {
      await act('add_line', { sku: 'sku_onions', measure: 'each', qty: '1' });
      await act('open_product', { sku: 'sku_onions', measure: 'each' });
      const result = await act('add_line', { sku: 'sku_onions', measure: 'each', qty: '4' });

      expect(result.screen).toBe('BASKET');
      expect(state.carts[0].lines).toEqual([{ sku: 'sku_onions', measure: 'each', qty: 4 }]);
    });

    it('removes every line for the product when "remove" is chosen', async () => {
      await act('add_line', { sku: 'sku_tomatoes', measure: 'basket', qty: '1' });
      await act('add_line', { sku: 'sku_tomatoes', measure: 'olonka', qty: '1' });
      await act('open_product', { sku: 'sku_tomatoes' });
      await act('add_line', { sku: 'sku_tomatoes', measure: 'remove', qty: '1' });
      expect(state.carts[0].lines).toEqual([]);
    });

    it('removes only the tapped line when "remove" is chosen from BASKET', async () => {
      await act('add_line', { sku: 'sku_tomatoes', measure: 'basket', qty: '1' });
      await act('add_line', { sku: 'sku_tomatoes', measure: 'olonka', qty: '2' });
      await act('open_product', { sku: 'sku_tomatoes', measure: 'basket' });
      const result = await act('add_line', { sku: 'sku_tomatoes', measure: 'remove', qty: '1' });

      expect(result.screen).toBe('BASKET');
      expect(state.carts[0].lines).toEqual([{ sku: 'sku_tomatoes', measure: 'olonka', qty: 2 }]);
    });

    it('ignores measures the product does not have', async () => {
      await act('add_line', { sku: 'sku_tomatoes', measure: 'crate', qty: '1' });
      expect(state.carts[0].lines).toEqual([]);
    });
  });

  describe('BASKET', () => {
    it('lists lines newest first with a checkout bar', async () => {
      await act('add_line', { sku: 'sku_tomatoes', measure: 'basket', qty: '2' });
      await act('add_line', { sku: 'sku_onions', measure: 'each', qty: '2' });
      const result = await act('open_basket');

      expect(result.screen).toBe('BASKET');
      expect(result.data.checkout_bar[0]).toMatchObject({
        'main-content': {
          title: 'Proceed to checkout',
          description: 'Total GH₵ 250',
          metadata: '2 items · tap here to enter delivery and pay',
        },
        start: { image: CHECKOUT_ICON, 'alt-text': 'Checkout' },
        badge: 'Tap to order',
      });
      // Both rows carry an icon, or WhatsApp draws an empty frame on the one without.
      expect(result.data.checkout_bar[1].start).toEqual({ image: ADD_MORE_ICON, 'alt-text': 'Add more products' });
      expect(result.data.checkout_bar[0]['on-click-action'].payload.step).toBe('build_summary');
      expect(result.data.lines.map((l: any) => l.id)).toEqual(['sku_onions:each', 'sku_tomatoes:basket']);
      expect(result.data.checkout_bar.map((row: any) => row.id)).toEqual(['checkout', 'more']);
      expect(result.data.lines[1]['main-content'].description).toBe('2 baskets');
      expect(result.data.lines[0]['main-content'].description).toBe('×2');
      expect(result.data.lines[1]['on-click-action'].payload).toMatchObject({ step: 'open_product', measure: 'basket' });
    });

    it('shows the empty state with only "Add more products"', async () => {
      const result = await act('open_basket');
      expect(result.data.checkout_bar[0]['main-content']).toEqual({ title: 'Basket is empty', description: 'add something' });
      expect(result.data.lines.map((l: any) => l.id)).toEqual(['more']);
    });

    it('drops lines whose product went out of stock', async () => {
      await act('add_line', { sku: 'sku_onions', measure: 'each', qty: '2' });
      state.products.find((p) => p.id === 'sku_onions').inStock = false;
      const result = await act('open_basket');
      expect(result.data.lines.map((l: any) => l.id)).toEqual(['more']);
      expect(state.carts[0].lines).toEqual([]);
    });

    it('keeps money labels inside the 10-character end.title limit', async () => {
      state.products[0].measures[1].price = 1234.5;
      await act('add_line', { sku: 'sku_tomatoes', measure: 'basket', qty: '10' });
      const result = await act('open_basket');
      expect(result.data.lines[0].end.title.length).toBeLessThanOrEqual(10);
      expect(result.data.checkout_bar[0]['main-content'].description.length).toBeLessThanOrEqual(20);
    });
  });

  describe('Repeat my last order', () => {
    it('copies the last order into the basket at current prices, skipping unavailable items', async () => {
      state.lastOrder = {
        createdAt: new Date(),
        totalAmount: 95,
        items: [
          { productId: 'sku_tomatoes', measureCode: 'olonka', quantity: 2 },
          { productId: 'sku_gone', measureCode: 'each', quantity: 1 },
        ],
      };
      const result = await act('open_category', { category: 'reorder_last' });

      expect(result.screen).toBe('BASKET');
      expect(result.data.category).toBe('all'); // "Add more products" lands on All products, not the reorder pseudo-category
      expect(result.data.lines.map((l: any) => l.id)).toEqual(['sku_tomatoes:olonka']);
      expect(result.data.checkout_bar[0]['main-content'].description).toBe('Total GH₵ 50');
    });
  });

  describe('CHECKOUT and place_order', () => {
    beforeEach(async () => {
      await act('add_line', { sku: 'sku_tomatoes', measure: 'basket', qty: '2' });
    });

    it('builds CHECKOUT with the tenant areas, "asap" first, and the total incl. delivery', async () => {
      const result = await act('build_summary');
      expect(result.screen).toBe('CHECKOUT');
      expect(result.data.cart_id).toBe('cart-1');
      expect(result.data).toMatchObject({
        has_notice: false,
        notice: '',
        order_summary: 'Tomatoes · 2 baskets · GH₵ 240\nDelivery · GH₵ 10\nTotal · GH₵ 250',
        items_caption: '1 item',
        total_caption: 'GH₵ 250',
        category: 'veg_fruits',
      });
      expect(result.data.delivery_areas).toEqual(tenant.deliveryAreas);
      expect(result.data.delivery_slots.map((s: any) => s.id)).toEqual(['asap', 'today_pm']);
      expect(result.data.payment_methods.map((p: any) => p.id)).toEqual(['momo', 'cash']);
    });

    it('pre-fills a first-time buyer with their WhatsApp number', async () => {
      const result = await act('build_summary');
      expect(result.data).toMatchObject({
        init_full_name: '', init_area: '', init_landmark: '', init_phone: '0240000000',
        init_slot: 'asap', init_payment: 'momo', init_momo: '0240000000',
      });
    });

    it("pre-fills a repeat buyer from their last order, except the area, which they always pick", async () => {
      state.lastOrder = {
        customerName: 'Ama Mensah', deliveryArea: 'Ayigya', landmark: 'Unity Hall B12',
        contactPhone: '+233244000000', paymentMethod: PaymentMethod.COD, paymentPhone: null,
      };
      const result = await act('build_summary');
      expect(result.data).toMatchObject({
        init_full_name: 'Ama Mensah', init_area: '', init_landmark: 'Unity Hall B12',
        init_phone: '0244000000', init_payment: 'cash', init_momo: '0240000000',
      });
    });

    it('lists up to 8 basket lines in the summary, newest first, and sums the rest', async () => {
      for (let i = 0; i < 9; i++) {
        state.products.push({ id: `p${i}`, tenantId: 'tenant-1', name: `Item ${i}`, price: 1, inStock: true, categoryId: 'veg_fruits', measures: [] });
        await act('add_line', { sku: `p${i}`, measure: 'each', qty: '1' });
      }
      const summary: string[] = (await act('build_summary')).data.order_summary.split('\n');
      expect(summary[0]).toBe('Item 8 · ×1 · GH₵ 1');
      expect(summary).toHaveLength(8 + 3);
      expect(summary.at(-3)).toBe('+ 2 more items · GH₵ 241');
      expect(summary.at(-1)).toBe('Total · GH₵ 259');
    });

    it('goes back to BASKET from "Edit basket", even when WhatsApp drops the step', async () => {
      const bare = await service.handleFlowAction({
        version: '3.0', action: 'data_exchange', screen: 'CHECKOUT', flow_token: TOKEN, data: { category: 'veg_fruits' },
      });
      expect(bare.screen).toBe('BASKET');
      expect(orderService.createOrder).not.toHaveBeenCalled();
    });

    it('sends an empty basket back to BASKET instead of CHECKOUT', async () => {
      await act('open_product', { sku: 'sku_tomatoes' });
      await act('add_line', { sku: 'sku_tomatoes', measure: 'remove' });
      expect((await act('build_summary')).screen).toBe('BASKET');
    });

    const placeOrder = (extra: Record<string, any> = {}) =>
      act('place_order', {
        cart_id: 'cart-1', full_name: 'Ama Mensah', delivery_area: 'knust', landmark: 'Unity Hall B12',
        rider_phone: '0244000000', delivery_slot: 'asap', payment: 'momo', momo_number: '0244111222', ...extra,
      });

    it('stays on CHECKOUT with a warning when the MoMo number is invalid', async () => {
      const result = await placeOrder({ momo_number: '12345' });
      expect(result.screen).toBe('CHECKOUT');
      expect(result.data).toMatchObject({ has_notice: true, notice: '⚠️ Enter a valid 10-digit MoMo number' });
      // The area just picked stays selected, so the buyer only fixes the MoMo number.
      expect(result.data).toMatchObject({ init_full_name: 'Ama Mensah', init_area: 'knust', init_landmark: 'Unity Hall B12', init_momo: '12345' });
      expect(orderService.createOrder).not.toHaveBeenCalled();
    });

    it('confirms the order after a minute for buyers who never tap Done', async () => {
      vi.useFakeTimers();
      try {
        const confirm = vi.fn().mockResolvedValue(true);
        service.onConfirmationDue(confirm);

        await placeOrder();
        await placeOrder(); // a repeat returns the same order and schedules nothing new
        await vi.advanceTimersByTimeAsync(59_000);
        expect(confirm).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1_000);
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ id: 'tenant-1' }), 'MX-ABC123', '+233240000000');
      } finally {
        vi.useRealTimers();
      }
    });

    it('creates a MoMo order priced from the DB, starts the MoMo prompt and shows ORDER_RECEIVED', async () => {
      const result = await placeOrder();

      expect(orderService.createOrder).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({
          buyerPhone: '+233240000000',
          status: OrderStatus.AWAITING_PAYMENT,
          paymentMethod: PaymentMethod.MOMO,
          paymentPhone: '0244111222',
          momoNetwork: 'mtn',
          deliveryAddress: 'KNUST Campus — Unity Hall B12',
          deliveryFee: 10,
          items: [{ productId: 'sku_tomatoes', productName: 'Tomatoes (Basket)', measureCode: 'basket', unitPrice: 120, quantity: 2 }],
        }),
        expect.objectContaining({
          customerName: 'Ama Mensah', deliveryArea: 'KNUST Campus', landmark: 'Unity Hall B12',
          contactPhone: '+233244000000', deliverySlot: 'Now · within 1 hour', flowCartId: 'cart-1',
        }),
        { creditPromoter: true },
      );
      expect(paystack.initiateMoMoCharge).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 250, momoNumber: '0244111222', reference: 'MX-ABC123' }),
      );
      expect(result.screen).toBe('ORDER_RECEIVED');
      expect(result.data).toEqual({
        order_id: 'MX-ABC123',
        order_line: 'Order MX-ABC123 · GH₵ 250',
        steps:
          '1. 📲 Approve the MoMo prompt on 024 411 1222\n' +
          '2. 📍 Tap the button below, then share your location pin in the chat\n' +
          '3. 🛵 Delivery: Now · within 1 hour',
      });
    });

    it('is idempotent: a repeated place_order returns the same order', async () => {
      await placeOrder();
      const again = await placeOrder();
      expect(orderService.createOrder).toHaveBeenCalledTimes(1);
      expect(again.data.order_id).toBe('MX-ABC123');
    });

    it('confirms cash orders with a cash payment note', async () => {
      const result = await placeOrder({ payment: 'cash', momo_number: '' });
      expect(orderService.createOrder).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({ status: OrderStatus.CONFIRMED, paymentMethod: PaymentMethod.COD, paymentPhone: undefined }),
        expect.anything(),
        { creditPromoter: true },
      );
      expect(result.data.steps.split('\n')[0]).toBe('1. 💵 Have GH₵ 250 ready in cash for the rider');
    });
  });

  describe('confirming an order (completeOrder)', () => {
    const order = {
      id: 'order-1', tenantId: 'tenant-1', orderNumber: 'MX-ABC123', totalAmount: 250, status: OrderStatus.AWAITING_PAYMENT,
      paymentMethod: PaymentMethod.MOMO, paymentPhone: '0244111222', momoNetwork: 'mtn', buyerPhone: '+233240000000', items: [],
    };

    it('sends the MoMo prompt once and returns the receipt', async () => {
      orderService.findByOrderNumber.mockResolvedValue(order);
      const result = await service.completeOrder(tenant as any, 'MX-ABC123', '+233240000000');

      expect(paystack.initiateMoMoCharge).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 250, momoNumber: '0244111222', provider: 'mtn', reference: 'MX-ABC123' }),
      );
      expect(result!.text).toContain('Order MX-ABC123 placed successfully');
    });

    it('does not charge again when the prompt was already sent', async () => {
      orderService.findByOrderNumber.mockResolvedValue(order);
      orderService.claimPaymentRequest.mockResolvedValue(false);
      await service.completeOrder(tenant as any, 'MX-ABC123', '+233240000000');
      expect(paystack.initiateMoMoCharge).not.toHaveBeenCalled();
    });

    it('sends nothing the second time (place_order and Done both confirm)', async () => {
      orderService.findByOrderNumber.mockResolvedValue(order);
      orderService.claimConfirmation.mockResolvedValue(false);

      const result = await service.completeOrder(tenant as any, 'MX-ABC123', '+233240000000');
      expect(result).toEqual({ order, text: null });
      expect(paystack.initiateMoMoCharge).not.toHaveBeenCalled();
    });

    it('waits for the prompt started at place_order and reports its failure on the receipt', async () => {
      let refuse!: (result: any) => void;
      paystack.initiateMoMoCharge.mockReturnValue(new Promise((resolve) => (refuse = resolve)));
      await act('add_line', { sku: 'sku_tomatoes', measure: 'basket', qty: '1' });
      await act('place_order', { cart_id: 'cart-1', delivery_area: 'knust', payment: 'momo', momo_number: '0244111222' });

      orderService.findByOrderNumber.mockResolvedValue(order);
      const receipt = service.completeOrder(tenant as any, 'MX-ABC123', '+233240000000');
      refuse({ success: false, status: 'failed', reference: 'MX-ABC123', message: 'Invalid number' });

      expect((await receipt)!.text).toContain("couldn't send the MoMo prompt");
      expect(paystack.initiateMoMoCharge).toHaveBeenCalledTimes(1);
    });

    it('releases the claim and tells the buyer when the prompt fails', async () => {
      orderService.findByOrderNumber.mockResolvedValue(order);
      paystack.initiateMoMoCharge.mockResolvedValue({ success: false, status: 'failed', reference: 'MX-ABC123', message: 'Invalid number' });

      const result = await service.completeOrder(tenant as any, 'MX-ABC123', '+233240000000');
      expect(orderService.releasePaymentRequest).toHaveBeenCalledWith('order-1');
      expect(result!.text).toContain("couldn't send the MoMo prompt");
    });

    it('ignores orders from another tenant', async () => {
      orderService.findByOrderNumber.mockResolvedValue({ ...order, tenantId: 'other' });
      expect(await service.completeOrder(tenant as any, 'MX-ABC123', '+233240000000')).toBeNull();
    });

    it("ignores another buyer's order so their receipt is never revealed", async () => {
      orderService.findByOrderNumber.mockResolvedValue(order);
      expect(await service.completeOrder(tenant as any, 'MX-ABC123', '+233209999999')).toBeNull();
      expect(paystack.initiateMoMoCharge).not.toHaveBeenCalled();
    });

    it('matches the buyer across phone formats', async () => {
      orderService.findByOrderNumber.mockResolvedValue({ ...order, buyerPhone: '0240000000' });
      expect(await service.completeOrder(tenant as any, 'MX-ABC123', '233240000000')).not.toBeNull();
    });

    it('requests a delivery location pin and records it', async () => {
      expect(await service.requestDeliveryLocation(tenant as any, '+233240000000', order)).toBe('location_request');
      expect(waba.sendLocationRequest).toHaveBeenCalledWith('phone-1', '+233240000000', expect.stringContaining('MX-ABC123'));
      expect(orderService.markLocationRequested).toHaveBeenCalledWith('order-1');
      expect(waba.sendTextMessage).not.toHaveBeenCalled();
    });

    it('asks for the pin by text when WhatsApp refuses the location request', async () => {
      waba.sendLocationRequest.mockRejectedValueOnce(new Error('(#131062) BSUID recipients are not supported for this message'));
      expect(await service.requestDeliveryLocation(tenant as any, 'GH.123', order)).toBe('text');
      expect(waba.sendTextMessage).toHaveBeenCalledWith('phone-1', 'GH.123', expect.stringContaining('📎'));
      expect(orderService.markLocationRequested).toHaveBeenCalledWith('order-1'); // so the pin is still attached
    });

    it('reports when neither the location request nor the text could be sent', async () => {
      waba.sendLocationRequest.mockRejectedValueOnce(new Error('down'));
      waba.sendTextMessage.mockRejectedValueOnce(new Error('down'));
      expect(await service.requestDeliveryLocation(tenant as any, '+233240000000', order)).toBeNull();
      expect(orderService.markLocationRequested).not.toHaveBeenCalled();
    });

    it('asks by text once when Meta later reports the location request undelivered', async () => {
      waba.sendLocationRequest.mockResolvedValueOnce({ messageId: 'wamid.loc' });
      await service.requestDeliveryLocation(tenant as any, 'GH.123', order);

      expect(await service.handleFailedDelivery('wamid.other')).toBe(false);
      expect(await service.handleFailedDelivery('wamid.loc')).toBe(true);
      expect(await service.handleFailedDelivery('wamid.loc')).toBe(false);
      expect(waba.sendTextMessage).toHaveBeenCalledTimes(1);
      expect(waba.sendTextMessage).toHaveBeenCalledWith('phone-1', 'GH.123', expect.stringContaining('MX-ABC123'));
    });
  });
});
