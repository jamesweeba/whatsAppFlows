import { DocumentType, TenantStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { kycCompleteness, OnboardingService } from './onboarding.service.js';

describe('OnboardingService', () => {
  let service: OnboardingService;
  let prisma: any;
  let storage: any;
  let tenant: any;

  const file = (overrides: Partial<Express.Multer.File> = {}) =>
    ({ originalname: 'card.JPG', mimetype: 'image/jpeg', size: 1000, buffer: Buffer.from('x'), ...overrides }) as Express.Multer.File;

  beforeEach(() => {
    tenant = {
      id: 'tenant-1', name: 'Ama Groceries', market: 'Kejetia', status: TenantStatus.PENDING,
      ownerFullName: 'Ama Mensah', ownerPhone: '0244111222', momoNumber: null, momoName: null,
    };
    prisma = {
      tenant: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn(async ({ data }: any) => ({ ...tenant, ...data })) },
      product: { count: vi.fn().mockResolvedValue(1) },
      vendorDocument: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn(),
        upsert: vi.fn(async ({ create }: any) => ({ id: 'doc-1', uploadedAt: new Date(), ...create })),
      },
      vendorReview: { findFirst: vi.fn().mockResolvedValue(null) },
      whatsappNumber: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    storage = { save: vi.fn(), remove: vi.fn(), read: vi.fn().mockResolvedValue('stream') };
    const tenantService = {
      findByUser: vi.fn(async () => tenant),
      assertEditable: vi.fn(),
      assertKycEditable: vi.fn((t: any) => {
        if (t.status === TenantStatus.ACTIVE) throw new Error('KYC documents cannot be changed while your shop is live.');
      }),
    } as any;
    service = new OnboardingService(prisma, tenantService, storage);
  });

  it('moves PENDING to STOCKED only when the shop has an in-stock product', async () => {
    await service.markStockedIfReady('tenant-1');
    expect(prisma.tenant.updateMany).toHaveBeenCalledWith({
      where: { id: 'tenant-1', status: TenantStatus.PENDING, products: { some: { inStock: true } } },
      data: { status: TenantStatus.STOCKED, submittedAt: expect.any(Date) },
    });
  });

  it('lists what is left to do', async () => {
    prisma.vendorDocument.findMany.mockResolvedValue([{ type: DocumentType.GHANA_CARD_FRONT }]);
    const status = await service.status('user-1');

    const done = Object.fromEntries(status.steps.map((s) => [s.key, s.done]));
    expect(done).toEqual({
      shop: true, ownerDetails: true, momoPayout: false, ghanaCardFront: true, ghanaCardBack: false,
      stallPhoto: false, products: true, approved: false,
    });
    expect(status.canResubmit).toBe(false);
  });

  it('computes KYC completeness for the review queue', () => {
    expect(kycCompleteness(tenant, [{ type: DocumentType.GHANA_CARD_FRONT }])).toBeCloseTo(2 / 5);
  });

  it('resubmits after "more info" back into the queue', async () => {
    tenant.status = TenantStatus.MORE_INFO;
    const updated = await service.resubmit('user-1');
    expect(updated.status).toBe(TenantStatus.STOCKED);

    tenant.status = TenantStatus.STOCKED;
    await expect(service.resubmit('user-1')).rejects.toThrow('already waiting for review');
  });

  it('stores a KYC document privately and replaces the previous one of that type', async () => {
    prisma.vendorDocument.findUnique.mockResolvedValue({ storageKey: 'kyc/tenant-1/old.jpg' });

    const document = await service.uploadDocument('user-1', DocumentType.GHANA_CARD_FRONT, file());

    const key = storage.save.mock.calls[0][0];
    expect(key).toMatch(/^kyc\/tenant-1\/[0-9a-f-]{36}\.jpg$/);
    expect(storage.remove).toHaveBeenCalledWith('kyc/tenant-1/old.jpg');
    expect(document).not.toHaveProperty('storageKey');
    expect(document).toMatchObject({ type: DocumentType.GHANA_CARD_FRONT, fileName: 'card.JPG' });
  });

  it('does not let a live shop replace its KYC documents', async () => {
    tenant.status = TenantStatus.ACTIVE;
    await expect(service.uploadDocument('user-1', DocumentType.GHANA_CARD_FRONT, file())).rejects.toThrow('cannot be changed');
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('accepts only images and PDFs up to 5 MB', async () => {
    await expect(service.uploadDocument('user-1', DocumentType.STALL_PHOTO, file({ mimetype: 'text/html' }))).rejects.toThrow('JPEG, PNG');
    await expect(service.uploadDocument('user-1', DocumentType.STALL_PHOTO, file({ size: 6 * 1024 * 1024 }))).rejects.toThrow('5 MB');
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('never opens a document that belongs to another shop', async () => {
    prisma.vendorDocument.findFirst.mockResolvedValue(null);
    await expect(service.openDocument('tenant-1', 'doc-of-another-shop')).rejects.toThrow('Document not found');
    expect(prisma.vendorDocument.findFirst).toHaveBeenCalledWith({ where: { id: 'doc-of-another-shop', tenantId: 'tenant-1' } });
  });
});
