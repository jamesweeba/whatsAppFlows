import type { Tenant } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { NotificationService, type RiderOrder } from './notification.service.js';

describe('NotificationService order alert', () => {
  const tenant = { name: 'Ama Groceries', ownerFullName: 'Ama  Serwaa Mensah', ownerPhone: '0241234567', whatsappPhoneNumberId: 'shop-number' } as Tenant;
  const make = (sendTemplate = vi.fn().mockResolvedValue({ messageId: 'wamid-1' })) => ({ sendTemplate, service: new NotificationService({ sendTemplate } as any) });

  it('sends the approved "order" template from the shop number, with owner, order, customer and total', async () => {
    const { sendTemplate, service } = make();
    await expect(service.orderAlert(tenant, { orderNumber: 'MX-7K2QXD', totalAmount: 1500, customerName: 'Kofi Mensah' })).resolves.toBe(true);
    expect(sendTemplate).toHaveBeenCalledWith('shop-number', '233241234567', { name: 'order', language: 'en_US' }, ['Ama', 'MX-7K2QXD', 'Kofi Mensah', '1,500.00']);
  });

  it('fills every blank even without a buyer or owner name', async () => {
    const { sendTemplate, service } = make();
    await service.orderAlert({ ...tenant, ownerFullName: null }, { orderNumber: 'MX-1', totalAmount: 12.5, customerName: '  ' });
    expect(sendTemplate.mock.calls[0][3]).toEqual(['Ama Groceries', 'MX-1', 'a WhatsApp buyer', '12.50']);
  });

  it('never throws when WhatsApp refuses, or when the shop has no number', async () => {
    const { service } = make(vi.fn().mockRejectedValue(new Error('Meta WABA Error: template not found')));
    await expect(service.orderAlert(tenant, { orderNumber: 'MX-1', totalAmount: 10 })).resolves.toBe(false);
    await expect(make().service.orderAlert({ ...tenant, whatsappPhoneNumberId: null }, { orderNumber: 'MX-1', totalAmount: 10 })).resolves.toBe(false);
  });
});

describe('NotificationService rider delivery', () => {
  const tenant = { name: 'Ama Groceries', ownerPhone: '+233241234567', whatsappPhoneNumberId: 'shop-number' } as Tenant;
  const order = {
    orderNumber: 'MX-7K2QXD',
    riderName: 'Kofi  Boateng',
    riderPhone: '0201112222',
    customerName: 'Esi Mensah',
    contactPhone: '+233559998888',
    buyerPhone: '+233240000000',
    deliveryArea: 'East Legon',
    landmark: 'near Shell',
    deliveryAddress: 'East Legon — near Shell',
    deliverySlot: 'Today, 2–4 pm',
    locationLatitude: 5.6037,
    locationLongitude: -0.187,
    paymentMethod: 'COD',
    paystackPaidAt: null,
    totalAmount: 120,
    items: [
      { quantity: 2, productName: 'Kenkey (olonka)' },
      { quantity: 1, productName: 'Fish' },
    ],
  } as RiderOrder;
  const make = () => {
    const sendTemplate = vi.fn().mockResolvedValue({ messageId: 'wamid-1' });
    return { sendTemplate, service: new NotificationService({ sendTemplate } as any) };
  };

  it('sends the rider the delivery template from the shop number, with a map button on the buyer’s pin', async () => {
    const { sendTemplate, service } = make();
    await expect(service.riderDelivery(tenant, order)).resolves.toBe(true);
    expect(sendTemplate).toHaveBeenCalledWith(
      'shop-number',
      '233201112222',
      { name: 'rider_delivery', language: 'en_US' },
      ['Kofi', 'Ama Groceries', 'MX-7K2QXD', 'Esi Mensah', '0559998888', 'East Legon, near Shell', 'Today, 2–4 pm', 'GH₵120.00 in cash', '2 × Kenkey (olonka), 1 × Fish', '0241234567'],
      { urlButton: '5.6037%2C-0.187' },
    );
  });

  it('searches the buyer’s area on the map until they share a pin, and says what to collect', async () => {
    const { sendTemplate, service } = make();
    await service.riderDelivery(tenant, { ...order, locationLatitude: null, locationLongitude: null, paymentMethod: 'MOMO', paystackPaidAt: new Date() });
    expect(sendTemplate.mock.calls[0][3][7]).toBe('Nothing, already paid');
    expect(sendTemplate.mock.calls[0][4]).toEqual({ urlButton: 'East%20Legon%2C%20near%20Shell' });
  });

  it('fills every blank for a sparse order, and leaves out a hidden buyer number', async () => {
    const { sendTemplate, service } = make();
    await service.riderDelivery(tenant, {
      ...order,
      riderName: null,
      customerName: null,
      contactPhone: null,
      buyerPhone: 'GH.989894404158856',
      deliveryArea: null,
      landmark: null,
      deliveryAddress: null,
      deliverySlot: null,
      locationLatitude: null,
      locationLongitude: null,
      paymentMethod: 'MOMO',
      items: [],
    });
    const [, , , params, button] = sendTemplate.mock.calls[0];
    expect(params).toEqual(['there', 'Ama Groceries', 'MX-7K2QXD', 'the buyer', 'not shared', 'see the map', 'As soon as possible', 'GH₵120.00 (not paid yet, check with the shop)', 'see the shop', '0241234567']);
    expect(button).toEqual({ urlButton: 'Ama%20Groceries%2C%20Ghana' });
  });
});
