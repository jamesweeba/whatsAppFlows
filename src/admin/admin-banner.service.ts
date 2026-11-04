import { Injectable } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { bannerState, ShopBannerService } from '../tenant/shop-banner.service.js';
import { AuditService } from './audit.service.js';

/** Admin review of shop banners. Every decision goes to the audit log. */
@Injectable()
export class AdminBannerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly banners: ShopBannerService,
    private readonly audit: AuditService,
  ) {}

  openPending(tenantId: string) {
    return this.banners.openPendingFor(tenantId);
  }

  async approve(adminId: string, tenantId: string, pendingAt: Date) {
    const shop = await this.prisma.$transaction(async (tx) => {
      const updated = await this.banners.approve(tx, tenantId, pendingAt);
      await this.audit.log(tx, { actorId: adminId, action: AuditAction.BANNER_APPROVED, tenantId, details: 'Banner approved; buyers now see it.' });
      return updated;
    });
    return bannerState(shop);
  }

  async reject(adminId: string, tenantId: string, pendingAt: Date, reason: string) {
    const shop = await this.prisma.$transaction(async (tx) => {
      const updated = await this.banners.reject(tx, tenantId, pendingAt, reason);
      await this.audit.log(tx, { actorId: adminId, action: AuditAction.BANNER_REJECTED, tenantId, details: reason });
      return updated;
    });
    return bannerState(shop);
  }

  /** Takes a live banner down. The reason is shown to the vendor, like a rejection. */
  async remove(adminId: string, tenantId: string, reason: string) {
    const shop = await this.prisma.$transaction(async (tx) => {
      await this.banners.adminRemove(tx, tenantId);
      const updated = await tx.tenant.update({ where: { id: tenantId }, data: { bannerRejectedReason: reason } });
      await this.audit.log(tx, { actorId: adminId, action: AuditAction.BANNER_REMOVED, tenantId, details: reason });
      return updated;
    });
    return bannerState(shop);
  }
}
