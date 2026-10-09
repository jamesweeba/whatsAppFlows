import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FlowService } from './flow.service.js';

describe('FlowService', () => {
  let service: FlowService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      tenant: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
      product: {
        findMany: vi.fn(),
        count: vi.fn(),
      },
      order: {
        create: vi.fn(),
      },
    };

    service = new FlowService(prisma, {} as any);
  });

  it('returns at most five database products per page and provides page navigation options', async () => {
    prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant-1' });
    prisma.product.count.mockResolvedValue(12);
    prisma.product.findMany.mockImplementation(({ skip, take }: { skip: number; take: number }) =>
      Array.from({ length: Math.min(take, 12 - skip) }, (_, index) => {
        const productNumber = skip + index + 1;
        return {
          id: `p${productNumber}`,
          name: `Product ${productNumber}`,
          price: productNumber,
        };
      }),
    );

    const firstPage = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'INIT',
      screen: 'PRODUCT_SELECT',
    });
    const nextPage = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      data: {
        step: 'next_page',
        page: '1',
        selected_ids: [],
        visible_product_ids: ['p1', 'p2', 'p3', 'p4', 'p5'],
        selected_on_page: ['p1', 'p3'],
      },
    });

    expect(prisma.product.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ skip: 0, take: 5 }),
    );
    expect(firstPage.data.products).toHaveLength(5);
    expect(firstPage.data.page_options).toEqual([
      { id: '1', title: 'Page 1' },
      { id: '2', title: 'Page 2' },
      { id: '3', title: 'Page 3' },
    ]);
    expect(firstPage.data.pages).toEqual([
      { id: '1', title: 'Page 1 of 3' },
      { id: '2', title: 'Page 2 of 3' },
      { id: '3', title: 'Page 3 of 3' },
    ]);
    expect(firstPage.data.page_prefill).toBe('1');
    expect(firstPage.data.has_previous_page).toBe(false);
    expect(firstPage.data.has_next_page).toBe(true);
    expect(firstPage.data.visible_product_ids).toEqual([
      'p1',
      'p2',
      'p3',
      'p4',
      'p5',
    ]);
    expect(nextPage.data.products.map(({ id }: { id: string }) => id)).toEqual([
      'p6',
      'p7',
      'p8',
      'p9',
      'p10',
    ]);
    expect(nextPage.data.page_prefill).toBe('2');
    expect(nextPage.data.selected_ids).toEqual(['p1', 'p3']);
  });

  it('accepts the page_select field used by the Flow definition and preserves selections between pages', async () => {
    prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant-1' });
    prisma.product.count.mockResolvedValue(12);
    prisma.product.findMany.mockImplementation(({ skip, take }: { skip: number; take: number }) =>
      Array.from({ length: Math.min(take, 12 - skip) }, (_, index) => {
        const productNumber = skip + index + 1;
        return {
          id: `p${productNumber}`,
          name: `Product ${productNumber}`,
          price: productNumber,
        };
      }),
    );

    const pageTwo = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      data: {
        step: 'go_page',
        page_select: '2',
        selected_ids: ['p1'],
        visible_product_ids: ['p1', 'p2', 'p3', 'p4', 'p5'],
        selected_products: ['p1', 'p3'],
      },
    });

    expect(prisma.product.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ skip: 5, take: 5 }),
    );
    expect(pageTwo.data.page_prefill).toBe('2');
    expect(pageTwo.data.selected_ids).toEqual(['p1', 'p3']);
    expect(pageTwo.data.pre_selected).toEqual([]);
    expect(pageTwo.data.has_previous_page).toBe(true);
    expect(pageTwo.data.has_next_page).toBe(true);
  });

  it('preserves multi-page selections when moving between page 1 and page 2 and continuing to quantities', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1' });
    prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant-1' });
    prisma.product.count.mockResolvedValue(10);
    prisma.product.findMany.mockImplementation(({ skip, take, where }: any) => {
      if (where?.id?.in) {
        return where.id.in.map((id: string) => ({
          id,
          name: id === 'p1' ? 'Tomatoes' : 'Onions',
          price: 10,
          inStock: true,
        }));
      }
      return Array.from({ length: Math.min(take, 10 - skip) }, (_, index) => {
        const productNumber = skip + index + 1;
        return {
          id: `p${productNumber}`,
          name: productNumber === 1 ? 'Tomatoes' : productNumber === 6 ? 'Onions' : `Product ${productNumber}`,
          price: productNumber * 5,
        };
      });
    });

    const flowToken = 'tenant-1:flow-session-1';

    // 1. User opens PRODUCT_SELECT (Page 1)
    const page1 = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'INIT',
      screen: 'PRODUCT_SELECT',
      flow_token: flowToken,
    });
    expect(page1.data.products[0].id).toBe('p1');
    expect(page1.data.pre_selected).toEqual([]);

    // 2. User selects Tomatoes ('p1') on Page 1 and navigates to Page 2
    const page2 = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      flow_token: flowToken,
      data: {
        step: 'next_page',
        page: '1',
        selected_products: ['p1'],
        visible_product_ids: ['p1', 'p2', 'p3', 'p4', 'p5'],
      },
    });
    expect(page2.data.page_prefill).toBe('2');
    expect(page2.data.selected_ids).toContain('p1');
    expect(page2.data.selection_note).toContain('1 item(s) selected');

    // 3. User selects Onions ('p6') on Page 2 and navigates back to Page 1
    const backToPage1 = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      flow_token: flowToken,
      data: {
        step: 'previous_page',
        page: '2',
        selected_products: ['p6'],
        visible_product_ids: ['p6', 'p7', 'p8', 'p9', 'p10'],
      },
    });
    expect(backToPage1.data.page_prefill).toBe('1');
    expect(backToPage1.data.pre_selected).toEqual(['p1']);
    expect(backToPage1.data.selected_products).toEqual(['p1']);
    expect(backToPage1.data.selected_ids).toEqual(['p1', 'p6']);
    expect(backToPage1.data.selection_note).toContain('2 item(s) selected');

    // 4. User clicks Continue
    const quantities = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      flow_token: flowToken,
      data: {
        step: 'continue',
        page: '1',
        selected_products: ['p1'],
        visible_product_ids: ['p1', 'p2', 'p3', 'p4', 'p5'],
      },
    });
    expect(quantities.screen).toBe('QUANTITIES');
    expect(quantities.data.show_0).toBe(true);
    expect(quantities.data.show_1).toBe(true);
    expect([quantities.data.item_0_id, quantities.data.item_1_id]).toContain('p1');
    expect([quantities.data.item_0_id, quantities.data.item_1_id]).toContain('p6');
  });

  it('creates quantity slots with compatible flow keys', async () => {
    prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant-1' });
    prisma.product.count.mockResolvedValue(2);
    prisma.product.findMany.mockResolvedValue([
      { id: 'p1', name: 'Tomato', price: 2.5, inStock: true },
      { id: 'p2', name: 'Onion', price: 1.5, inStock: true },
    ]);

    const result = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      data: { step: 'continue', selected_on_page: ['p1', 'p2'] },
    });

    expect(result.screen).toBe('QUANTITIES');
    expect(result.data.item_0_id).toBe('p1');
    expect(result.data.item_0_label).toContain('Tomato');
    expect(result.data.item_0_label.length).toBeLessThanOrEqual(20);
    expect(result.data.item_0_price).toBe('₵2.50');
    expect(result.data.item_0_sublabel).toBe('💰 ₵2.50');
    expect(result.data.item_0_options).toHaveLength(10);
    expect(result.data.item_0_default).toBe('1');
    expect(result.data.show_0).toBe(true);
    expect(result.data.item_1_id).toBe('p2');
    expect(result.data.item_1_label).toContain('Onion');
    expect(result.data.item_1_label.length).toBeLessThanOrEqual(20);
    expect(result.data.item_1_price).toBe('₵1.50');
    expect(result.data.item_1_sublabel).toBe('💰 ₵1.50');
    expect(result.data.show_1).toBe(true);
    expect(result.data.item_2_id).toBe(' ');
    expect(result.data.show_2).toBe(false);
    expect(Object.keys(result.data)).toHaveLength(100);
    expect(result.data).not.toHaveProperty('i0_id');
    expect(result.data).not.toHaveProperty('show0');
  });

  it('reads quantities from both modern and legacy key formats', async () => {
    prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant-1' });
    prisma.product.count.mockResolvedValue(2);
    prisma.product.findMany.mockResolvedValue([
      { id: 'p1', name: 'Tomato', price: 2.5, inStock: true },
      { id: 'p2', name: 'Onion', price: 1.5, inStock: true },
    ]);

    const result = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      data: {
        step: 'quantities',
        item_0_id: 'p1',
        item_0_qty: '2',
        item_1_id: 'p2',
        item_1_qty: '3',
      },
    });

    expect(result.screen).toBe('SUMMARY');
    expect(result.data.summary_lines).toContain('Tomato: 2 × ₵2.50 = ₵5.00');
    expect(result.data.summary_lines).toContain('Onion: 3 × ₵1.50 = ₵4.50');
    expect(result.data.order_total).toBe('💰 Total: ₵9.50');
  });

  it('opens MENU screen on INIT and routes to TRACK and HUMAN support screens', async () => {
    prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant-1', name: 'SuperStore' });

    const initMenu = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'INIT',
    });
    expect(initMenu.screen).toBe('MENU');
    expect(initMenu.data.menu_options).toHaveLength(3);

    const trackScreen = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      data: { menu_selection: 'TRACK' },
    });
    expect(trackScreen.screen).toBe('TRACK_ORDER');

    const supportScreen = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      data: { menu_selection: 'HUMAN' },
    });
    expect(supportScreen.screen).toBe('SUPPORT_MESSAGE');
  });

  it('formats product titles with appropriate image icons and caps length at 30 characters', () => {
    expect(service.formatProductTitle('Tomatoes')).toBe('🍅 Tomatoes');
    expect(service.formatProductTitle('Onions')).toBe('🧅 Onions');
    expect(service.formatProductTitle('Pepper')).toBe('🌶️ Pepper');
    expect(service.formatProductTitle('Carrots')).toBe('🥕 Carrots');
    expect(service.formatProductTitle('Cabbage')).toBe('🥬 Cabbage');
    expect(service.formatProductTitle('Fresh Milk')).toBe('🥛 Fresh Milk');
    expect(service.formatProductTitle('Bread', '🍞')).toBe('🍞 Bread');
    expect(service.formatProductTitle('🍅 Tomatoes')).toBe('🍅 Tomatoes');

    const scotchBonnet = service.formatProductTitle('Scotch Bonnet Pepper (1 cup)');
    expect(scotchBonnet.length).toBeLessThanOrEqual(30);
    expect(scotchBonnet).toBe('🌶️ Scotch Bonnet Pepper (1...');
  });

  it('supports set_category step and returns flow categories with prefilled category', async () => {
    prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant-1' });
    prisma.product.count.mockResolvedValue(1);
    prisma.product.findMany.mockResolvedValue([
      { id: 'p1', name: 'Carrots', price: 2.5, inStock: true },
    ]);

    const result = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      data: {
        step: 'set_category',
        category: 'vegetables',
        query: '',
        selected_on_page: [],
      },
    });

    expect(result.screen).toBe('PRODUCT_SELECT');
    expect(result.data.category_prefill).toBe('vegetables');
    expect(result.data.categories).toHaveLength(5);
    expect(result.data.categories[1].id).toBe('vegetables');
    expect(result.data.products).toHaveLength(1);
  });

  it('parses QUANTITIES footer payload using i{n}_id and i{n}_qty keys', async () => {
    prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant-1' });
    prisma.product.findMany.mockResolvedValue([
      { id: 'prod-1', name: 'Tomatoes', price: 2.0, inStock: true },
      { id: 'prod-3', name: 'Pepper', price: 3.0, inStock: true },
    ]);

    const result = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      data: {
        step: 'quantities',
        i0_id: 'prod-1',
        i0_qty: '2',
        i1_id: 'prod-3',
        i1_qty: '1',
      },
    });

    expect(result.screen).toBe('SUMMARY');
    expect(result.data.summary_lines).toContain('2 × ₵2.00');
    expect(result.data.summary_lines).toContain('1 × ₵3.00');
    expect(result.data.order_total).toBe('💰 Total: ₵7.00');
    expect(result.data.error_message).toBe(' ');
    expect(result.data.show_error).toBe(false);
  });

  it('routes SUMMARY to PAYMENT screen on to_payment step', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1' });
    prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant-1' });
    prisma.product.findMany.mockResolvedValue([
      { id: 'prod-1', name: 'Tomatoes', price: 2.0, inStock: true },
      { id: 'prod-3', name: 'Pepper', price: 3.0, inStock: true },
    ]);

    const result = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      flow_token: 'tenant-1:0241234567',
      data: {
        step: 'to_payment',
        cart: JSON.stringify([
          { id: 'prod-1', qty: 2 },
          { id: 'prod-3', qty: 1 },
        ]),
        fulfillment: 'delivery',
        address: '123 Market St, Near Post Office',
      },
    });

    expect(result.screen).toBe('PAYMENT');
    expect(result.data.order_total).toBe('Total: ₵7.00');
    expect(result.data.pay_label).toBe('Pay ₵7.00');
    expect(result.data.networks).toHaveLength(3);
    expect(result.data.number_prefill).toBe('0241234567');
  });

  it('creates order on pay step and returns DONE screen', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1' });
    prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant-1' });
    prisma.product.findMany.mockResolvedValue([
      { id: 'prod-1', name: 'Tomatoes', price: 2.0, inStock: true },
      { id: 'prod-3', name: 'Pepper', price: 3.0, inStock: true },
    ]);
    prisma.order.create.mockResolvedValue({
      orderNumber: '550e8400-e29b-41d4-a716-446655440000',
    });

    const result = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      flow_token: 'tenant-1:123456789',
      data: {
        step: 'pay',
        payment_method: 'momo',
        momo_network: 'mtn',
        momo_number: '0241234567',
        cart: JSON.stringify([
          { id: 'prod-1', qty: 2 },
          { id: 'prod-3', qty: 1 },
        ]),
        fulfillment: 'delivery',
        address: '123 Market St, Near Post Office',
      },
    });

    expect(result.screen).toBe('DONE');
    expect(result.data.order_ref).toBe('MX-55440000');
    expect(result.data.done_message).toContain('Order placed');
    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-1',
          totalAmount: 7,
          notes: expect.stringContaining('123 Market St'),
        }),
      }),
    );
  });

  it('rejects to_payment step when delivery is selected without address', async () => {
    prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant-1' });

    const result = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      data: {
        step: 'to_payment',
        cart: JSON.stringify([{ id: 'prod-1', qty: 2 }]),
        fulfillment: 'delivery',
        address: '',
      },
    });

    expect(result.screen).toBe('SUMMARY');
    expect(result.data.show_error).toBe(true);
    expect(result.data.error_message).toContain('delivery address');
  });
});
