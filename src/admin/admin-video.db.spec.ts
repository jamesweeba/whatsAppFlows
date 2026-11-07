/**
 * Admin video decisions against a real Postgres: the waiting list, approve/reject/remove and
 * their audit entries. Opt-in: RUN_DB_TESTS=1 npx vitest run src/admin/admin-video.db.spec.ts
 * Video files are faked in a throwaway folder (conversion itself is tested elsewhere).
 */
import { ConflictException } from '@nestjs/common';
import { AuditAction, ProductVideoStatus as Status, TenantStatus, UserRole } from '@prisma/client';
import 'dotenv/config';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductVideoService } from '../product/product-video.service.js';
import { StorageService } from '../storage/storage.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { AdminVideoService } from './admin-video.service.js';
import { AuditService } from './audit.service.js';

describe.skipIf(!process.env.RUN_DB_TESTS)('admin videos (real database)', () => {
  const prisma = new PrismaService();
  const waba = { uploadMedia: vi.fn(), sendVideo: vi.fn(), sendTextMessage: vi.fn() };
  const stamp = Date.now();
  const storageDir = mkdtempSync(join(tmpdir(), 'admin-video-'));
  let service: AdminVideoService;
  const userIds: string[] = [];
  let adminId = '';
  let tenantId = '';
  let productId = '';
  const uploadedAt = new Date('2026-11-07T10:00:00Z');

  /** Puts a converted upload in place, as the converter would. */
  const pendingUpload = async () => {
    const dir = join(storageDir, `videos/${tenantId}/${productId}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pending.mp4'), 'mp4');
    writeFileSync(join(dir, 'pending.jpg'), 'jpg');
    await prisma.product.update({ where: { id: productId }, data: { videoStatus: Status.PENDING, videoUploadedAt: uploadedAt, pendingVideoSeconds: 12 } });
  };
  const lastAudit = (action: AuditAction) => prisma.auditLog.findFirstOrThrow({ where: { actorId: adminId, action }, orderBy: { createdAt: 'desc' } });

  beforeAll(async () => {
    vi.stubEnv('UPLOAD_DIR', storageDir);
    const videos = new ProductVideoService(prisma, new StorageService(), new TenantService(prisma, {} as any), waba as any);
    service = new AdminVideoService(prisma, videos, new AuditService(prisma));
    const admin = await prisma.user.create({ data: { email: `videoadmin-${stamp}@example.invalid`, password: 'x', firstName: 'Ada', lastName: 'Admin', role: UserRole.SUPER_ADMIN } });
    const vendor = await prisma.user.create({ data: { email: `videoadminshop-${stamp}@example.invalid`, password: 'x', firstName: 'V', lastName: 'T' } });
    userIds.push(admin.id, vendor.id);
    adminId = admin.id;
    tenantId = (await prisma.tenant.create({ data: { name: 'Video Admin Shop', slug: `videoadmin-${stamp}`, userId: vendor.id, status: TenantStatus.ACTIVE } })).id;
    productId = (await prisma.product.create({ data: { name: 'Palm oil', price: 50, tenantId } })).id;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it('lists the upload as waiting, then approves it and logs it', async () => {
    await pendingUpload();
    const { data } = await service.waiting({ limit: 50 });
    expect(data.find((row) => row.productId === productId)).toMatchObject({
      productName: 'Palm oil',
      tenant: { name: 'Video Admin Shop' },
      video: { status: Status.PENDING, pending: { seconds: 12, url: `/api/v1/admin/products/${productId}/video/pending` } },
    });

    await expect(service.approve(adminId, productId, new Date(0))).rejects.toBeInstanceOf(ConflictException);
    const state = await service.approve(adminId, productId, uploadedAt);
    expect(state).toMatchObject({ status: Status.NONE, live: { seconds: 12 } });
    expect((await lastAudit(AuditAction.VIDEO_APPROVED)).details).toContain('Palm oil');
  });

  it('takes a live video down with a reason the vendor sees', async () => {
    const state = await service.remove(adminId, productId, 'Shows a different brand.');
    expect(state).toMatchObject({ status: Status.REJECTED, message: 'Shows a different brand.', live: null });
    expect((await lastAudit(AuditAction.VIDEO_REMOVED)).metadata).toMatchObject({ productId });
  });

  it('rejects a waiting upload with a reason', async () => {
    await pendingUpload();
    const state = await service.reject(adminId, productId, uploadedAt, 'Too dark to see the oil.');
    expect(state).toMatchObject({ status: Status.REJECTED, message: 'Too dark to see the oil.', pending: null });
    expect((await lastAudit(AuditAction.VIDEO_REJECTED)).details).toContain('Too dark');
  });
});
