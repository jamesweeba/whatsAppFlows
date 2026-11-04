import { BadRequestException, Injectable } from '@nestjs/common';
import { Category } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantService } from '../tenant/tenant.service.js';

/** Display order everywhere categories are listed. */
const CATEGORY_ORDER = [{ sortOrder: 'asc' as const }, { title: 'asc' as const }];

/**
 * The platform's predefined product categories (seeded by migration, not owned by any
 * shop). The only place that reads the Category table: products, the Excel upload and
 * the WhatsApp Flow all go through here.
 */
@Injectable()
export class CategoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantService: TenantService,
  ) {}

  /** Every category, in display order. */
  list(): Promise<Category[]> {
    return this.prisma.category.findMany({ orderBy: CATEGORY_ORDER });
  }

  /** Categories in which this shop has at least one in-stock product (for the Flow). */
  listInStock(tenantId: string): Promise<Category[]> {
    return this.prisma.category.findMany({
      where: { products: { some: { tenantId, inStock: true } } },
      orderBy: CATEGORY_ORDER,
    });
  }

  /** A category's title, or null when the id is not a category. */
  async titleOf(categoryId: string): Promise<string | null> {
    const category = await this.prisma.category.findUnique({ where: { id: categoryId } });
    return category?.title ?? null;
  }

  /**
   * Match what a vendor typed (an id such as "veg_fruits" or a title such as
   * "Vegetables & fruits", any case) against an already loaded list. Returns the id.
   */
  match(categories: Pick<Category, 'id' | 'title'>[], value: unknown): string | null {
    const wanted = String(value ?? '').trim().toLowerCase();
    if (!wanted) return null;
    return categories.find((c) => c.id === wanted || c.title.toLowerCase() === wanted)?.id ?? null;
  }

  /** Every category a vendor can choose from, with how many of their products are in each. */
  async findAll(userId: string) {
    const tenant = await this.tenantService.findByUser(userId);
    const categories = await this.prisma.category.findMany({
      orderBy: CATEGORY_ORDER,
      include: { _count: { select: { products: { where: { tenantId: tenant.id } } } } },
    });
    return categories.map(({ _count, createdAt: _c, modifiedAt: _m, ...category }) => ({
      ...category,
      productCount: _count.products,
    }));
  }

  /** Throws a 400 listing the valid ids when the category does not exist. */
  async assertExists(categoryId: string) {
    const category = await this.prisma.category.findUnique({ where: { id: categoryId } });
    if (!category) {
      const ids = await this.prisma.category.findMany({ select: { id: true }, orderBy: CATEGORY_ORDER });
      throw new BadRequestException(
        `Unknown category "${categoryId}". Choose one of: ${ids.map((c) => c.id).join(', ')}.`,
      );
    }
    return category;
  }
}
