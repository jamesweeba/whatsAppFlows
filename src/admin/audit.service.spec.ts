import { AuditAction } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTION_LABELS, AuditService } from './audit.service.js';

describe('AuditService', () => {
  let prisma: any;
  let service: AuditService;

  beforeEach(() => {
    prisma = {
      user: { findUnique: vi.fn().mockResolvedValue({ firstName: 'Steph', lastName: 'Dua' }), findMany: vi.fn() },
      tenant: { findUnique: vi.fn().mockResolvedValue({ name: 'Ama Groceries' }) },
      whatsappNumber: { findUnique: vi.fn().mockResolvedValue({ displayNumber: '0592001128' }) },
      auditLog: { create: vi.fn(async ({ data }: any) => data) },
      $queryRaw: vi.fn(),
    };
    service = new AuditService(prisma);
  });

  it('has a label for every action', () => {
    expect(Object.keys(AUDIT_ACTION_LABELS).sort()).toEqual(Object.values(AuditAction).sort());
  });

  it('copies the admin, shop and number names into the entry', async () => {
    const entry = await service.log(prisma, { actorId: 'u1', action: AuditAction.APPROVED, tenantId: 't1', numberId: 'n1', details: ' Assigned. ' });
    expect(entry).toMatchObject({ actorName: 'Steph Dua', tenantName: 'Ama Groceries', displayNumber: '0592001128', details: 'Assigned.' });
  });

  it('exports CSV with quoting, a BOM for Excel, and formulas neutralised', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        createdAt: new Date('2026-11-03T06:53:00.000Z'),
        actorName: 'Steph Dua',
        action: AuditAction.SUSPENDED,
        tenantName: 'Kwame "Meat" Shop',
        refNumber: 118,
        displayNumber: '+233 59 200 1118',
        details: '=HYPERLINK("http://evil")',
      },
    ]);
    const csv = (await service.exportCsv({ range: {} })).toString('utf8');
    const [header, row] = csv.slice(1).trim().split('\r\n');

    expect(csv.startsWith('﻿')).toBe(true);
    expect(header).toBe('"When (UTC)","Admin","Action","Shop","Shop ref","Number","Details"');
    expect(row).toBe(
      '"2026-11-03T06:53:00.000Z","Steph Dua","Suspended","Kwame ""Meat"" Shop","MX-V-0118","+233 59 200 1118","\'=HYPERLINK(""http://evil"")"',
    );
  });
});
