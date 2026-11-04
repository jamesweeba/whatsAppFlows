import { ForbiddenException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CategoryService } from '../category/category.service.js';
import { MAX_UPLOAD_ROWS, ProductService, TEMPLATE_HEADERS } from './product.service.js';

function sheet(rows: Record<string, unknown>[]): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Products');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

describe('ProductService', () => {
  let service: ProductService;
  let prisma: any;
  let tenantService: any;
  let onboarding: any;

  beforeEach(() => {
    prisma = {
      tenant: { findUnique: vi.fn().mockResolvedValue({ id: 'tenant-1', userId: 'user-1' }) },
      category: {
        findUnique: vi.fn(async ({ where }: any) => (['veg_fruits', 'drinks'].includes(where.id) ? { id: where.id } : null)),
        findMany: vi.fn().mockResolvedValue([
          { id: 'veg_fruits', title: 'Vegetables & fruits', description: 'Tomatoes, onions' },
          { id: 'drinks', title: 'Drinks & water', description: null },
        ]),
      },
      product: { create: vi.fn(async ({ data }: any) => ({ id: 'p1', ...data })) },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    tenantService = {
      findByUser: vi.fn().mockResolvedValue({ id: 'tenant-1', status: 'PENDING' }),
      assertEditable: vi.fn((tenant: any) => {
        if (tenant.status === 'SUSPENDED') throw new ForbiddenException('suspended');
      }),
    };
    onboarding = { markStockedIfReady: vi.fn().mockResolvedValue(true) };
    service = new ProductService(prisma, tenantService, new CategoryService(prisma, tenantService), onboarding, { removeFile: vi.fn() } as any);
  });

  it('creates a product in a predefined category and moves the shop to STOCKED', async () => {
    await service.create('user-1', { name: 'Tomatoes', price: 10, categoryId: 'veg_fruits' });
    expect(prisma.product.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ categoryId: 'veg_fruits', tenantId: 'tenant-1' }) }),
    );
    expect(onboarding.markStockedIfReady).toHaveBeenCalledWith('tenant-1');
  });

  it('rejects an unknown category and lists the valid ones', async () => {
    await expect(service.create('user-1', { name: 'Tomatoes', price: 10, categoryId: 'phones' })).rejects.toThrow(
      'Unknown category "phones". Choose one of: veg_fruits, drinks.',
    );
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  it('makes a suspended shop read-only', async () => {
    tenantService.findByUser.mockResolvedValue({ id: 'tenant-1', status: 'SUSPENDED' });
    await expect(service.create('user-1', { name: 'Tomatoes', price: 10, categoryId: 'veg_fruits' })).rejects.toThrow(ForbiddenException);
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  describe('bulkCreateFromExcel', () => {
    it('reads the template columns: category per row, measures, and price from the cheapest measure', async () => {
      const file = sheet([
        { product_name: 'Tomatoes', category: 'veg_fruits', measure_1: 'Olonka', price_1: 25, measure_2: 'Table top', price_2: 10, note: 'Fresh' },
        { product_name: 'Water', category: 'Drinks & water', price: 5 },
      ]);

      const result = await service.bulkCreateFromExcel('user-1', file);

      expect(result).toMatchObject({ totalRows: 2, created: 2 });
      const [tomatoes, water] = prisma.product.create.mock.calls.map((c: any) => c[0].data);
      expect(tomatoes).toMatchObject({ name: 'Tomatoes', price: 10, categoryId: 'veg_fruits', note: 'Fresh' });
      expect(tomatoes.measures.create).toEqual([
        { code: 'olonka', label: 'Olonka', price: 25, description: null, sortOrder: 0 },
        { code: 'table_top', label: 'Table top', price: 10, description: null, sortOrder: 1 },
      ]);
      expect(water).toMatchObject({ name: 'Water', price: 5, categoryId: 'drinks' });
      expect(water.measures).toBeUndefined();
      expect(onboarding.markStockedIfReady).toHaveBeenCalledWith('tenant-1');
    });

    it('still accepts the old "name" column and a form categoryId for rows without one', async () => {
      await service.bulkCreateFromExcel('user-1', sheet([{ Name: 'Onions', Price: 5 }]), 'veg_fruits');
      expect(prisma.product.create.mock.calls[0][0].data).toMatchObject({ name: 'Onions', categoryId: 'veg_fruits' });
    });

    it('imports nothing when any row is invalid, and reports every problem', async () => {
      const file = sheet([
        { product_name: 'No price', category: 'veg_fruits' },
        { product_name: 'Pepper', category: 'veg_fruits', price: 8, measure_1: 'Bowl' },
        { product_name: 'Okra', category: 'veg_fruits', price: 5, price_1: 10 },
        { product_name: 'Garlic', category: 'veg_fruits', price: 3, measure_1: 'Bowl', price_1: 4, measure_2: 'bowl', price_2: 5 },
        { product_name: 'Phone', category: 'electronics', price: 900 },
        { product_name: 'Uncategorised', price: 2 },
        { product_name: 'Yam', category: 'veg_fruits', price: 20 },
      ]);

      const error = await service.bulkCreateFromExcel('user-1', file).catch((e) => e);

      expect(error.getResponse()).toMatchObject({
        message: 'No products were imported: 6 of 7 rows have problems. Fix them and upload again.',
        errors: [
          { row: 2, message: 'Give a "price", or at least one measure with its price.' },
          { row: 3, message: '"measure_1" ("Bowl") needs a non-negative "price_1".' },
          { row: 4, message: '"price_1" is set but "measure_1" is empty.' },
          { row: 5, message: 'Measure "bowl" appears more than once.' },
          { row: 6, message: 'Unknown category "electronics". Use an id or title from the Categories sheet.' },
          { row: 7, message: 'Missing "category".' },
        ],
      });
      expect(prisma.product.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it(`refuses sheets over ${MAX_UPLOAD_ROWS} rows`, async () => {
      const rows = Array.from({ length: MAX_UPLOAD_ROWS + 1 }, (_, i) => ({ product_name: `Item ${i}`, category: 'veg_fruits', price: 1 }));
      await expect(service.bulkCreateFromExcel('user-1', sheet(rows))).rejects.toThrow(`at most ${MAX_UPLOAD_ROWS} products`);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects an unknown form categoryId before reading the file', async () => {
      await expect(service.bulkCreateFromExcel('user-1', sheet([{ name: 'Yam', price: 20 }]), 'nope')).rejects.toThrow('Unknown category');
      expect(prisma.product.create).not.toHaveBeenCalled();
    });
  });

  it('builds an upload template with the headers, examples and the category list', async () => {
    prisma.category.findMany.mockResolvedValue([{ id: 'veg_fruits', title: 'Vegetables & fruits', description: 'Tomatoes' }]);
    const workbook = XLSX.read(await service.uploadTemplate(), { type: 'buffer' });

    expect(workbook.SheetNames).toEqual(['Products', 'Categories']);
    const [headers, example] = XLSX.utils.sheet_to_json<any[]>(workbook.Sheets.Products, { header: 1 });
    expect(headers).toEqual(TEMPLATE_HEADERS);
    expect(example.slice(0, 2)).toEqual(['Tomatoes', 'veg_fruits']);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets.Categories)).toEqual([{ category: 'veg_fruits', title: 'Vegetables & fruits', examples: 'Tomatoes' }]);
  });
});
