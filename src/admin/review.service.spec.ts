import { BadRequestException, ConflictException } from '@nestjs/common';
import { NumberStatus, ReviewDecision, TenantStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewService } from './review.service.js';

const ALL_CHECKS = { ghanaCardMatches: true, momoNameMatches: true, calledOwner: true, productsLookGenuine: true };

describe('ReviewService', () => {
  let service: ReviewService;
  let prisma: any;
  let numberPool: any;
  let notifications: any;
  let audit: any;
  let tenant: any;

  beforeEach(() => {
    tenant = { id: 'tenant-1', name: 'Ama Groceries', status: TenantStatus.UNDER_REVIEW, number: null };
    prisma = {
      tenant: {
        findUnique: vi.fn(async () => tenant),
        findUniqueOrThrow: vi.fn(async () => tenant),
        updateMany: vi.fn(async ({ where, data }: any) => {
          if (!where.status.in.includes(tenant.status)) return { count: 0 };
          Object.assign(tenant, data);
          return { count: 1 };
        }),
        update: vi.fn(async ({ data }: any) => Object.assign(tenant, data)),
        count: vi.fn().mockResolvedValue(0),
      },
      whatsappNumber: { update: vi.fn(async ({ where, data }: any) => ({ id: where.id, displayNumber: '0205000000', phoneNumberId: '111', ...data })) },
      vendorReview: { create: vi.fn().mockResolvedValue({}) },
      product: { count: vi.fn(async () => tenant._count?.products ?? 0) },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
    numberPool = { claim: vi.fn().mockResolvedValue({ id: 'n1' }), countFree: vi.fn().mockResolvedValue(2) };
    notifications = {
      vendorLive: vi.fn(),
      vendorMoreInfo: vi.fn(),
      vendorRejected: vi.fn(),
      vendorSuspended: vi.fn(),
    };
    audit = { log: vi.fn() };
    service = new ReviewService(prisma, numberPool, { publicDocument: (d: any) => d } as any, notifications, audit);
  });

  describe('approve', () => {
    it('refuses until every due-diligence check is ticked', async () => {
      const error = await service
        .decide('admin-1', 'tenant-1', { decision: ReviewDecision.APPROVED, checks: { ...ALL_CHECKS, calledOwner: false } })
        .catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toContain('calledOwner');
      expect(numberPool.claim).not.toHaveBeenCalled();
    });

    it('assigns a free number, makes the shop ACTIVE, records the review and tells the vendor', async () => {
      const result = (await service.decide('admin-1', 'tenant-1', { decision: ReviewDecision.APPROVED, checks: ALL_CHECKS })) as any;

      expect(prisma.$queryRaw).toHaveBeenCalled(); // the shop row is locked first
      expect(numberPool.claim).toHaveBeenCalledWith(prisma, undefined);
      expect(prisma.whatsappNumber.update).toHaveBeenCalledWith({
        where: { id: 'n1' },
        data: expect.objectContaining({ status: NumberStatus.ASSIGNED, tenantId: 'tenant-1', displayName: 'Ama Groceries', releasedAt: null }),
      });
      expect(result.tenant).toMatchObject({ status: TenantStatus.ACTIVE, whatsappNumber: '0205000000', whatsappPhoneNumberId: '111' });
      expect(prisma.vendorReview.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ reviewerId: 'admin-1', decision: ReviewDecision.APPROVED, checks: ALL_CHECKS, numberId: 'n1' }),
      });
      expect(notifications.vendorLive).toHaveBeenCalledWith(expect.objectContaining({ id: 'tenant-1' }), '0205000000');
    });

    it('uses the number and display name the reviewer picked', async () => {
      await service.decide('admin-1', 'tenant-1', {
        decision: ReviewDecision.APPROVED, checks: ALL_CHECKS, numberId: 'n7', displayName: 'Ama Kejetia',
      });
      expect(numberPool.claim).toHaveBeenCalledWith(prisma, 'n7');
      expect(prisma.whatsappNumber.update.mock.calls[0][0].data.displayName).toBe('Ama Kejetia');
    });

    it('cannot approve a shop twice or one that is not waiting for review', async () => {
      tenant.status = TenantStatus.ACTIVE;
      await expect(service.decide('admin-1', 'tenant-1', { decision: ReviewDecision.APPROVED, checks: ALL_CHECKS })).rejects.toThrow(
        ConflictException,
      );
      expect(numberPool.claim).not.toHaveBeenCalled();
    });

    it('leaves the shop waiting when the pool is empty', async () => {
      numberPool.claim.mockRejectedValue(new ConflictException('No free WhatsApp numbers left in the pool.'));
      await expect(service.decide('admin-1', 'tenant-1', { decision: ReviewDecision.APPROVED, checks: ALL_CHECKS })).rejects.toThrow(
        'No free WhatsApp numbers',
      );
      expect(tenant.status).toBe(TenantStatus.UNDER_REVIEW);
      expect(notifications.vendorLive).not.toHaveBeenCalled();
    });
  });

  it('needs notes to ask for more info, then tells the vendor what to fix', async () => {
    await expect(service.decide('admin-1', 'tenant-1', { decision: ReviewDecision.MORE_INFO, checks: ALL_CHECKS })).rejects.toThrow(
      'Add notes',
    );

    await service.decide('admin-1', 'tenant-1', { decision: ReviewDecision.MORE_INFO, checks: ALL_CHECKS, notes: 'Ghana Card photo is blurry.' });
    expect(tenant.status).toBe(TenantStatus.MORE_INFO);
    expect(notifications.vendorMoreInfo).toHaveBeenCalledWith(expect.anything(), 'Ghana Card photo is blurry.');
  });

  it('starts a review only from STOCKED', async () => {
    tenant.status = TenantStatus.STOCKED;
    await service.startReview('admin-1', 'tenant-1');
    expect(tenant.status).toBe(TenantStatus.UNDER_REVIEW);

    await expect(service.startReview('admin-1', 'tenant-1')).rejects.toThrow('Cannot start reviewing a shop that is UNDER_REVIEW.');
  });

  it('suspends a shop and keeps its number', async () => {
    tenant.status = TenantStatus.ACTIVE;
    await service.suspend('admin-1', 'tenant-1', 'Selling expired goods');

    expect(tenant.status).toBe(TenantStatus.SUSPENDED);
    expect(prisma.whatsappNumber.update).not.toHaveBeenCalled();
    expect(prisma.vendorReview.create.mock.calls[0][0].data).toMatchObject({ decision: ReviewDecision.SUSPENDED, notes: 'Selling expired goods' });
  });

  it('releases the number of a suspended shop into cooling', async () => {
    tenant.status = TenantStatus.SUSPENDED;
    tenant.number = { id: 'n1', displayNumber: '0205000000' };

    await service.release('admin-1', 'tenant-1');

    expect(prisma.whatsappNumber.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: expect.objectContaining({ status: NumberStatus.COOLING, tenantId: null }),
    });
    expect(tenant).toMatchObject({ whatsappNumber: null, whatsappPhoneNumberId: null });
  });

  it('only releases numbers from suspended shops', async () => {
    tenant.status = TenantStatus.ACTIVE;
    tenant.number = { id: 'n1' };
    await expect(service.release('admin-1', 'tenant-1')).rejects.toThrow('Suspend the shop before releasing');
  });

  it('reinstates to ACTIVE with its number, or back to the queue without one', async () => {
    tenant.status = TenantStatus.SUSPENDED;
    tenant.number = { id: 'n1' };
    tenant._count = { products: 3 };
    await service.reinstate('admin-1', 'tenant-1');
    expect(tenant.status).toBe(TenantStatus.ACTIVE);

    tenant.status = TenantStatus.SUSPENDED;
    tenant.number = null;
    await service.reinstate('admin-1', 'tenant-1');
    expect(tenant.status).toBe(TenantStatus.STOCKED);
  });

  describe('products (every product of a shop)', () => {
    beforeEach(() => {
      prisma.product.findMany = vi.fn().mockResolvedValue([
        { id: 'p1', name: 'Tomatoes', photoUpdatedAt: new Date(1700000000000) },
        { id: 'p2', name: 'Onions', photoUpdatedAt: null },
      ]);
      prisma.product.count = vi.fn(async ({ where }: any) => (where.inStock === true ? 30 : where.inStock === false ? 12 : 42));
    });

    it('pages through them oldest first, with photo URLs and stock counts', async () => {
      const result = await service.products('tenant-1', { page: 2, limit: 20 });
      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: 'tenant-1' }, skip: 20, take: 20, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      );
      expect(result.data.map((p: any) => p.photoUrl)).toEqual(['/api/v1/products/p1/photo?v=1700000000000', null]);
      expect(result.meta).toEqual({ total: 42, page: 2, limit: 20, totalPages: 3 });
      expect(result.counts).toEqual({ all: 42, in: 30, out: 12 });
    });

    it('filters by name and stock, and caps the page size at 50', async () => {
      await service.products('tenant-1', { search: ' tom ', stock: 'out', limit: 500 });
      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'tenant-1', name: { contains: 'tom', mode: 'insensitive' }, inStock: false },
          take: 50,
        }),
      );
    });

    it('404s for an unknown shop', async () => {
      prisma.tenant.findUnique.mockResolvedValueOnce(null);
      await expect(service.products('nope', {})).rejects.toThrow('Shop not found.');
    });
  });

  describe('releaseNumber (from the pool page)', () => {
    beforeEach(() => {
      prisma.whatsappNumber.findUnique = vi.fn().mockResolvedValue({ id: 'n1', tenantId: 'tenant-1' });
      tenant.number = { id: 'n1', displayNumber: '0205000000' };
    });

    it('suspends a live shop first, tells the vendor, and releases the number', async () => {
      tenant.status = TenantStatus.ACTIVE;
      const result = await service.releaseNumber('admin-1', 'n1', 'Selling counterfeit goods');

      expect(result.suspended).toBe(true);
      expect(tenant.status).toBe(TenantStatus.SUSPENDED);
      expect(prisma.whatsappNumber.update.mock.calls[0][0].data).toMatchObject({ status: NumberStatus.COOLING, tenantId: null });
      expect(prisma.vendorReview.create.mock.calls.map((c: any) => c[0].data.decision)).toEqual([ReviewDecision.SUSPENDED, ReviewDecision.RELEASED]);
      expect(notifications.vendorSuspended).toHaveBeenCalledWith(tenant, 'Selling counterfeit goods');
    });

    it('needs a reason to suspend a live shop, but not for an already suspended one', async () => {
      tenant.status = TenantStatus.ACTIVE;
      await expect(service.releaseNumber('admin-1', 'n1')).rejects.toThrow('Give a reason');
      expect(prisma.whatsappNumber.update).not.toHaveBeenCalled();

      tenant.status = TenantStatus.SUSPENDED;
      const result = await service.releaseNumber('admin-1', 'n1');
      expect(result.suspended).toBe(false);
      expect(notifications.vendorSuspended).not.toHaveBeenCalled();
    });

    it('refuses a number that is free or was released meanwhile', async () => {
      prisma.whatsappNumber.findUnique.mockResolvedValueOnce({ id: 'n1', tenantId: null });
      await expect(service.releaseNumber('admin-1', 'n1', 'x')).rejects.toThrow('not assigned to a shop');

      tenant.number = null;
      await expect(service.releaseNumber('admin-1', 'n1', 'x')).rejects.toThrow(ConflictException);
    });
  });

  describe('audit trail', () => {
    it('saves each tick as it is made and logs only the ticks that changed', async () => {
      tenant.reviewChecks = { ghanaCardMatches: true };
      const result = await service.saveChecks('admin-1', 'tenant-1', { ghanaCardMatches: true, momoNameMatches: true });

      expect(result.checks).toEqual({ ghanaCardMatches: true, momoNameMatches: true, calledOwner: false, productsLookGenuine: false });
      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log.mock.calls[0][1]).toMatchObject({
        action: 'CHECKLIST_UPDATED',
        details: 'Ticked \u201cMoMo registered name matches\u201d.',
        metadata: { check: 'momoNameMatches', value: true },
      });
    });

    it('refuses ticks before the review has started', async () => {
      tenant.status = TenantStatus.STOCKED;
      await expect(service.saveChecks('admin-1', 'tenant-1', { calledOwner: true })).rejects.toThrow('Start the review before ticking checks');
    });

    it('approves on ticks saved earlier, clears them, and logs the assigned number', async () => {
      tenant.reviewChecks = ALL_CHECKS;
      await service.decide('admin-1', 'tenant-1', { decision: ReviewDecision.APPROVED });

      expect(prisma.tenant.update.mock.calls.at(-1)[0].data.reviewChecks).toBeDefined();
      const entry = audit.log.mock.calls.at(-1)[1];
      expect(entry).toMatchObject({ actorId: 'admin-1', action: 'APPROVED', tenantId: 'tenant-1', numberId: 'n1', details: 'Assigned +233 20 500 0000.' });
      expect(entry.metadata.checks).toEqual(ALL_CHECKS);
    });

    it('logs a more-info request with the notes the vendor sees', async () => {
      await service.decide('admin-1', 'tenant-1', { decision: ReviewDecision.MORE_INFO, notes: ' Card is blurry. ' });
      expect(audit.log.mock.calls.at(-1)[1]).toMatchObject({ action: 'MORE_INFO_REQUESTED', details: 'Card is blurry.' });
    });

    it('logs review start, and every KYC document view', async () => {
      tenant.status = TenantStatus.STOCKED;
      await service.startReview('admin-1', 'tenant-1');
      expect(audit.log.mock.calls.at(-1)[1]).toMatchObject({ action: 'REVIEW_STARTED', tenantId: 'tenant-1' });

      const onboarding = { openDocument: vi.fn().mockResolvedValue({ document: { type: 'GHANA_CARD_BACK' }, stream: {} }) };
      service = new ReviewService(prisma, numberPool, onboarding as any, notifications, audit);
      await service.openDocument('admin-1', 'tenant-1', 'doc-1');
      expect(audit.log.mock.calls.at(-1)[1]).toMatchObject({
        action: 'DOCUMENT_VIEWED',
        details: 'Opened Ghana Card (back).',
        metadata: { documentId: 'doc-1', type: 'GHANA_CARD_BACK' },
      });
    });
  });
});
