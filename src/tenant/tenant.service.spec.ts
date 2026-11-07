import { ForbiddenException } from '@nestjs/common';
import { TenantStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantService } from './tenant.service.js';

describe('TenantService KYC lock', () => {
  let service: TenantService;
  let prisma: any;
  let tenant: any;

  beforeEach(() => {
    tenant = {
      id: 'tenant-1', userId: 'user-1', status: TenantStatus.ACTIVE, whatsappNumber: '0205000000',
      ownerFullName: 'Ama Mensah', momoNumber: '0244111222', momoName: 'Ama Mensah',
    };
    prisma = {
      tenant: { findUnique: vi.fn(async () => tenant), update: vi.fn(async ({ data }: any) => ({ ...tenant, ...data })) },
      vendorReview: { count: vi.fn(async () => 0) },
    };
    service = new TenantService(prisma, { vendorWelcome: vi.fn() } as any);
  });

  it.each([TenantStatus.ACTIVE, TenantStatus.UNDER_REVIEW])('blocks payout and owner changes while %s', async (status) => {
    tenant.status = status;
    const error = await service.update('user-1', { momoNumber: '0599000000', momoName: 'Kofi' }).catch((e) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.message).toContain('momoNumber, momoName');
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('still lets a live shop resend the same values and change other settings', async () => {
    await service.update('user-1', { momoNumber: '0244111222', deliveryFee: 8, ownerPhone: '0200000000' });
    expect(prisma.tenant.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ deliveryFee: 8 }) }));
  });

  it('allows KYC changes before review and after a request for more info', async () => {
    for (const status of [TenantStatus.PENDING, TenantStatus.STOCKED, TenantStatus.MORE_INFO, TenantStatus.REJECTED]) {
      tenant.status = status;
      await expect(service.update('user-1', { momoName: 'Ama K. Mensah' })).resolves.toBeDefined();
    }
  });

  it('keeps payout details locked for a shop that was approved before, even back in the queue', async () => {
    // Reinstated after its number was released: STOCKED again, but its balance is still there.
    tenant.status = TenantStatus.STOCKED;
    prisma.vendorReview.count.mockResolvedValue(1);
    await expect(service.update('user-1', { momoNumber: '0241234567' })).rejects.toThrow('once your shop has been approved');
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });
});
