/**
 * Product videos against a real Postgres and the real ffmpeg, with files in a throwaway
 * folder. Opt-in: RUN_DB_TESTS=1 npx vitest run src/product/product-video.db.spec.ts
 * (skipped without ffmpeg). Makes a throwaway shop and deletes it afterwards.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ProductVideoStatus as Status, TenantStatus } from '@prisma/client';
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { ProductVideoService } from './product-video.service.js';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!process.env.RUN_DB_TESTS || !hasFfmpeg)('product videos (real database and ffmpeg)', { timeout: 60_000 }, () => {
  const prisma = new PrismaService();
  const waba = { uploadMedia: vi.fn(), sendVideo: vi.fn(), sendTextMessage: vi.fn() };
  const stamp = Date.now();
  const storageDir = mkdtempSync(join(tmpdir(), 'video-storage-'));
  const clipsDir = mkdtempSync(join(tmpdir(), 'video-clips-'));
  let service: ProductVideoService;
  let userId = '';
  let tenantId = '';
  let productId = '';
  let clip = '';

  /** What multer hands over: a temp file of its own (the service deletes it when done). */
  const upload = (source = clip) => {
    const path = join(clipsDir, `upload-${Math.random().toString(36).slice(2)}`);
    copyFileSync(source, path);
    return { path, size: 1000 } as Express.Multer.File;
  };
  const product = () => prisma.product.findUniqueOrThrow({ where: { id: productId } });
  const stored = (slot: string, ext: string) => existsSync(join(storageDir, `videos/${tenantId}/${productId}/${slot}.${ext}`));

  beforeAll(async () => {
    vi.stubEnv('UPLOAD_DIR', storageDir);
    service = new ProductVideoService(prisma, new StorageService(), new TenantService(prisma, {} as any), waba as any);
    await service.onModuleInit();
    clip = join(clipsDir, 'clip.mov');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=3', '-c:v', 'mpeg4', clip]);

    const user = await prisma.user.create({ data: { email: `videotest-${stamp}@example.invalid`, password: 'x', firstName: 'V', lastName: 'T' } });
    userId = user.id;
    tenantId = (await prisma.tenant.create({ data: { name: 'Video Test Shop', slug: `videotest-${stamp}`, userId, status: TenantStatus.ACTIVE } })).id;
    productId = (await prisma.product.create({ data: { name: 'Rice', price: 100, tenantId } })).id;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
    rmSync(storageDir, { recursive: true, force: true });
    rmSync(clipsDir, { recursive: true, force: true });
  });

  it('converts an upload in the background, then it waits for an admin', async () => {
    const file = upload();
    const started = await service.upload(userId, productId, file);
    expect(started).toMatchObject({ status: Status.PROCESSING, live: null, pending: null });

    await service.whenIdle();
    const state = await service.state(userId, productId);
    expect(state.status).toBe(Status.PENDING);
    expect(state.pending).toMatchObject({ seconds: 3, trimmed: false, url: `/api/v1/products/${productId}/video/pending` });
    expect(stored('pending', 'mp4') && stored('pending', 'jpg')).toBe(true);
    expect(existsSync(file.path)).toBe(false); // the temp upload is cleaned up
    expect((await service.openOwn(userId, productId, 'pending', 'video')).mimeType).toBe('video/mp4');
  });

  it("refuses to approve an upload the admin didn't see, then approves the right one", async () => {
    const { videoUploadedAt } = await product();
    await expect(prisma.$transaction((tx) => service.approve(tx, productId, new Date(0)))).rejects.toBeInstanceOf(ConflictException);

    await prisma.$transaction((tx) => service.approve(tx, productId, videoUploadedAt!));
    const state = await service.state(userId, productId);
    expect(state).toMatchObject({ status: Status.NONE, pending: null, live: { seconds: 3 } });
    expect(stored('live', 'mp4') && !stored('pending', 'mp4')).toBe(true);
  });

  it('keeps the live video while a replacement waits, and rejects the replacement with a reason', async () => {
    await service.upload(userId, productId, upload());
    await service.whenIdle();
    const { videoUploadedAt } = await product();
    expect((await service.state(userId, productId)).live).not.toBeNull();

    await prisma.$transaction((tx) => service.reject(tx, productId, videoUploadedAt!, 'The video is blurry.'));
    expect(await service.state(userId, productId)).toMatchObject({ status: Status.REJECTED, message: 'The video is blurry.', live: { seconds: 3 } });
  });

  it('marks a file that is not a video as failed, with a message for the vendor', async () => {
    const fake = join(clipsDir, 'fake.mp4');
    writeFileSync(fake, 'not a video');
    await service.upload(userId, productId, upload(fake));
    await service.whenIdle();
    const state = await service.state(userId, productId);
    expect(state.status).toBe(Status.FAILED);
    expect(state.message).toContain('isn’t a video');
  });

  it('drops a conversion whose upload was cancelled meanwhile', async () => {
    await service.upload(userId, productId, upload());
    await service.cancelPending(userId, productId); // before the queue gets to it
    await service.whenIdle();
    expect((await product()).videoStatus).toBe(Status.NONE);
    expect(stored('pending', 'mp4')).toBe(false);
  });

  it('marks conversions interrupted by a restart as failed', async () => {
    await prisma.product.update({ where: { id: productId }, data: { videoStatus: Status.PROCESSING, videoUploadedAt: new Date() } });
    await service.onModuleInit();
    expect((await product())).toMatchObject({ videoStatus: Status.FAILED, videoMessage: expect.stringContaining('interrupted') });
  });

  it('sends the live video to buyers: uploads to WhatsApp once, then reuses it', async () => {
    const tenant = { id: tenantId, name: 'Video Test Shop', whatsappPhoneNumberId: 'SHOP_NUMBER' };
    waba.uploadMedia.mockResolvedValue('MEDIA_1');
    waba.sendVideo.mockResolvedValue({ messageId: 'wamid.video' });

    expect(await service.sendToBuyer(tenant, productId, '+233200000001')).toBe('sent');
    expect(waba.uploadMedia).toHaveBeenCalledTimes(1);
    expect(waba.uploadMedia).toHaveBeenCalledWith('SHOP_NUMBER', expect.any(Buffer), 'video/mp4', `${productId}.mp4`);
    expect(waba.sendVideo).toHaveBeenCalledWith('SHOP_NUMBER', '+233200000001', 'MEDIA_1', expect.stringContaining('Rice from Video Test Shop'));
    expect((await product()).waVideoMediaId).toBe('MEDIA_1');

    // The same buyer tapping again straight away gets nothing more; another buyer reuses the upload.
    expect(await service.sendToBuyer(tenant, productId, '+233200000001')).toBe('too_soon');
    expect(await service.sendToBuyer(tenant, productId, '+233200000002')).toBe('sent');
    expect(waba.uploadMedia).toHaveBeenCalledTimes(1);
  });

  it('uploads again when WhatsApp has dropped its copy', async () => {
    const tenant = { id: tenantId, name: 'Video Test Shop', whatsappPhoneNumberId: 'SHOP_NUMBER' };
    waba.uploadMedia.mockClear().mockResolvedValue('MEDIA_2');
    waba.sendVideo.mockClear().mockRejectedValueOnce(new Error('media not found')).mockResolvedValue({ messageId: 'wamid.video2' });

    expect(await service.sendToBuyer(tenant, productId, '+233200000003')).toBe('sent');
    expect(waba.uploadMedia).toHaveBeenCalledTimes(1);
    expect(waba.sendVideo).toHaveBeenLastCalledWith('SHOP_NUMBER', '+233200000003', 'MEDIA_2', expect.any(String));
    expect((await product()).waVideoMediaId).toBe('MEDIA_2');
  });

  it("says unavailable for a product without a live video or a shop without a number, and failed if WhatsApp won't take it", async () => {
    const other = await prisma.product.create({ data: { name: 'Beans', price: 10, tenantId } });
    const tenant = { id: tenantId, name: 'Video Test Shop', whatsappPhoneNumberId: 'SHOP_NUMBER' };
    expect(await service.sendToBuyer(tenant, other.id, '+233200000004')).toBe('unavailable');
    expect(await service.sendToBuyer({ ...tenant, whatsappPhoneNumberId: null }, productId, '+233200000004')).toBe('unavailable');

    await prisma.product.update({ where: { id: productId }, data: { waVideoMediaId: null } });
    waba.uploadMedia.mockRejectedValueOnce(new Error('Meta is down'));
    expect(await service.sendToBuyer(tenant, productId, '+233200000005')).toBe('failed');
    // A failed send doesn't count as sent: trying again isn't blocked.
    waba.uploadMedia.mockResolvedValue('MEDIA_3');
    waba.sendVideo.mockResolvedValue({ messageId: 'x' });
    expect(await service.sendToBuyer(tenant, productId, '+233200000005')).toBe('sent');
  });

  it('lets the vendor take the live video down', async () => {
    await service.removeLive(userId, productId);
    expect((await service.state(userId, productId)).live).toBeNull();
    expect(stored('live', 'mp4')).toBe(false);
    await expect(service.openOwn(userId, productId, 'live', 'video')).rejects.toBeInstanceOf(NotFoundException);
  });

  it("can't touch another shop's product", async () => {
    const other = await prisma.user.create({ data: { email: `videotest-other-${stamp}@example.invalid`, password: 'x', firstName: 'O', lastName: 'T' } });
    await prisma.tenant.create({ data: { name: 'Other', slug: `videotest-other-${stamp}`, userId: other.id } });
    const file = upload();
    await expect(service.upload(other.id, productId, file)).rejects.toBeInstanceOf(NotFoundException);
    expect(existsSync(file.path)).toBe(false);
    await prisma.user.delete({ where: { id: other.id } });
  });

  it('turns uploads away when ffmpeg is missing', async () => {
    (service as any).available = false;
    await expect(service.upload(userId, productId, upload())).rejects.toThrow('aren’t available');
    (service as any).available = true;
  });
});
