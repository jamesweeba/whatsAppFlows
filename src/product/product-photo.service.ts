import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Product } from '@prisma/client';
import sharp, { type Sharp } from 'sharp';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { TenantService } from '../tenant/tenant.service.js';

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/**
 * The image type, read from the file's first bytes. The browser's claimed type is not
 * trusted: photos are served publicly, so only real JPEG, PNG and WebP files are kept
 * (never HTML or SVG, which a browser could run as a page).
 */
export function sniffImageType(data: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Path of the public photo, versioned so a replaced photo is never served from a stale cache. */
export function photoUrl(product: Pick<Product, 'id' | 'photoUpdatedAt'>): string | null {
  return product.photoUpdatedAt ? `/api/v1/products/${product.id}/photo?v=${product.photoUpdatedAt.getTime()}` : null;
}

/** Adds `photoUrl` to a product returned by the API. */
export function withPhotoUrl<T extends Pick<Product, 'id' | 'photoUpdatedAt'>>(product: T): T & { photoUrl: string | null } {
  return { ...product, photoUrl: photoUrl(product) };
}

const storageKey = (product: Pick<Product, 'id' | 'tenantId'>) => `products/${product.tenantId}/${product.id}`;

type PhotoProduct = Pick<Product, 'id' | 'tenantId' | 'photoMimeType'>;

/**
 * The small copies sent inside WhatsApp Flow screens, made from the original on first use
 * and kept. Change a variant's `key` whenever its resize rule changes, so copies made the
 * old way are rebuilt instead of served.
 */
const FLOW_VARIANTS = {
  /**
   * PRODUCT screen: the whole photo, never cropped, fitted inside 600×600 (a portrait 900×1200
   * becomes 450×600). The Flow's Image uses scale-type "contain". Meta suggests ≤ 300 KB.
   */
  photo: {
    key: 'flow-v2',
    maxBytes: 300 * 1024,
    render: (img: Sharp) =>
      img.resize(600, 600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70, mozjpeg: true }),
  },
  /**
   * CATALOGUE list rows: a 144×144 square (sharp on high-density screens), the whole photo
   * centred on white so bottles are not trimmed. Meta replaces anything over 100 KB with a
   * placeholder; these come out around 3–6 KB.
   */
  thumb: {
    key: 'thumb-v1',
    maxBytes: 100 * 1024,
    render: (img: Sharp) =>
      img
        .resize(144, 144, { fit: 'contain', background: '#ffffff' })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 70, mozjpeg: true }),
  },
} as const;

type FlowVariant = keyof typeof FLOW_VARIANTS;

const variantKey = (product: Pick<Product, 'id' | 'tenantId'>, variant: FlowVariant) =>
  `${storageKey(product)}.${FLOW_VARIANTS[variant].key}.jpg`;

/** Exported for tests. */
export const FLOW_PHOTO_LIMITS = { photo: FLOW_VARIANTS.photo.maxBytes, thumb: FLOW_VARIANTS.thumb.maxBytes };

/** Product photos: one per product, uploaded by the vendor, readable by anyone. */
@Injectable()
export class ProductPhotoService {
  private readonly logger = new Logger(ProductPhotoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly tenantService: TenantService,
  ) {}

  /** Stores (or replaces) the photo of one of the vendor's products. */
  async upload(userId: string, productId: string, file: Express.Multer.File) {
    const product = await this.ownEditableProduct(userId, productId);
    if (file.size > MAX_PHOTO_BYTES) {
      throw new BadRequestException('Photos must be 5 MB or smaller.');
    }
    const mimeType = sniffImageType(file.buffer);
    if (!mimeType) {
      throw new BadRequestException('Upload a JPEG, PNG or WebP photo.');
    }

    // Same key every time, so a new photo simply overwrites the old one.
    await this.storage.save(storageKey(product), file.buffer);
    await this.removeFlowCopies(product);
    const updated = await this.prisma.product.update({
      where: { id: product.id },
      data: { photoMimeType: mimeType, photoUpdatedAt: new Date() },
    });
    return { photoUrl: photoUrl(updated) };
  }

  /** Removes the photo of one of the vendor's products. */
  async remove(userId: string, productId: string) {
    const product = await this.ownEditableProduct(userId, productId);
    await this.prisma.product.update({ where: { id: product.id }, data: { photoMimeType: null, photoUpdatedAt: null } });
    await this.storage.remove(storageKey(product));
    await this.removeFlowCopies(product);
    return { photoUrl: null };
  }

  /** Deletes a photo file whose product is being deleted. */
  async removeFile(product: Pick<Product, 'id' | 'tenantId' | 'photoUpdatedAt'>) {
    if (product.photoUpdatedAt) {
      await this.storage.remove(storageKey(product));
      await this.removeFlowCopies(product);
    }
  }

  /**
   * The product photo as base64 JPEG for the PRODUCT screen's Image, or null when there is
   * no usable photo (the caller shows a placeholder).
   */
  flowPhotoBase64(product: PhotoProduct): Promise<string | null> {
    return this.flowCopyBase64(product, 'photo');
  }

  /** A small square thumbnail as base64 JPEG for a CATALOGUE row, or null without a photo. */
  flowThumbnailBase64(product: PhotoProduct): Promise<string | null> {
    return this.flowCopyBase64(product, 'thumb');
  }

  /**
   * Read the saved copy, or make it from the original and save it. Uploading or removing a
   * photo deletes the copies, so they are always rebuilt from the current original.
   */
  private async flowCopyBase64(product: PhotoProduct, variant: FlowVariant): Promise<string | null> {
    if (!product.photoMimeType) {
      return null;
    }
    const { render, maxBytes } = FLOW_VARIANTS[variant];
    try {
      let copy = await this.storage.readBuffer(variantKey(product, variant));
      if (!copy) {
        const original = await this.storage.readBuffer(storageKey(product));
        if (!original) {
          return null;
        }
        const made = await render(sharp(original).rotate()).toBuffer(); // rotate(): honour EXIF orientation
        await this.storage.save(variantKey(product, variant), made);
        copy = made;
      }
      return copy.length <= maxBytes ? copy.toString('base64') : null;
    } catch (err: any) {
      this.logger.warn(`Could not prepare the Flow ${variant} for product ${product.id}: ${err?.message || err}`);
      return null;
    }
  }

  private async removeFlowCopies(product: Pick<Product, 'id' | 'tenantId'>) {
    for (const variant of Object.keys(FLOW_VARIANTS) as FlowVariant[]) {
      await this.storage.remove(variantKey(product, variant));
    }
  }

  /** The photo file, for anyone (buyers and WhatsApp load it without logging in). */
  async open(productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product?.photoMimeType) {
      throw new NotFoundException('This product has no photo.');
    }
    return { mimeType: product.photoMimeType, stream: await this.storage.read(storageKey(product)) };
  }

  private async ownEditableProduct(userId: string, productId: string) {
    const tenant = await this.tenantService.findByUser(userId);
    this.tenantService.assertEditable(tenant);
    const product = await this.prisma.product.findFirst({ where: { id: productId, tenantId: tenant.id } });
    if (!product) {
      throw new NotFoundException('Product not found.');
    }
    return product;
  }
}
