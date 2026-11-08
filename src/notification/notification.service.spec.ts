import type { Tenant } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { NotificationService } from './notification.service.js';

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
