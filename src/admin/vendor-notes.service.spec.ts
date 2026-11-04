import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VendorNotesService } from './vendor-notes.service.js';

const note = (overrides: Record<string, unknown> = {}) => ({
  id: 'n1',
  body: 'Called her, sending Ghana Card tomorrow.',
  createdAt: new Date('2026-11-04T10:00:00Z'),
  editedAt: null,
  author: { id: 'admin1', firstName: 'Steph', lastName: 'Dua' },
  ...overrides,
});

describe('VendorNotesService', () => {
  let prisma: any;
  let audit: any;
  let service: VendorNotesService;

  beforeEach(() => {
    prisma = {
      tenant: { findUnique: vi.fn().mockResolvedValue({ id: 't1' }) },
      vendorNote: {
        findMany: vi.fn().mockResolvedValue([note()]),
        findFirst: vi.fn().mockResolvedValue(note()),
        create: vi.fn(async ({ data }: any) => note({ body: data.body })),
        update: vi.fn(async ({ data }: any) => note({ body: data.body, editedAt: data.editedAt })),
        delete: vi.fn(),
      },
      $transaction: vi.fn((fn: any) => fn(prisma)),
    };
    audit = { log: vi.fn() };
    service = new VendorNotesService(prisma, audit);
  });

  it('lists notes with the author name and whether they are mine', async () => {
    expect(await service.list('admin1', 't1')).toEqual([expect.objectContaining({ author: { id: 'admin1', name: 'Steph Dua' }, mine: true })]);
    expect((await service.list('admin2', 't1'))[0].mine).toBe(false);
  });

  it('404s for an unknown shop', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    await expect(service.list('admin1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.add('admin1', 'nope', 'Hi')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('adds a note and logs it', async () => {
    const created = await service.add('admin1', 't1', 'Promised MoMo details by Friday.');
    expect(created).toMatchObject({ body: 'Promised MoMo details by Friday.', mine: true });
    expect(audit.log).toHaveBeenCalledWith(prisma, expect.objectContaining({ action: AuditAction.NOTE_ADDED, tenantId: 't1', details: 'Promised MoMo details by Friday.' }));
  });

  it('edits only your own note and keeps the old text in the audit log', async () => {
    const updated = await service.update('admin1', 't1', 'n1', 'New text');
    expect(updated.editedAt).toBeInstanceOf(Date);
    expect(audit.log).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ action: AuditAction.NOTE_EDITED, metadata: { noteId: 'n1', previous: 'Called her, sending Ghana Card tomorrow.' } }),
    );
    await expect(service.update('admin2', 't1', 'n1', 'Hijack')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('skips the write when an edit changes nothing', async () => {
    await service.update('admin1', 't1', 'n1', 'Called her, sending Ghana Card tomorrow.');
    expect(prisma.vendorNote.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('deletes only your own note and logs the deleted text', async () => {
    await service.remove('admin1', 't1', 'n1');
    expect(prisma.vendorNote.delete).toHaveBeenCalledWith({ where: { id: 'n1' } });
    expect(audit.log).toHaveBeenCalledWith(prisma, expect.objectContaining({ action: AuditAction.NOTE_DELETED, details: 'Called her, sending Ghana Card tomorrow.' }));
    await expect(service.remove('admin2', 't1', 'n1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('404s for a note on another shop or already deleted', async () => {
    prisma.vendorNote.findFirst.mockResolvedValue(null);
    await expect(service.remove('admin1', 't1', 'gone')).rejects.toBeInstanceOf(NotFoundException);
  });
});
