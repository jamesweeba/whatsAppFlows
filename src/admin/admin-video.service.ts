import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, Prisma, Product, ProductVideoStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductVideoService, videoState, WHOLE_PRODUCT, type VideoFileKind, type VideoSlot } from '../product/product-video.service.js';
import { AuditService } from './audit.service.js';
import { MAX_PAGE_SIZE } from './vendor-directory.service.js';

/** Admins approve, reject and take down product videos (whole product or one measure). Each decision is in the audit log. */
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
    const where: Prisma.ProductVideoWhereInput = { status: ProductVideoStatus.PENDING };
    const [rows, total] = await Promise.all([
      this.prisma.productVideo.findMany({
        where,
        include: { product: { select: { id: true, name: true, tenant: { select: { id: true, name: true } }, measures: { select: { code: true, label: true } } } } },
        orderBy: { uploadedAt: 'asc' },
        skip: (Math.max(page, 1) - 1) * take,
        take,
      }),
      this.prisma.productVideo.count({ where }),
    ]);
    return {
      data: rows.map((v) => ({
        productId: v.product.id,
        productName: v.product.name,
        /** Null: a video of the whole product. */
        measure: v.measureCode ? { code: v.measureCode, label: v.product.measures.find((m) => m.code === v.measureCode)?.label ?? v.measureCode } : null,
        tenant: v.product.tenant,
        video: videoState(v.product.id, v.measureCode, v, { forAdmin: true }),
      })),
      meta: { total, page: Math.max(page, 1), limit: take, totalPages: Math.ceil(total / take) },
    };
  }

  open(productId: string, measureCode: string, slot: VideoSlot, kind: VideoFileKind) {
    return this.videos.openFor(productId, measureCode, slot, kind);
  }

  async approve(adminId: string, productId: string, measureCode: string, uploadedAt: Date) {
    return this.decide(adminId, productId, measureCode, AuditAction.VIDEO_APPROVED, (tx) => this.videos.approve(tx, productId, measureCode, uploadedAt), 'approved; buyers can watch it.');
  }

  async reject(adminId: string, productId: string, measureCode: string, uploadedAt: Date, reason: string) {
    return this.decide(adminId, productId, measureCode, AuditAction.VIDEO_REJECTED, (tx) => this.videos.reject(tx, productId, measureCode, uploadedAt, reason), reason);
  }

  /** Takes a live video down; the reason is shown to the vendor. */
  async remove(adminId: string, productId: string, measureCode: string, reason: string) {
    return this.decide(adminId, productId, measureCode, AuditAction.VIDEO_REMOVED, (tx) => this.videos.adminRemove(tx, productId, measureCode, reason), reason);
  }

  /** One video's state, for the admin. */
  async state(productId: string, measureCode = WHOLE_PRODUCT) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found.');
    const row = await this.prisma.productVideo.findUnique({ where: { productId_measureCode: { productId, measureCode } } });
    return videoState(productId, measureCode, row, { forAdmin: true });
  }

  private async decide(
    adminId: string,
    productId: string,
    measureCode: string,
    action: AuditAction,
    change: (tx: Prisma.TransactionClient) => Promise<{ product: Product; video: Parameters<typeof videoState>[2] }>,
    note: string,
  ) {
    const video = await this.prisma.$transaction(async (tx) => {
      const { product, video: updated } = await change(tx);
      const label = measureCode ? (await tx.productMeasure.findFirst({ where: { productId, code: measureCode } }))?.label ?? measureCode : null;
      const what = label ? `"${product.name} · ${label}"` : `"${product.name}"`;
      await this.audit.log(tx, { actorId: adminId, action, tenantId: product.tenantId, details: `Video for ${what}: ${note}`, metadata: { productId, measureCode } });
      return updated;
    });
    return videoState(productId, measureCode, video, { forAdmin: true });
  }
}
