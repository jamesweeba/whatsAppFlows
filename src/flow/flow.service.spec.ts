import { Fulfillment, OrderStatus, PaymentMethod } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowService } from './flow.service.js';

describe('FlowService (PRODUCT_SELECT -> QUANTITIES -> SUMMARY -> PAYMENT -> DONE)', () => {
  let service: FlowService;
  let prisma: any;
  let paystack: any;
  let orderService: any;
  let waba: any;

  const tenant = {
    id: 'tenant-1',
    name: 'Marketix',
    whatsappPhoneNumberId: 'phone-1',
    deliveryFee: 5,
    pickupNote: null,
    user: { email: 'tenant@marketix.app' },
  };

  const exchange = (flowToken: string, screen: string, data: Record<string, any>) =>
    service.handleFlowAction({ version: '3.0', action: 'data_exchange', screen, flow_token: flowToken, data });

  beforeEach(() => {
    prisma = {
      tenant: { findUnique: vi.fn().mockResolvedValue(tenant) },
      product: { findMany: vi.fn(), count: vi.fn() },
    };

    paystack = {
      initiateMoMoCharge: vi.fn().mockResolvedValue({ success: true, status: 'pay_offline', reference: 'MX-1', message: 'ok' }),
      initializeCardPayment: vi.fn().mockResolvedValue({ success: true, authorizationUrl: 'https://checkout.paystack.com/abc' }),
    };

    orderService = {
      createOrder: vi.fn().mockImplementation(async (_tenantId: string, dto: any) => ({
        id: 'order-1',
        orderNumber: 'MX-ABC123',
        totalAmount: dto.items.reduce((s: number, i: any) => s + i.unitPrice * i.quantity, 0) + (dto.deliveryFee || 0),
        ...dto,
      })),
      discard: vi.fn().mockResolvedValue(undefined),
    };

    waba = { sendInteractiveCtaUrl: vi.fn().mockResolvedValue({ messageId: 'wamid-cta' }) };

    service = new FlowService(prisma, {} as any, paystack, orderService, waba);
  });

  it('opens PRODUCT_SELECT on INIT by default', async () => {
    prisma.product.count.mockResolvedValue(10);
    prisma.product.findMany.mockResolvedValue([
      { id: 'p1', name: 'Tomatoes', price: 2.5, image: '🍅' },
      { id: 'p2', name: 'Onions', price: 1.5, image: '🧅' },
    ]);

    const result = await service.handleFlowAction({
      version: '3.0',
      action: 'INIT',
      screen: 'PRODUCT_SELECT',
      flow_token: 'tenant-1:+233240000000:1',
    });

    expect(result.screen).toBe('PRODUCT_SELECT');
    expect(result.data.categories).toHaveLength(5);
    expect(result.data.category_prefill).toBe('all');
    expect(result.data.products).toHaveLength(2);
    expect(result.data.page_prefill).toBe('1');
    expect(result.data.pre_selected).toEqual([]);
    expect(result.data.selection_note).toBe('🛒 Your basket is empty — tap items to add');
  });

  it('rejects requests whose flow token carries no tenant', async () => {
    await expect(service.handleFlowAction({ version: '3.0', action: 'INIT' })).rejects.toThrow('tenant');
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it('handles category filtering, search, and page navigation on PRODUCT_SELECT', async () => {
    prisma.product.count.mockResolvedValue(10);
    prisma.product.findMany.mockResolvedValue([{ id: 'p1', name: 'Tomatoes', price: 2.5, image: '🍅' }]);
    const token = 'tenant-1:session-1';

    const catRes = await exchange(token, 'PRODUCT_SELECT', { step: 'set_category', category: 'vegetables', query: '', selected_on_page: [] });
    expect(catRes.screen).toBe('PRODUCT_SELECT');
    expect(catRes.data.category_prefill).toBe('vegetables');

    const searchRes = await exchange(token, 'PRODUCT_SELECT', { step: 'search', query: 'rice', category: 'all', selected_on_page: [] });
    expect(searchRes.data.search_prefill).toBe('rice');
    const lastWhere = prisma.product.findMany.mock.calls.at(-1)[0].where;
    expect(lastWhere.AND).toEqual([{ name: { contains: 'rice', mode: 'insensitive' } }]);

    const pageRes = await exchange(token, 'PRODUCT_SELECT', { step: 'go_page', page: '2', query: '', category: 'all', selected_on_page: [] });
    expect(pageRes.data.page_prefill).toBe('2');
  });

  it('preserves multi-page selection and validates minimum selection on continue', async () => {
    prisma.product.count.mockResolvedValue(10);
    prisma.product.findMany.mockImplementation(({ where }: any) => {
      if (where?.id?.in) {
        return where.id.in.map((id: string) => ({ id, name: id === 'p1' ? 'Tomatoes' : 'Onions', price: 10, inStock: true }));
      }
      return [
        { id: 'p1', name: 'Tomatoes', price: 10, inStock: true },
        { id: 'p2', name: 'Onions', price: 10, inStock: true },
      ];
    });
    const token = 'tenant-1:session-2';

    const emptyRes = await exchange(token, 'PRODUCT_SELECT', { step: 'continue', selected_on_page: [] });
    expect(emptyRes.screen).toBe('PRODUCT_SELECT');
    expect(emptyRes.data.show_notice).toBe(true);
    expect(emptyRes.data.notice).toContain('Please select at least one item');

    const successRes = await exchange(token, 'PRODUCT_SELECT', { step: 'continue', selected_on_page: ['p1', 'p2'] });
    expect(successRes.screen).toBe('QUANTITIES');
    expect(successRes.data.item_0_id).toBe('p1');
    expect(successRes.data.show_0).toBe(true);
    expect(successRes.data.item_1_id).toBe('p2');
    expect(successRes.data.show_1).toBe(true);
    expect(successRes.data.show_2).toBe(false);
  });

  it('routes from QUANTITIES to SUMMARY with order summary lines and the tenant delivery fee', async () => {
    prisma.product.findMany.mockResolvedValue([
      { id: 'p1', name: 'Tomatoes', price: 2.0, inStock: true },
      { id: 'p2', name: 'Pepper', price: 3.0, inStock: true },
    ]);

    const result = await exchange('tenant-1:session-3', 'QUANTITIES', {
      step: 'quantities',
      i0_id: 'p1',
      i0_qty: '2',
      i1_id: 'p2',
      i1_qty: '1',
    });

    expect(result.screen).toBe('SUMMARY');
    expect(result.data.summary_lines).toContain('Tomatoes');
    expect(result.data.summary_lines).toContain('Pepper');
    // 2x 2.00 + 1x 3.00 = 7.00 + 5.00 delivery = 12.00
    expect(result.data.order_total).toContain('12.00');
    expect(result.data.fulfillment_prefill).toBe('delivery');
    expect(JSON.parse(result.data.cart_json)).toEqual([
      { productId: 'p1', productName: '🍅 Tomatoes', unitPrice: 2, quantity: 2 },
      { productId: 'p2', productName: '🌶️ Pepper', unitPrice: 3, quantity: 1 },
    ]);
  });

  it('validates address on SUMMARY and transitions to PAYMENT when valid', async () => {
    const cart = JSON.stringify([
      { productId: 'p1', productName: 'Tomatoes', unitPrice: 2, quantity: 2 },
      { productId: 'p2', productName: 'Pepper', unitPrice: 3, quantity: 1 },
    ]);
    const token = 'tenant-1:session-to-pay';

    const missingAddrRes = await exchange(token, 'SUMMARY', { step: 'to_payment', cart, fulfillment: 'delivery', address: '' });
    expect(missingAddrRes.screen).toBe('SUMMARY');
    expect(missingAddrRes.data.show_error).toBe(true);
    expect(missingAddrRes.data.error_message).toContain('delivery address');

    const validDeliveryRes = await exchange(token, 'SUMMARY', { step: 'to_payment', cart, fulfillment: 'delivery', address: 'House 4, Cantonments' });
    expect(validDeliveryRes.screen).toBe('PAYMENT');
    expect(validDeliveryRes.data.order_total).toBe('Total: ₵12.00');
    expect(validDeliveryRes.data.pay_label).toBe('Pay ₵12.00');
    expect(validDeliveryRes.data.networks).toHaveLength(3);

    const pickupRes = await exchange(token, 'SUMMARY', { step: 'to_payment', cart, fulfillment: 'pickup' });
    expect(pickupRes.screen).toBe('PAYMENT');
    expect(pickupRes.data.order_total).toBe('Total: ₵7.00');
    expect(pickupRes.data.pay_label).toBe('Pay ₵7.00');
  });

  describe('PAYMENT -> DONE', () => {
    const token = 'tenant-1:+233240000000:999';
    const cart = JSON.stringify([{ productId: 'p1', productName: 'Tomatoes', unitPrice: 2, quantity: 2 }]);

    beforeEach(async () => {
      await exchange(token, 'SUMMARY', { step: 'to_payment', cart, fulfillment: 'pickup' });
    });

    it('validates the mobile money number before placing an order', async () => {
      const res = await exchange(token, 'PAYMENT', { step: 'pay', payment_method: 'momo', momo_number: '' });

      expect(res.screen).toBe('PAYMENT');
      expect(res.data.show_error).toBe(true);
      expect(res.data.error_message).toContain('mobile money number');
      expect(orderService.createOrder).not.toHaveBeenCalled();
    });

    it('creates the order, initiates the MoMo prompt and shows DONE', async () => {
      const res = await exchange(token, 'PAYMENT', { step: 'pay', payment_method: 'momo', momo_network: 'mtn', momo_number: '0241234567' });

      expect(res.screen).toBe('DONE');
      expect(res.data.order_ref).toBe('MX-ABC123');
      expect(res.data.done_message).toContain('Order placed');
      expect(orderService.createOrder).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({
          buyerPhone: '+233240000000',
          status: OrderStatus.AWAITING_PAYMENT,
          paymentMethod: PaymentMethod.MOMO,
          paymentPhone: '0241234567',
          momoNetwork: 'mtn',
          fulfillment: Fulfillment.PICKUP,
          deliveryFee: 0,
          items: [{ productId: 'p1', productName: 'Tomatoes', unitPrice: 2, quantity: 2 }],
        }),
      );
      expect(paystack.initiateMoMoCharge).toHaveBeenCalledWith(
        expect.objectContaining({ momoNumber: '0241234567', provider: 'mtn', email: 'tenant@marketix.app', reference: 'MX-ABC123', amount: 4 }),
      );
    });

    it('discards the order and stays on PAYMENT when the MoMo charge cannot be initiated', async () => {
      paystack.initiateMoMoCharge.mockResolvedValue({ success: false, status: 'failed', reference: 'x', message: 'Invalid number' });

      const res = await exchange(token, 'PAYMENT', { step: 'pay', payment_method: 'momo', momo_network: 'mtn', momo_number: '0241234567' });

      expect(res.screen).toBe('PAYMENT');
      expect(res.data.error_message).toContain('Invalid number');
      expect(orderService.discard).toHaveBeenCalledWith('order-1');
    });

    it('sends a card payment link on WhatsApp for card orders', async () => {
      const res = await exchange(token, 'PAYMENT', { step: 'pay', payment_method: 'card' });

      expect(res.screen).toBe('DONE');
      expect(res.data.done_message).toContain('payment link');
      expect(paystack.initializeCardPayment).toHaveBeenCalledWith(expect.objectContaining({ reference: 'MX-ABC123' }));
      expect(waba.sendInteractiveCtaUrl).toHaveBeenCalledWith(
        expect.objectContaining({ phoneNumberId: 'phone-1', toPhone: '+233240000000', url: 'https://checkout.paystack.com/abc' }),
      );
    });

    it('confirms cash-on-delivery orders without contacting Paystack', async () => {
      const res = await exchange(token, 'PAYMENT', { step: 'pay', payment_method: 'cod' });

      expect(res.screen).toBe('DONE');
      expect(orderService.createOrder).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ status: OrderStatus.CONFIRMED, paymentMethod: PaymentMethod.COD }));
      expect(paystack.initiateMoMoCharge).not.toHaveBeenCalled();
      expect(paystack.initializeCardPayment).not.toHaveBeenCalled();
    });
  });
});
