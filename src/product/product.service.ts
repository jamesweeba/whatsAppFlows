import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as XLSX from 'xlsx';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';

@Injectable()
export class ProductService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the tenant owned by the given user, or throw.
   */
  private async getTenantForUser(userId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { userId },
    });

    if (!tenant) {
      throw new ForbiddenException(
        'You must create a tenant before managing products.',
      );
    }

    return tenant;
  }

  /**
   * Create a single product for the authenticated user's tenant.
   */
  async create(userId: string, dto: CreateProductDto) {
    const tenant = await this.getTenantForUser(userId);

    return this.prisma.product.create({
      data: {
        name: dto.name,
        price: dto.price,
        image: dto.image,
        inStock: dto.inStock ?? true,
        tenantId: tenant.id,
      },
    });
  }

  /**
   * Bulk-create products from an uploaded Excel file.
   *
   * Expected columns: name (required), price (required), image (optional), inStock (optional).
   * Returns a summary of how many rows succeeded and any row-level errors.
   */
  async bulkCreateFromExcel(userId: string, fileBuffer: Buffer) {
    const tenant = await this.getTenantForUser(userId);

    // Parse the Excel file
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];

    if (!sheetName) {
      throw new BadRequestException('The uploaded file has no sheets.');
    }

    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

    if (rows.length === 0) {
      throw new BadRequestException(
        'The uploaded sheet is empty. Expected columns: name, price, image (optional), inStock (optional).',
      );
    }

    const successes: Array<{ row: number; name: string }> = [];
    const errors: Array<{ row: number; message: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2; // +2 because row 1 is the header in Excel

      try {
        // Validate required fields
        const name = row['name'] ?? row['Name'] ?? row['NAME'];
        const price = row['price'] ?? row['Price'] ?? row['PRICE'];

        if (!name || typeof name !== 'string' || name.trim() === '') {
          errors.push({ row: rowNumber, message: 'Missing or invalid "name"' });
          continue;
        }

        const parsedPrice = Number(price);
        if (isNaN(parsedPrice) || parsedPrice < 0) {
          errors.push({
            row: rowNumber,
            message: `Invalid "price": "${price}". Must be a non-negative number.`,
          });
          continue;
        }

        // Optional fields
        const image = row['image'] ?? row['Image'] ?? row['IMAGE'];
        const inStockRaw = row['inStock'] ?? row['InStock'] ?? row['instock'] ?? row['INSTOCK'];

        let inStock = true;
        if (inStockRaw !== undefined && inStockRaw !== null) {
          if (typeof inStockRaw === 'boolean') {
            inStock = inStockRaw;
          } else if (typeof inStockRaw === 'string') {
            inStock = ['true', 'yes', '1'].includes(inStockRaw.toLowerCase());
          } else if (typeof inStockRaw === 'number') {
            inStock = inStockRaw !== 0;
          }
        }

        await this.prisma.product.create({
          data: {
            name: String(name).trim(),
            price: parsedPrice,
            image: image ? String(image).trim() : null,
            inStock,
            tenantId: tenant.id,
          },
        });

        successes.push({ row: rowNumber, name: String(name).trim() });
      } catch (error) {
        errors.push({
          row: rowNumber,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return {
      totalRows: rows.length,
      created: successes.length,
      failed: errors.length,
      errors: errors.length > 0 ? errors : undefined,
    };
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
    const tenant = await this.getTenantForUser(userId);
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
      }),
      this.prisma.product.count({
        where,
      }),
    ]);

    return {
      data: products,
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
    const tenant = await this.getTenantForUser(userId);

    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId: tenant.id },
    });

    if (!product) {
      throw new NotFoundException('Product not found.');
    }

    return product;
  }

  /**
   * Update a product by ID (must belong to the user's tenant).
   */
  async update(userId: string, productId: string, dto: UpdateProductDto) {
    const tenant = await this.getTenantForUser(userId);

    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId: tenant.id },
    });

    if (!product) {
      throw new NotFoundException('Product not found.');
    }

    return this.prisma.product.update({
      where: { id: productId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.price !== undefined && { price: dto.price }),
        ...(dto.image !== undefined && { image: dto.image }),
        ...(dto.inStock !== undefined && { inStock: dto.inStock }),
      },
    });
  }

  /**
   * Delete a product by ID (must belong to the user's tenant).
   */
  async remove(userId: string, productId: string) {
    const tenant = await this.getTenantForUser(userId);

    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId: tenant.id },
    });

    if (!product) {
      throw new NotFoundException('Product not found.');
    }

    await this.prisma.product.delete({
      where: { id: productId },
    });

    return { message: 'Product deleted successfully.' };
  }
}
