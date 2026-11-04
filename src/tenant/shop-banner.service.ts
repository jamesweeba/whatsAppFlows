import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, Tenant } from '@prisma/client';
import sharp from 'sharp';
import { sniffImageType } from '../product/product-photo.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { TenantService } from './tenant.service.js';

export const MAX_BANNER_BYTES = 5 * 1024 * 1024;
/** Buyers see a square from the centre; smaller images look blurry on phones. */
export const MIN_BANNER_SIDE = 300;

type BannerShop = Pick<Tenant, 'id' | 'bannerUpdatedAt' | 'bannerPendingAt' | 'bannerRejectedReason'>;

const liveKey = (tenantId: string) => `banners/${tenantId}/live.jpg`;
const pendingKey = (tenantId: string) => `banners/${tenantId}/pending.jpg`;
/** Change the version whenever the Flow copy's resize rule changes, so old copies are rebuilt. */
const flowKey = (tenantId: string) => `banners/${tenantId}/live.thumb-v1.jpg`;
/** Meta replaces NavigationList images over 100 KB with a placeholder. */
const MAX_FLOW_THUMB_BYTES = 100 * 1024;

/** Public path of the approved banner, versioned so a new one is never served from a stale cache. */
export function bannerUrl(shop: Pick<Tenant, 'id' | 'bannerUpdatedAt'>): string | null {
  return shop.bannerUpdatedAt ? `/api/v1/shops/${shop.id}/banner?v=${shop.bannerUpdatedAt.getTime()}` : null;
}

/** What the vendor app and the admin review screen show about a shop's banner. */
export function bannerState(shop: BannerShop) {
  return {
    url: bannerUrl(shop),
    /** A new banner waiting for an admin (fetch it with the token: it is not public yet). */
    pendingAt: shop.bannerPendingAt,
    rejectedReason: shop.bannerRejectedReason,
  };
}

/**
 * The vendor's banner, shown to buyers beside the shop name on the order form's first screen. A vendor's upload
 * waits for an admin's approval; only the approved one is public.
 */
@Injectable()
export class ShopBannerService {
  private readonly logger = new Logger(ShopBannerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly tenantService: TenantService,
  ) {}

  // ─────────────── Vendor ───────────────

  async state(userId: string) {
    return bannerState(await this.tenantService.findByUser(userId));
  }

