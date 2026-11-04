import { ConflictException } from '@nestjs/common';
import { NumberStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COOLING_MS, NumberPoolService } from './number-pool.service.js';

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

describe('NumberPoolService', () => {
  let service: NumberPoolService;
  let prisma: any;
  let waba: any;
  let audit: any;

  beforeEach(() => {
    prisma = {
      whatsappNumber: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(null),
        findUniqueOrThrow: vi.fn(async ({ where }: any) => ({ id: where.id })),
        create: vi.fn(async ({ data }: any) => ({ id: 'n-new', ...data })),
        update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
        count: vi.fn().mockResolvedValue(0),
      },
      $queryRaw: vi.fn(),
    };
    prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
    waba = { getPhoneNumberDetails: vi.fn(), ensureFlowEncryptionKey: vi.fn().mockResolvedValue('UPLOADED') };
    audit = { log: vi.fn() };
    service = new NumberPoolService(prisma, waba, audit);
  });

  it('treats a cooling number as free once 7 days have passed, with no job', () => {
    expect(service.effectiveStatus({ status: NumberStatus.COOLING, releasedAt: ago(6 * DAY) })).toBe(NumberStatus.COOLING);
    expect(service.effectiveStatus({ status: NumberStatus.COOLING, releasedAt: ago(COOLING_MS + 1000) })).toBe(NumberStatus.FREE);
    expect(service.effectiveStatus({ status: NumberStatus.ASSIGNED, releasedAt: null })).toBe(NumberStatus.ASSIGNED);
  });

  it('lists numbers by effective status and flags quality issues', async () => {
    prisma.whatsappNumber.findMany.mockResolvedValue([
      { id: 'a', status: NumberStatus.FREE, releasedAt: null, qualityRating: 'GREEN' },
      { id: 'b', status: NumberStatus.COOLING, releasedAt: ago(8 * DAY), qualityRating: null },
      { id: 'c', status: NumberStatus.COOLING, releasedAt: ago(1 * DAY), qualityRating: 'YELLOW' },
      { id: 'd', status: NumberStatus.ASSIGNED, releasedAt: null, qualityRating: 'RED' },
    ]);

    expect((await service.list({ statuses: [NumberStatus.FREE] })).map((n) => n.id)).toEqual(['a', 'b']);
    expect((await service.list({ statuses: [NumberStatus.COOLING] })).map((n) => n.id)).toEqual(['c']);
    expect((await service.list({ qualityIssues: true })).map((n) => n.id)).toEqual(['c', 'd']);
  });

  it('adds a number under META_WABA_ID by default and refuses duplicates', async () => {
    const previous = process.env.META_WABA_ID;
    process.env.META_WABA_ID = 'waba-1';
    waba.getPhoneNumberDetails.mockResolvedValue({ displayPhoneNumber: '+233 20 500 0000', verifiedName: 'MarketiX', qualityRating: 'GREEN', messagingLimit: 'TIER_1K' });
    try {
      const added = await service.add('admin-1', { phoneNumberId: '111222333', displayNumber: '0205000000' });
      expect(added).toMatchObject({ phoneNumberId: '111222333', wabaId: 'waba-1', displayName: 'MarketiX', qualityRating: 'GREEN', messagingLimit: 'TIER_1K' });
      expect(audit.log.mock.calls[0][1]).toMatchObject({
        action: 'NUMBER_ADDED',
        numberId: 'n-new',
        details: 'Registered under WABA waba-1 (quality green, 1K / day).',
      });
    } finally {
      process.env.META_WABA_ID = previous;
    }

    prisma.whatsappNumber.findFirst.mockResolvedValue({ displayNumber: '0205000000' });
    await expect(service.add('admin-1', { phoneNumberId: '111222333', displayNumber: '0205000000' })).rejects.toThrow(ConflictException);
  });

  it('refuses a number Meta does not know, or whose number does not match', async () => {
    const dto = { phoneNumberId: '111222333', displayNumber: '0205000000', wabaId: 'waba-1' };
    waba.getPhoneNumberDetails.mockRejectedValueOnce(new Error('Meta WABA Error: Unsupported get request.'));
    await expect(service.add('admin-1', dto)).rejects.toThrow('Meta could not find phone number id 111222333');

    waba.getPhoneNumberDetails.mockResolvedValueOnce({ displayPhoneNumber: '+233 20 599 9999' });
    await expect(service.add('admin-1', dto)).rejects.toThrow('as +233 20 599 9999, not 0205000000');
    expect(prisma.whatsappNumber.create).not.toHaveBeenCalled();
  });

  it('sets up the Flow key before adding, and refuses the number if Meta rejects it', async () => {
    const dto = { phoneNumberId: '111222333', displayNumber: '0205000000', wabaId: 'waba-1' };
    waba.getPhoneNumberDetails.mockResolvedValue({ displayPhoneNumber: '+233 20 500 0000' });

    await service.add('admin-1', dto);
    expect(waba.ensureFlowEncryptionKey).toHaveBeenCalledWith('111222333');
    expect(audit.log.mock.calls[0][1].metadata).toMatchObject({ flowKey: 'UPLOADED' });

    prisma.whatsappNumber.create.mockClear();
    waba.ensureFlowEncryptionKey.mockRejectedValueOnce(new Error('status MISMATCH'));
    await expect(service.add('admin-1', dto)).rejects.toThrow('Could not set up the Flow encryption key on 0205000000. status MISMATCH');
    expect(prisma.whatsappNumber.create).not.toHaveBeenCalled();
  });

  it('counts the pool by effective status for the tiles', async () => {
    prisma.whatsappNumber.findMany.mockResolvedValue([
      { id: 'a', status: NumberStatus.FREE, releasedAt: null, qualityRating: null },
      { id: 'b', status: NumberStatus.COOLING, releasedAt: ago(8 * DAY), qualityRating: null },
      { id: 'c', status: NumberStatus.COOLING, releasedAt: ago(1 * DAY), qualityRating: null },
      { id: 'd', status: NumberStatus.ASSIGNED, releasedAt: null, qualityRating: 'YELLOW' },
    ]);
    await expect(service.summary()).resolves.toEqual({ total: 4, free: 2, assigned: 1, cooling: 1, qualityIssues: 1 });
  });

  it('refreshes every number, reports the ones Meta failed on, and logs one entry for the run', async () => {
    prisma.whatsappNumber.findMany.mockResolvedValue([
      { id: 'n1', phoneNumberId: '111', displayNumber: '0205000001' },
      { id: 'n2', phoneNumberId: '222', displayNumber: '0205000002' },
    ]);
    waba.getPhoneNumberDetails.mockRejectedValueOnce(new Error('rate limited')).mockResolvedValueOnce({ qualityRating: 'GREEN' });

    await expect(service.refreshAll('admin-1')).resolves.toEqual({
      total: 2,
      refreshed: 1,
      failed: [{ id: 'n1', displayNumber: '0205000001', error: 'rate limited' }],
    });
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log.mock.calls[0][1]).toMatchObject({
      actorId: 'admin-1',
      action: 'NUMBER_REFRESHED',
      details: 'Refreshed 1 of 2 numbers from Meta. Failed: +233 20 500 0001.',
    });
  });

  it('frees a cooling number early, but nothing else', async () => {
    prisma.whatsappNumber.findUnique.mockResolvedValue({ id: 'n1', status: NumberStatus.COOLING, releasedAt: ago(DAY) });
    await service.free('admin-1', 'n1');
    expect(prisma.whatsappNumber.update).toHaveBeenCalledWith({ where: { id: 'n1' }, data: { status: NumberStatus.FREE } });
    expect(audit.log.mock.calls[0][1]).toMatchObject({ actorId: 'admin-1', action: 'NUMBER_FREED', numberId: 'n1' });

    prisma.whatsappNumber.findUnique.mockResolvedValue({ id: 'n2', status: NumberStatus.ASSIGNED, releasedAt: null });
    await expect(service.free('admin-1', 'n2')).rejects.toThrow('Only a cooling number');
  });

  it('stores the quality rating and tier Meta reports', async () => {
    prisma.whatsappNumber.findUnique.mockResolvedValue({ id: 'n1', phoneNumberId: '111' });
    waba.getPhoneNumberDetails.mockResolvedValue({ qualityRating: 'GREEN', messagingLimit: 'TIER_1K' });

    await service.refresh('admin-1', 'n1');

    expect(waba.getPhoneNumberDetails).toHaveBeenCalledWith('111');
    expect(prisma.whatsappNumber.update.mock.calls[0][0].data).toMatchObject({ qualityRating: 'GREEN', messagingLimit: 'TIER_1K' });
    expect(audit.log.mock.calls[0][1]).toMatchObject({ action: 'NUMBER_REFRESHED', details: 'Refreshed from Meta: quality green, 1K / day.' });
  });

  it('claims a locked free number, and says so when the pool is empty or the pick is taken', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'n1' }]);
    await expect(service.claim(prisma)).resolves.toEqual({ id: 'n1' });

    prisma.$queryRaw.mockResolvedValueOnce([]);
    await expect(service.claim(prisma)).rejects.toThrow('No free WhatsApp numbers left');

    prisma.$queryRaw.mockResolvedValueOnce([]);
    await expect(service.claim(prisma, 'n9')).rejects.toThrow('not free any more');
  });

  it('checks the Flow key on the claimed number and blocks the approval if it cannot be set up', async () => {
    prisma.whatsappNumber.findUniqueOrThrow.mockResolvedValue({ id: 'n1', phoneNumberId: '555', displayNumber: '0550413188' });
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'n1' }]);
    await service.claim(prisma);
    expect(waba.ensureFlowEncryptionKey).toHaveBeenCalledWith('555');

    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'n1' }]);
    waba.ensureFlowEncryptionKey.mockRejectedValueOnce(new Error('status MISMATCH'));
    await expect(service.claim(prisma)).rejects.toThrow('not ready for the ordering Flow, so the shop was not approved');
  });
});
