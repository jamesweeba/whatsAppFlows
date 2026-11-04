import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CategoryService } from './category.service.js';

const CATEGORIES = [
  { id: 'veg_fruits', title: 'Vegetables & fruits' },
  { id: 'drinks', title: 'Drinks & water' },
];

describe('CategoryService', () => {
  let service: CategoryService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      category: {
        findMany: vi.fn().mockResolvedValue(CATEGORIES),
        findUnique: vi.fn(async ({ where }: any) => CATEGORIES.find((c) => c.id === where.id) ?? null),
      },
    };
    service = new CategoryService(prisma, { findByUser: vi.fn().mockResolvedValue({ id: 'tenant-1' }) } as any);
  });

  it('matches an id or a title, in any case and with spaces around it', () => {
    expect(service.match(CATEGORIES, 'veg_fruits')).toBe('veg_fruits');
    expect(service.match(CATEGORIES, '  drinks & WATER ')).toBe('drinks');
    expect(service.match(CATEGORIES, 'electronics')).toBeNull();
    expect(service.match(CATEGORIES, '')).toBeNull();
  });

  it('lists the categories a shop has in-stock products in, in display order', async () => {
    await service.listInStock('tenant-1');
    expect(prisma.category.findMany).toHaveBeenCalledWith({
      where: { products: { some: { tenantId: 'tenant-1', inStock: true } } },
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    });
  });

  it('returns a title, or null for an unknown id', async () => {
    expect(await service.titleOf('drinks')).toBe('Drinks & water');
    expect(await service.titleOf('nope')).toBeNull();
  });

  it('rejects an unknown category and lists the valid ids', async () => {
    await expect(service.assertExists('phones')).rejects.toThrow('Unknown category "phones". Choose one of: veg_fruits, drinks.');
  });
});