  /** Stores the upload as the pending banner (replacing any earlier pending one). */
  async upload(userId: string, file: Express.Multer.File) {
    const tenant = await this.tenantService.findByUser(userId);
    this.tenantService.assertEditable(tenant);
    if (file.size > MAX_BANNER_BYTES) {
      throw new BadRequestException('Banners must be 5 MB or smaller.');
    }
    if (!sniffImageType(file.buffer)) {
      throw new BadRequestException('Upload a JPEG, PNG or WebP image.');
    }

    let image: Buffer;
    try {
      // rotate(): honour EXIF orientation. Kept as a JPEG of at most 1600 px a side.
      const { data, info } = await sharp(file.buffer)
        .rotate()
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      if (Math.min(info.width, info.height) < MIN_BANNER_SIDE) {
        throw new BadRequestException(`Use an image at least ${MIN_BANNER_SIDE} pixels on each side, so it looks sharp on phones.`);
      }
      image = data;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('That image could not be read. Try another one.');
    }

    await this.storage.save(pendingKey(tenant.id), image);
    const updated = await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: { bannerPendingAt: new Date(), bannerRejectedReason: null },
    });
    return bannerState(updated);
  }

  /** Withdraws an upload that is still waiting for approval. */
  async cancelPending(userId: string) {
    const tenant = await this.tenantService.findByUser(userId);
    await this.storage.remove(pendingKey(tenant.id));
    const updated = await this.prisma.tenant.update({ where: { id: tenant.id }, data: { bannerPendingAt: null } });
    return bannerState(updated);
  }

  /** Takes the approved banner down. Buyers stop seeing it straight away; no approval needed. */
  async removeLive(userId: string) {
    const tenant = await this.tenantService.findByUser(userId);
    this.tenantService.assertEditable(tenant);
    return bannerState(await this.clearLive(this.prisma, tenant.id));
  }

  /** The vendor's own pending upload (not public). */
  async openOwnPending(userId: string) {
    const tenant = await this.tenantService.findByUser(userId);
    return this.openPending(tenant);
  }

  // ─────────────── Admin (callers write the audit log) ───────────────

  /** The pending upload for an admin to look at. */
  async openPendingFor(tenantId: string) {
    return this.openPending(await this.shop(tenantId));
  }

  /**
   * Makes the pending banner the live one. `pendingAt` is the upload the admin looked at:
   * if the vendor has uploaded another since, nothing changes (409).
   */
  async approve(tx: Prisma.TransactionClient, tenantId: string, pendingAt: Date) {
    const shop = await this.pendingShop(tx, tenantId, pendingAt);
    const image = await this.storage.readBuffer(pendingKey(shop.id));
    if (!image) {
      throw new ConflictException('The banner file is missing. Ask the vendor to upload it again.');
    }
    await this.storage.save(liveKey(shop.id), image);
    await this.storage.remove(flowKey(shop.id));
    await this.storage.remove(pendingKey(shop.id));
    return tx.tenant.update({
      where: { id: shop.id },
      data: { bannerUpdatedAt: new Date(), bannerPendingAt: null, bannerRejectedReason: null },
    });
  }

  /** Turns the pending banner down; the vendor sees `reason` until they upload again. */
  async reject(tx: Prisma.TransactionClient, tenantId: string, pendingAt: Date, reason: string) {
    const shop = await this.pendingShop(tx, tenantId, pendingAt);
    await this.storage.remove(pendingKey(shop.id));
    return tx.tenant.update({ where: { id: shop.id }, data: { bannerPendingAt: null, bannerRejectedReason: reason } });
  }

  /** Takes a live banner down (admin moderation). */
  async adminRemove(tx: Prisma.TransactionClient, tenantId: string) {
    const shop = await this.shop(tenantId, tx);
    if (!shop.bannerUpdatedAt) {
      throw new ConflictException('This shop has no banner showing any more.');
    }
    return this.clearLive(tx, shop.id);
  }

  // ─────────────── Buyers ───────────────

  /** The approved banner, for anyone. */
  async openLive(tenantId: string) {
    const shop = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { bannerUpdatedAt: true } });
    if (!shop?.bannerUpdatedAt) {
      throw new NotFoundException('This shop has no banner.');
    }
    return this.storage.read(liveKey(tenantId));
  }

  /**
   * The approved banner for the order form's WELCOME list: a 144×144 JPEG cropped square
   * from the centre, as base64, or null when the shop has none or it cannot be prepared.
   */
  async flowThumbnailBase64(shop: Pick<Tenant, 'id' | 'bannerUpdatedAt'>): Promise<string | null> {
    if (!shop.bannerUpdatedAt) {
      return null;
    }
    try {
      let copy = await this.storage.readBuffer(flowKey(shop.id));
      if (!copy) {
        const original = await this.storage.readBuffer(liveKey(shop.id));
        if (!original) {
          return null;
        }
        copy = await sharp(original)
          .resize(144, 144, { fit: 'cover', position: 'centre' })
          .jpeg({ quality: 72, mozjpeg: true })
          .toBuffer();
        await this.storage.save(flowKey(shop.id), copy);
      }
      return copy.length <= MAX_FLOW_THUMB_BYTES ? copy.toString('base64') : null;
    } catch (err: any) {
      this.logger.warn(`Could not prepare the Flow banner for shop ${shop.id}: ${err?.message || err}`);
      return null;
    }
  }

  // ─────────────── Helpers ───────────────

  private async openPending(shop: BannerShop) {
    if (!shop.bannerPendingAt) {
      throw new NotFoundException('There is no banner waiting for approval.');
    }
    return this.storage.read(pendingKey(shop.id));
  }

  private async clearLive(db: Prisma.TransactionClient, tenantId: string) {
    const updated = await db.tenant.update({ where: { id: tenantId }, data: { bannerUpdatedAt: null } });
    await this.storage.remove(liveKey(tenantId));
    await this.storage.remove(flowKey(tenantId));
    return updated;
  }

  private async shop(tenantId: string, db: Prisma.TransactionClient = this.prisma) {
    const shop = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!shop) {
      throw new NotFoundException('Shop not found.');
    }
    return shop;
  }

  private async pendingShop(db: Prisma.TransactionClient, tenantId: string, pendingAt: Date) {
    const shop = await this.shop(tenantId, db);
    if (!shop.bannerPendingAt) {
      throw new ConflictException('There is no banner waiting for approval any more.');
    }
    if (shop.bannerPendingAt.getTime() !== pendingAt.getTime()) {
      throw new ConflictException('The vendor has uploaded a newer banner since you opened this page.');
    }
    return shop;
  }
}
