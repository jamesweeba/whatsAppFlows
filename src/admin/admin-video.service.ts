import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, Prisma, ProductVideoStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductVideoService, videoState, type VideoFileKind, type VideoSlot } from '../product/product-video.service.js';
import { AuditService } from './audit.service.js';
import { MAX_PAGE_SIZE } from './vendor-directory.service.js';

/** Admins approve, reject and take down product videos. Each decision is in the audit log. */
@Injectable()
export class AdminVideoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly videos: ProductVideoService,
    private readonly audit: AuditService,
  ) {}

  /** Videos waiting for approval, oldest first, across every shop. */
  async waiting({ page = 1, limit = 20 }: { page?: number; limit?: number }) {
    const take = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);
    const where: Prisma.ProductWhereInput = { videoStatus: ProductVideoStatus.PENDING };
    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { tenant: { select: { id: true, name: true } } },
        orderBy: { videoUploadedAt: 'asc' },
        skip: (Math.max(page, 1) - 1) * take,
        take,
      }),
      this.prisma.product.count({ where }),
    ]);
    return {
      data: products.map((p) => ({ productId: p.id, productName: p.name, tenant: p.tenant, video: videoState(p, { forAdmin: true }) })),
      meta: { total, page: Math.max(page, 1), limit: take, totalPages: Math.ceil(total / take) },
    };
  }

  open(productId: string, slot: VideoSlot, kind: VideoFileKind) {
    return this.videos.openFor(productId, slot, kind);
  }

  async approve(adminId: string, productId: string, uploadedAt: Date) {
    const product = await this.prisma.$transaction(async (tx) => {
      const updated = await this.videos.approve(tx, productId, uploadedAt);
      await this.audit.log(tx, { actorId: adminId, action: AuditAction.VIDEO_APPROVED, tenantId: updated.tenantId, details: `Video for "${updated.name}" approved; buyers can watch it.`, metadata: { productId } });
      return updated;
    });
    return videoState(product, { forAdmin: true });
  }

  async reject(adminId: string, productId: string, uploadedAt: Date, reason: string) {
    const product = await this.prisma.$transaction(async (tx) => {
      const updated = await this.videos.reject(tx, productId, uploadedAt, reason);
      await this.audit.log(tx, { actorId: adminId, action: AuditAction.VIDEO_REJECTED, tenantId: updated.tenantId, details: `"${updated.name}": ${reason}`, metadata: { productId } });
      return updated;
    });
    return videoState(product, { forAdmin: true });
  }

  /** Takes a live video down; the reason is shown to the vendor. */
  async remove(adminId: string, productId: string, reason: string) {
    const product = await this.prisma.$transaction(async (tx) => {
      const updated = await this.videos.adminRemove(tx, productId, reason);
      await this.audit.log(tx, { actorId: adminId, action: AuditAction.VIDEO_REMOVED, tenantId: updated.tenantId, details: `"${updated.name}": ${reason}`, metadata: { productId } });
      return updated;
    });
    return videoState(product, { forAdmin: true });
  }

  /** The video state of one product, for the admin's product list. */
  async state(productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found.');
    return videoState(product, { forAdmin: true });
  }
}
