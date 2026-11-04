import { BadRequestException } from '@nestjs/common';
import { TenantStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatVendorRef, parseVendorRef } from '../tenant/vendor-ref.js';
import { parseChoice } from '../common/query.util.js';
import { MAX_PAGE_SIZE, VENDOR_SORTS, VENDOR_TABS, VendorDirectoryService } from './vendor-directory.service.js';

const parseVendorTab = (raw?: string) => parseChoice(raw, Object.keys(VENDOR_TABS), 'tab');
const parseVendorSort = (raw?: string) => parseChoice(raw, VENDOR_SORTS, 'sort');

describe('vendor ref', () => {
  it('formats and parses MX-V refs', () => {
    expect(formatVendorRef(113)).toBe('MX-V-0113');
    expect(formatVendorRef(12345)).toBe('MX-V-12345');
    expect(parseVendorRef('MX-V-0113')).toBe(113);
    expect(parseVendorRef(' mxv113 ')).toBe(113);
    expect(parseVendorRef('0113')).toBe(113);
    expect(parseVendorRef('Ama')).toBeNull();
  });
});

describe('vendor tabs and sorts', () => {
  it('every shop state is in exactly one tab besides "all"', () => {
    const { all, ...tabs } = VENDOR_TABS;
    expect(Object.values(tabs).flat().sort()).toEqual([...all].sort());
  });

  it('rejects unknown tabs and sorts, including inherited object keys', () => {
    expect(parseVendorTab('Pending_Review')).toBe('pending_review');
    expect(parseVendorTab(undefined)).toBeUndefined();
    expect(() => parseVendorTab('constructor')).toThrow(BadRequestException);
    expect(parseVendorSort('orders')).toBe('orders');
    expect(() => parseVendorSort('name')).toThrow('Use: newest, orders');
  });
});

describe('VendorDirectoryService.list', () => {
  let prisma: any;
  let service: VendorDirectoryService;

  beforeEach(() => {
    prisma = { $queryRaw: vi.fn() };
    service = new VendorDirectoryService(prisma);
  });

  it('adds the ref, totals the tabs from the status counts and pages the active tab', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 't1', refNumber: 7, name: 'Ama Groceries', status: TenantStatus.ACTIVE, orders30d: 3 }])
      .mockResolvedValueOnce([
        { status: TenantStatus.ACTIVE, count: 11 },
        { status: TenantStatus.STOCKED, count: 4 },
        { status: TenantStatus.UNDER_REVIEW, count: 2 },
        { status: TenantStatus.PENDING, count: 3 },
      ]);

    const result = await service.list({ tab: 'active', page: 2, limit: 500 });

    expect(result.data).toEqual([{ id: 't1', ref: 'MX-V-0007', name: 'Ama Groceries', status: 'ACTIVE', orders30d: 3 }]);
    expect(result.counts).toMatchObject({ all: 20, active: 11, pending_review: 6, not_submitted: 3, rejected: 0 });
    expect(result.meta).toEqual({ total: 11, page: 2, limit: MAX_PAGE_SIZE, totalPages: 1 });
  });
});
