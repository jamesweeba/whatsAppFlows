import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { ProductMeasureDto } from './dto/product-measure.dto.js';
import { CategoryService } from '../category/category.service.js';
import { RESERVED_MEASURE_CODES } from '../common/measure-codes.js';
import { OnboardingService } from '../tenant/onboarding.service.js';
import { ProductPhotoService, withPhotoUrl } from './product-photo.service.js';
import { ProductVideoService } from './product-video.service.js';

/** Optional measure column pairs in the Excel upload: measure_1/price_1 ... measure_10/price_10. */
const MAX_SHEET_MEASURES = 10;
/** Rows per upload: keeps one upload to one reasonable transaction. */
export const MAX_UPLOAD_ROWS = 500;
const MEASURE_LABEL_MAX = 15;

/** "Table top" -> "table_top" */
function measureCode(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const PRODUCT_INCLUDE = {
  category: true,
  measures: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.ProductInclude;

function measureRows(measures: ProductMeasureDto[]) {
  return measures.map((m, i) => ({ code: m.code, label: m.label, price: m.price, description: m.description ?? null, sortOrder: i }));
}

function cheapest(measures: ProductMeasureDto[]): number {
  return Math.min(...measures.map((m) => m.price));
}

/** Columns of the downloadable upload template, in order. */
export const TEMPLATE_HEADERS = [
  'product_name', 'category', 'price',
  'measure_1', 'price_1', 'measure_2', 'price_2', 'measure_3', 'price_3',
  'note',
];

interface SheetProduct {
  name: string;
  categoryId: string;
  price: number;
  note: string | null;
  image: string | null;
  inStock: boolean;
  measures: ProductMeasureDto[];
}

@Injectable()
export class ProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantService: TenantService,
    private readonly categoryService: CategoryService,
    private readonly onboardingService: OnboardingService,
    private readonly photoService: ProductPhotoService,
    private readonly videoService: ProductVideoService,
  ) {}

  /**
   * Create a single product for the authenticated user's tenant.
   */
  async create(userId: string, dto: CreateProductDto) {
    const tenant = await this.tenantService.findByUser(userId);
    this.tenantService.assertEditable(tenant);
    await this.categoryService.assertExists(dto.categoryId);
    this.assertUniqueMeasureCodes(dto.measures);

    const product = await this.prisma.product.create({
      data: {
        name: dto.name,
        price: dto.price ?? cheapest(dto.measures ?? []),
        image: dto.image,
        inStock: dto.inStock ?? true,
        note: dto.note,
        categoryId: dto.categoryId,
        promoterRate: dto.promoterRate ?? null,
        tenantId: tenant.id,
        ...(dto.measures?.length && { measures: { create: measureRows(dto.measures) } }),
      },
      include: PRODUCT_INCLUDE,
    });
    await this.onboardingService.markStockedIfReady(tenant.id);
    return withPhotoUrl(product);
  }

  /**
   * Bulk-create products from an uploaded Excel file (see TEMPLATE_HEADERS).
   *
   * Columns: product_name (or name), category (a category id or title; falls back to the
   * `defaultCategoryId` form field), price (optional when measures are given: the cheapest
   * measure is used), measure_1/price_1 ... measure_10/price_10, note, image, instock.
   *
   * All or nothing: if any row is invalid nothing is imported, and the 400 response lists
   * every problem so the vendor can fix the sheet in one go.
   */
  async bulkCreateFromExcel(userId: string, fileBuffer: Buffer, defaultCategoryId?: string) {
    const tenant = await this.tenantService.findByUser(userId);
    this.tenantService.assertEditable(tenant);
    if (defaultCategoryId) {
      await this.categoryService.assertExists(defaultCategoryId);
    }

    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new BadRequestException('The uploaded file has no sheets.');
    }

    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]);
    if (rows.length === 0) {
      throw new BadRequestException(`The uploaded sheet is empty. Expected columns: ${TEMPLATE_HEADERS.join(', ')}.`);
    }
    if (rows.length > MAX_UPLOAD_ROWS) {
      throw new BadRequestException(`A sheet can have at most ${MAX_UPLOAD_ROWS} products; this one has ${rows.length}. Split it into several uploads.`);
    }

    const categories = await this.categoryService.list();
    const categoryFor = (value: unknown): string | null =>
      String(value ?? '').trim() ? this.categoryService.match(categories, value) : (defaultCategoryId ?? null);

    const parsed: SheetProduct[] = [];
    const errors: Array<{ row: number; message: string }> = [];
    rows.forEach((raw, i) => {
      const rowNumber = i + 2; // row 1 is the header
      const result = this.parseSheetRow(raw, categoryFor);
      if (typeof result === 'string') {
        errors.push({ row: rowNumber, message: result });
      } else {
        parsed.push(result);
      }
    });

    if (errors.length > 0) {
      throw new BadRequestException({
        message: `No products were imported: ${errors.length} of ${rows.length} rows have problems. Fix them and upload again.`,
        totalRows: rows.length,
        errors,
      });
    }

    await this.prisma.$transaction(
      parsed.map(({ measures, ...product }) =>
        this.prisma.product.create({
          data: {
            ...product,
            tenantId: tenant.id,
            ...(measures.length && { measures: { create: measureRows(measures) } }),
          },
        }),
      ),
    );
    await this.onboardingService.markStockedIfReady(tenant.id);

    return {
      totalRows: rows.length,
      created: parsed.length,
      products: parsed.map((p, i) => ({ row: i + 2, name: p.name, categoryId: p.categoryId })),
    };
  }

  /** An .xlsx with the template headers, an example row, and a sheet listing the category ids. */
  async uploadTemplate(): Promise<Buffer> {
    const categories = await this.categoryService.list();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        TEMPLATE_HEADERS,
        ['Tomatoes', 'veg_fruits', '', 'Olonka', 15, 'Half basket', 45, 'Basket', 85, 'Fresh from Kejetia'],
        ['Rice (5 kg)', 'rice_oil', 70, '', '', '', '', '', '', ''],
      ]),
      'Products',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['category', 'title', 'examples'], ...categories.map((c) => [c.id, c.title, c.description ?? ''])]),
      'Categories',
    );
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  }

  /** Validate one sheet row; returns the product, or a message describing the first problem. */
  private parseSheetRow(raw: Record<string, unknown>, categoryFor: (value: unknown) => string | null): SheetProduct | string {
    // Column headers are matched case-insensitively ("Name", "NAME", "name").
    const row = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.trim().toLowerCase(), value]));

    const name = String(row['product_name'] ?? row['name'] ?? '').trim();
    if (!name) return 'Missing "product_name".';

    const categoryId = categoryFor(row['category']);
    if (!categoryId) {
      return row['category']
        ? `Unknown category "${row['category']}". Use an id or title from the Categories sheet.`
        : 'Missing "category".';
    }

    const measures = this.parseSheetMeasures(row);
    if (typeof measures === 'string') return measures;

    const rawPrice = row['price'];
    const hasPrice = rawPrice !== undefined && rawPrice !== null && String(rawPrice).trim() !== '';
    const price = hasPrice ? Number(rawPrice) : measures.length ? cheapest(measures) : NaN;
    if (isNaN(price) || price < 0) {
      return hasPrice ? `Invalid "price": "${rawPrice}". Must be a non-negative number.` : 'Give a "price", or at least one measure with its price.';
    }

    const inStockRaw = row['instock'];
    let inStock = true;
    if (typeof inStockRaw === 'boolean') inStock = inStockRaw;
    else if (typeof inStockRaw === 'number') inStock = inStockRaw !== 0;
    else if (typeof inStockRaw === 'string' && inStockRaw.trim()) inStock = ['true', 'yes', '1'].includes(inStockRaw.trim().toLowerCase());

    const note = String(row['note'] ?? '').trim();
    const image = String(row['image'] ?? '').trim();
    return { name, categoryId, price, note: note || null, image: image || null, inStock, measures };
  }

  /**
   * List all products for the authenticated user's tenant, with optional search and pagination.
   */
  async findAll(
    userId: string,
    page: number = 1,
    limit: number = 5,
    search?: string,
  ) {
    const tenant = await this.tenantService.findByUser(userId);
    const safePage = Math.max(page, 1);
    const safeLimit = Math.min(Math.max(limit, 1), 5);

    const skip = (safePage - 1) * safeLimit;

    const where = {
      tenantId: tenant.id,
      ...(search && search.trim() !== ''
        ? {
            name: {
              contains: search.trim(),
              mode: 'insensitive' as const,
            },
          }
        : {}),
    };

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        include: PRODUCT_INCLUDE,
      }),
      this.prisma.product.count({
        where,
      }),
    ]);

    return {
      data: products.map(withPhotoUrl),
      meta: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  /**
   * Get a single product by ID (must belong to the user's tenant).
   */
  async findOne(userId: string, productId: string) {
    const tenant = await this.tenantService.findByUser(userId);
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId: tenant.id },
      include: PRODUCT_INCLUDE,
    });
    if (!product) {
      throw new NotFoundException('Product not found.');
    }
    return withPhotoUrl(product);
  }

  /**
   * Update a product by ID (must belong to the user's tenant).
   */
  async update(userId: string, productId: string, dto: UpdateProductDto) {
    const tenant = await this.tenantService.findByUser(userId);
    this.tenantService.assertEditable(tenant);
    await this.findOne(userId, productId);
    if (dto.categoryId) {
      await this.categoryService.assertExists(dto.categoryId);
    }
    this.assertUniqueMeasureCodes(dto.measures);

    // New measures re-derive the base price unless the vendor sets one explicitly.
    const price = dto.price ?? (dto.measures?.length ? cheapest(dto.measures) : undefined);

    const product = await this.prisma.product.update({
      where: { id: productId },
      data: {
        name: dto.name,
        price,
        image: dto.image,
        inStock: dto.inStock,
        note: dto.note,
        categoryId: dto.categoryId,
        promoterRate: dto.promoterRate,
        ...(dto.measures !== undefined && {
          measures: { deleteMany: {}, create: measureRows(dto.measures) },
        }),
      },
      include: PRODUCT_INCLUDE,
    });
    if (dto.measures !== undefined) {
      // A deleted measure takes its video with it (kept measures keep their codes, and videos).
      await this.videoService.pruneMeasures(product, product.measures.map((m) => m.code));
    }
    await this.onboardingService.markStockedIfReady(tenant.id);
    return withPhotoUrl(product);
  }

  /**
   * Read the optional measure_N / price_N column pairs of one sheet row.
   * Returns the measures, or an error message describing the first problem.
   */
  private parseSheetMeasures(row: Record<string, unknown>): ProductMeasureDto[] | string {
    const measures: ProductMeasureDto[] = [];
    for (let n = 1; n <= MAX_SHEET_MEASURES; n++) {
      const rawLabel = row[`measure_${n}`];
      const rawPrice = row[`price_${n}`];
      const label = rawLabel === undefined || rawLabel === null ? '' : String(rawLabel).trim();
      const hasPrice = rawPrice !== undefined && rawPrice !== null && String(rawPrice).trim() !== '';
      if (!label && !hasPrice) continue;

      if (!label) return `"price_${n}" is set but "measure_${n}" is empty.`;
      if (label.length > MEASURE_LABEL_MAX) return `"measure_${n}" ("${label}") must be at most ${MEASURE_LABEL_MAX} characters.`;
      const price = Number(rawPrice);
      if (!hasPrice || isNaN(price) || price < 0) return `"measure_${n}" ("${label}") needs a non-negative "price_${n}".`;

      const code = measureCode(label);
      if (!code || RESERVED_MEASURE_CODES.includes(code)) return `"measure_${n}" ("${label}") is not a valid measure name.`;
      if (measures.some((m) => m.code === code)) return `Measure "${label}" appears more than once.`;
      measures.push({ code, label, price });
    }
    return measures;
  }

  private assertUniqueMeasureCodes(measures?: ProductMeasureDto[]) {
    const codes = (measures ?? []).map((m) => m.code);
    if (new Set(codes).size !== codes.length) {
      throw new BadRequestException('Each measure code must be unique within a product.');
    }
    const reserved = codes.find((code) => RESERVED_MEASURE_CODES.includes(code));
    if (reserved) {
      throw new BadRequestException(`"${reserved}" is reserved and cannot be used as a measure code.`);
    }
  }

  /**
   * Delete a product by ID (must belong to the user's tenant).
   */
  async remove(userId: string, productId: string) {
    this.tenantService.assertEditable(await this.tenantService.findByUser(userId));
    const product = await this.findOne(userId, productId);
    await this.prisma.product.delete({
      where: { id: productId },
    });
    await this.photoService.removeFile(product);
    await this.videoService.removeFiles(product);

    return { message: 'Product deleted successfully.' };
  }
}
