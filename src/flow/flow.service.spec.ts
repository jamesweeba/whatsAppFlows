import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FlowService } from './flow.service.js';

describe('FlowService (PRODUCT_SELECT -> QUANTITIES -> SUMMARY -> PAYMENT -> DONE)', () => {
  let service: FlowService;
  let prisma: any;

  let mockPaystackService: any;

  beforeEach(() => {
    prisma = {
      tenant: {
        findUnique: vi.fn().mockResolvedValue({ id: 'tenant-1', user: { email: 'tenant@marketix.app' } }),
        findFirst: vi.fn().mockResolvedValue({ id: 'tenant-1', user: { email: 'tenant@marketix.app' } }),
      },
      product: {
        findMany: vi.fn(),
        count: vi.fn(),
      },
      order: {
        create: vi.fn().mockResolvedValue({ id: 'order-1', orderNumber: 'MX-1042' }),
      },
    };

    mockPaystackService = {
      initiateMoMoCharge: vi.fn().mockResolvedValue({
        success: true,
        status: 'pay_offline',
        reference: 'MX-1042',
        message: 'Prompt initiated',
        displayText: 'Please approve the prompt on your phone',
      }),
      normalizeGhanaPhone: vi.fn((phone: string) => (phone ? phone.replace(/[^\d]/g, '') : '')),
      verifyWebhookSignature: vi.fn().mockReturnValue(true),
    };

    service = new FlowService(prisma, {} as any, mockPaystackService);
  });

  it('opens PRODUCT_SELECT on INIT by default', async () => {
    prisma.product.count.mockResolvedValue(10);
    prisma.product.findMany.mockResolvedValue([
      { id: 'p1', name: 'Tomatoes', price: 2.5, image: '🍅' },
      { id: 'p2', name: 'Onions', price: 1.5, image: '🧅' },
    ]);

    const result = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'INIT',
      screen: 'PRODUCT_SELECT',
    });

    expect(result.screen).toBe('PRODUCT_SELECT');
    expect(result.data.categories).toHaveLength(5);
    expect(result.data.category_prefill).toBe('all');
    expect(result.data.products).toHaveLength(2);
    expect(result.data.page_prefill).toBe('1');
    expect(result.data.pre_selected).toEqual([]);
    expect(result.data.selection_note).toBe('🛒 Your basket is empty — tap items to add');
  });

  it('handles category filtering, search, and page navigation on PRODUCT_SELECT', async () => {
    prisma.product.count.mockResolvedValue(10);
    prisma.product.findMany.mockResolvedValue([
      { id: 'p1', name: 'Tomatoes', price: 2.5, image: '🍅' },
    ]);

    const flowToken = 'tenant-1:session-1';

    // 1. Category filter
    const catRes = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      screen: 'PRODUCT_SELECT',
      flow_token: flowToken,
      data: {
        step: 'set_category',
        category: 'vegetables',
        query: '',
        selected_on_page: [],
      },
    });

    expect(catRes.screen).toBe('PRODUCT_SELECT');
    expect(catRes.data.category_prefill).toBe('vegetables');

    // 2. Search query
    const searchRes = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      screen: 'PRODUCT_SELECT',
      flow_token: flowToken,
      data: {
        step: 'search',
        query: 'rice',
        category: 'all',
        selected_on_page: [],
      },
    });

    expect(searchRes.screen).toBe('PRODUCT_SELECT');
    expect(searchRes.data.search_prefill).toBe('rice');

    // 3. Page navigation
    const pageRes = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      screen: 'PRODUCT_SELECT',
      flow_token: flowToken,
      data: {
        step: 'go_page',
        page: '2',
        query: '',
        category: 'all',
        selected_on_page: [],
      },
    });

    expect(pageRes.screen).toBe('PRODUCT_SELECT');
    expect(pageRes.data.page_prefill).toBe('2');
  });

  it('preserves multi-page selection and validates minimum selection on continue', async () => {
    prisma.product.count.mockResolvedValue(10);
    prisma.product.findMany.mockImplementation(({ where }: any) => {
      if (where?.id?.in) {
        return where.id.in.map((id: string) => ({
          id,
          name: id === 'p1' ? 'Tomatoes' : 'Onions',
          price: 10,
          inStock: true,
        }));
      }
      return [
        { id: 'p1', name: 'Tomatoes', price: 10, inStock: true },
        { id: 'p2', name: 'Onions', price: 10, inStock: true },
      ];
    });

    const flowToken = 'tenant-1:session-2';

    // 1. Continue with 0 selected items -> Error notice
    const emptyRes = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      screen: 'PRODUCT_SELECT',
      flow_token: flowToken,
      data: {
        step: 'continue',
        selected_on_page: [],
      },
    });

    expect(emptyRes.screen).toBe('PRODUCT_SELECT');
    expect(emptyRes.data.show_notice).toBe(true);
    expect(emptyRes.data.notice).toContain('Please select at least one item');

    // 2. Continue with items -> Transitions to QUANTITIES
    const successRes = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      screen: 'PRODUCT_SELECT',
      flow_token: flowToken,
      data: {
        step: 'continue',
        selected_on_page: ['p1', 'p2'],
      },
    });

    expect(successRes.screen).toBe('QUANTITIES');
    expect(successRes.data.item_0_id).toBe('p1');
    expect(successRes.data.show_0).toBe(true);
    expect(successRes.data.item_1_id).toBe('p2');
    expect(successRes.data.show_1).toBe(true);
    expect(successRes.data.show_2).toBe(false);
  });

  it('routes from QUANTITIES to SUMMARY with order summary lines and default delivery', async () => {
    prisma.product.findMany.mockResolvedValue([
      { id: 'p1', name: 'Tomatoes', price: 2.0, inStock: true },
      { id: 'p2', name: 'Pepper', price: 3.0, inStock: true },
    ]);

    const result = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      screen: 'QUANTITIES',
      data: {
        step: 'quantities',
        i0_id: 'p1',
        i0_qty: '2',
        i1_id: 'p2',
        i1_qty: '1',
      },
    });

    expect(result.screen).toBe('SUMMARY');
    expect(result.data.summary_lines).toContain('Tomatoes');
    expect(result.data.summary_lines).toContain('Pepper');
    // 2x 2.00 + 1x 3.00 = 7.00 + 5.00 delivery = 12.00
    expect(result.data.order_total).toContain('12.00');
    expect(result.data.fulfillment_prefill).toBe('delivery');
  });

  it('validates address on SUMMARY and transitions to PAYMENT when valid', async () => {
    const cart = [
      { id: 'p1', title: 'Tomatoes', qty: 2, unitPrice: 2, total: 4 },
      { id: 'p2', title: 'Pepper', qty: 1, unitPrice: 3, total: 3 },
    ];
    const flowToken = 'tenant-1:session-to-pay';

    // 1. Delivery selected without address -> Stays on SUMMARY with error
    const missingAddrRes = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      screen: 'SUMMARY',
      flow_token: flowToken,
      data: {
        step: 'to_payment',
        cart: JSON.stringify(cart),
        fulfillment: 'delivery',
        address: '',
      },
    });

    expect(missingAddrRes.screen).toBe('SUMMARY');
    expect(missingAddrRes.data.show_error).toBe(true);
    expect(missingAddrRes.data.error_message).toContain('delivery address');

    // 2. Delivery with valid address -> Transitions to PAYMENT
    const validDeliveryRes = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      screen: 'SUMMARY',
      flow_token: flowToken,
      data: {
        step: 'to_payment',
        cart: JSON.stringify(cart),
        fulfillment: 'delivery',
        address: 'House 4, Cantonments',
      },
    });

    expect(validDeliveryRes.screen).toBe('PAYMENT');
    expect(validDeliveryRes.data.order_total).toBe('Total: ₵12.00');
    expect(validDeliveryRes.data.pay_label).toBe('Pay ₵12.00');
    expect(validDeliveryRes.data.networks).toHaveLength(3);

    // 3. Pickup without address -> Valid, transitions to PAYMENT with ₵0 delivery fee
    const pickupRes = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      screen: 'SUMMARY',
      flow_token: flowToken,
      data: {
        step: 'to_payment',
        cart: JSON.stringify(cart),
        fulfillment: 'pickup',
      },
    });

    expect(pickupRes.screen).toBe('PAYMENT');
    expect(pickupRes.data.order_total).toBe('Total: ₵7.00');
    expect(pickupRes.data.pay_label).toBe('Pay ₵7.00');
  });

  it('validates mobile money on PAYMENT and transitions to DONE screen on success', async () => {
    const flowToken = 'tenant-1:session-pay-done';

    // Seed session via to_payment
    await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      screen: 'SUMMARY',
      flow_token: flowToken,
      data: {
        step: 'to_payment',
        cart: JSON.stringify([{ id: 'p1', title: 'Tomatoes', qty: 2, unitPrice: 2, total: 4 }]),
        fulfillment: 'pickup',
      },
    });

    // 1. MoMo without phone number -> Stays on PAYMENT with error
    const missingMomoRes = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      screen: 'PAYMENT',
      flow_token: flowToken,
      data: {
        step: 'pay',
        payment_method: 'momo',
        momo_number: '',
      },
    });

    expect(missingMomoRes.screen).toBe('PAYMENT');
    expect(missingMomoRes.data.show_error).toBe(true);
    expect(missingMomoRes.data.error_message).toContain('mobile money number');

    // 2. Valid MoMo payment -> DONE screen and order created in Prisma
    const doneRes = await (service as any).handleFlowAction({
      version: '3.0',
      action: 'data_exchange',
      screen: 'PAYMENT',
      flow_token: flowToken,
      data: {
        step: 'pay',
        payment_method: 'momo',
        momo_network: 'mtn',
        momo_number: '0241234567',
      },
    });

    expect(doneRes.screen).toBe('DONE');
    expect(doneRes.data.order_ref).toBeDefined();
    expect(doneRes.data.done_message).toContain('Order placed');
    expect(mockPaystackService.initiateMoMoCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        momoNumber: '0241234567',
        provider: 'mtn',
        email: 'tenant@marketix.app',
      }),
    );
    expect(prisma.order.create).toHaveBeenCalled();
  });
});
