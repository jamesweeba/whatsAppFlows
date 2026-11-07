/**
 * Product videos (whole product and per measure) against a real Postgres and the real ffmpeg,
 * with files in a throwaway folder. Opt-in: RUN_DB_TESTS=1 npx vitest run src/product/product-video.db.spec.ts
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
  const tenant = () => ({ id: tenantId, name: 'Video Test Shop', whatsappPhoneNumberId: 'SHOP_NUMBER' });

  /** What multer hands over: a temp file of its own (the service deletes it when done). */
  const upload = (source = clip) => {
    const path = join(clipsDir, `upload-${Math.random().toString(36).slice(2)}`);
    copyFileSync(source, path);
    return { path, size: 1000 } as Express.Multer.File;
  };
  const row = (measureCode = '') => prisma.productVideo.findUnique({ where: { productId_measureCode: { productId, measureCode } } });
  const stored = (path: string) => existsSync(join(storageDir, `videos/${tenantId}/${productId}/${path}`));
  beforeAll(async () => {
    vi.stubEnv('UPLOAD_DIR', storageDir);
    service = new ProductVideoService(prisma, new StorageService(), new TenantService(prisma, {} as any), waba as any);
    await service.onModuleInit();
    clip = join(clipsDir, 'clip.mov');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=3', '-c:v', 'mpeg4', clip]);

    const user = await prisma.user.create({ data: { email: `videotest-${stamp}@example.invalid`, password: 'x', firstName: 'V', lastName: 'T' } });
    userId = user.id;
    tenantId = (await prisma.tenant.create({ data: { name: 'Video Test Shop', slug: `videotest-${stamp}`, userId, status: TenantStatus.ACTIVE } })).id;
    productId = (
      await prisma.product.create({
        data: {
          name: 'Tomatoes',
          price: 10,
          tenantId,
          measures: { create: [{ code: 'olonka', label: 'Olonka', price: 25, sortOrder: 0 }, { code: 'table_top', label: 'Table top', price: 10, sortOrder: 1 }] },
        },
      })
    ).id;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
    rmSync(storageDir, { recursive: true, force: true });
    rmSync(clipsDir, { recursive: true, force: true });
  });

  it('converts a whole-product upload in the background, then it waits for an admin', async () => {
    const file = upload();
    expect(await service.upload(userId, productId, '', file)).toMatchObject({ status: Status.PROCESSING, live: null, pending: null });
    await service.whenIdle();

    const state = await service.state(userId, productId);
    expect(state.status).toBe(Status.PENDING);
    expect(state.pending).toMatchObject({ seconds: 3, trimmed: false, url: `/api/v1/products/${productId}/video/pending` });
    expect(stored('pending.mp4') && stored('pending.jpg')).toBe(true);
    expect(existsSync(file.path)).toBe(false); // the temp upload is cleaned up
  });

  it('keeps a separate video per measure, with its own files and URLs', async () => {
    await service.upload(userId, productId, 'olonka', upload());
    await service.whenIdle();
    const state = await service.state(userId, productId, 'olonka');
    expect(state.pending?.url).toBe(`/api/v1/products/${productId}/video/pending?measure=olonka`);
    expect(stored('m-olonka/pending.mp4')).toBe(true);
    expect((await service.openOwn(userId, productId, 'olonka', 'pending', 'video')).mimeType).toBe('video/mp4');

    const overview = await service.overview(userId, productId);
    expect(overview.product.status).toBe(Status.PENDING);
    expect(overview.measures).toEqual([
      expect.objectContaining({ code: 'olonka', label: 'Olonka', video: expect.objectContaining({ status: Status.PENDING }) }),
      expect.objectContaining({ code: 'table_top', label: 'Table top', video: expect.objectContaining({ status: Status.NONE, live: null }) }),
    ]);
  });

  it("turns away a measure the product doesn't have", async () => {
    const file = upload();
    await expect(service.upload(userId, productId, 'bucket', file)).rejects.toBeInstanceOf(NotFoundException);
    expect(existsSync(file.path)).toBe(false);
  });

  it("refuses to approve an upload the admin didn't see, then approves the right one", async () => {
    await expect(prisma.$transaction((tx) => service.approve(tx, productId, '', new Date(0)))).rejects.toBeInstanceOf(ConflictException);
    const { uploadedAt } = (await row())!;
    await prisma.$transaction((tx) => service.approve(tx, productId, '', uploadedAt!));
    expect(await service.state(userId, productId)).toMatchObject({ status: Status.NONE, pending: null, live: { seconds: 3 } });
    expect(stored('live.mp4') && !stored('pending.mp4')).toBe(true);
  });

  it("picks the chosen measure's video for buyers, or else the whole product's", async () => {
    expect((await service.liveVideoFor(productId, 'olonka'))?.measureCode).toBe(''); // olonka's isn't approved yet
    const { uploadedAt } = (await row('olonka'))!;
    await prisma.$transaction((tx) => service.approve(tx, productId, 'olonka', uploadedAt!));

    expect((await service.liveVideoFor(productId, 'olonka'))?.measureCode).toBe('olonka');
    expect((await service.liveVideoFor(productId, 'table_top'))?.measureCode).toBe('');
    expect((await service.liveVideoFor(productId, null))?.measureCode).toBe('');
  });

  it("sends a measure's video: uploads to WhatsApp once, then reuses it", async () => {
    waba.uploadMedia.mockResolvedValue('MEDIA_OLONKA');
    waba.sendVideo.mockResolvedValue({ messageId: 'wamid.video' });
    const video = (await service.liveVideoFor(productId, 'olonka'))!;

    expect(await service.sendToBuyer(tenant(), video, '+233200000001', 'Tomatoes · Olonka')).toBe('sent');
    expect(waba.uploadMedia).toHaveBeenCalledWith('SHOP_NUMBER', expect.any(Buffer), 'video/mp4', `${video.id}.mp4`);
    expect(waba.sendVideo).toHaveBeenCalledWith('SHOP_NUMBER', '+233200000001', 'MEDIA_OLONKA', expect.stringContaining('Tomatoes · Olonka from Video Test Shop'));
    expect((await row('olonka'))!.waMediaId).toBe('MEDIA_OLONKA');

    // The same buyer tapping again straight away gets nothing more; another buyer reuses the upload.
    expect(await service.sendToBuyer(tenant(), video, '+233200000001', 'Tomatoes · Olonka')).toBe('too_soon');
    const reloaded = (await service.liveVideoFor(productId, 'olonka'))!;
    expect(await service.sendToBuyer(tenant(), reloaded, '+233200000002', 'Tomatoes · Olonka')).toBe('sent');
    expect(waba.uploadMedia).toHaveBeenCalledTimes(1);
  });

  it('uploads again when WhatsApp has dropped its copy, and reports failures without blocking a retry', async () => {
    waba.uploadMedia.mockClear().mockResolvedValue('MEDIA_2');
    waba.sendVideo.mockClear().mockRejectedValueOnce(new Error('media not found')).mockResolvedValue({ messageId: 'x' });
    const video = (await service.liveVideoFor(productId, 'olonka'))!;
    expect(await service.sendToBuyer(tenant(), video, '+233200000003', 'Tomatoes · Olonka')).toBe('sent');
    expect(waba.sendVideo).toHaveBeenLastCalledWith('SHOP_NUMBER', '+233200000003', 'MEDIA_2', expect.any(String));

    const whole = (await service.liveVideoFor(productId, null))!;
    waba.uploadMedia.mockRejectedValueOnce(new Error('Meta is down'));
    expect(await service.sendToBuyer(tenant(), whole, '+233200000004', 'Tomatoes')).toBe('failed');
    waba.uploadMedia.mockResolvedValue('MEDIA_3');
    expect(await service.sendToBuyer(tenant(), whole, '+233200000004', 'Tomatoes')).toBe('sent');
    expect(await service.sendToBuyer({ ...tenant(), whatsappPhoneNumberId: null }, whole, '+233200000005', 'Tomatoes')).toBe('unavailable');
  });

  it('keeps the live video while a replacement waits; rejection carries a reason', async () => {
    await service.upload(userId, productId, '', upload());
    await service.whenIdle();
    const { uploadedAt } = (await row())!;
    await prisma.$transaction((tx) => service.reject(tx, productId, '', uploadedAt!, 'The video is blurry.'));
    expect(await service.state(userId, productId)).toMatchObject({ status: Status.REJECTED, message: 'The video is blurry.', live: { seconds: 3 } });
  });

  it('marks a file that is not a video as failed, with a message for the vendor', async () => {
    const fake = join(clipsDir, 'fake.mp4');
    writeFileSync(fake, 'not a video');
    await service.upload(userId, productId, 'table_top', upload(fake));
    await service.whenIdle();
    const state = await service.state(userId, productId, 'table_top');
    expect(state.status).toBe(Status.FAILED);
    expect(state.message).toContain('isn’t a video');
  });

  it('drops a conversion whose upload was cancelled meanwhile', async () => {
    await service.upload(userId, productId, 'table_top', upload());
    await service.cancelPending(userId, productId, 'table_top'); // before the queue gets to it
    await service.whenIdle();
    expect((await row('table_top'))!.status).toBe(Status.NONE);
    expect(stored('m-table_top/pending.mp4')).toBe(false);
  });

  it('marks conversions interrupted by a restart as failed', async () => {
    await prisma.productVideo.update({ where: { productId_measureCode: { productId, measureCode: 'table_top' } }, data: { status: Status.PROCESSING, uploadedAt: new Date() } });
    await service.onModuleInit();
    expect(await row('table_top')).toMatchObject({ status: Status.FAILED, message: expect.stringContaining('interrupted') });
  });

  it('removes the video of a measure the vendor deleted, and keeps the others', async () => {
    await service.pruneMeasures({ id: productId, tenantId }, ['table_top']); // olonka was deleted
    expect(await row('olonka')).toBeNull();
    expect(stored('m-olonka/live.mp4')).toBe(false);
    expect(await row('table_top')).not.toBeNull();
    expect((await row(''))?.approvedAt).not.toBeNull(); // the whole-product video stays
  });

  it('lets the vendor take the live video down', async () => {
    await service.removeLive(userId, productId);
    expect((await service.state(userId, productId)).live).toBeNull();
    expect(stored('live.mp4')).toBe(false);
    await expect(service.openOwn(userId, productId, '', 'live', 'video')).rejects.toBeInstanceOf(NotFoundException);
  });

  it("can't touch another shop's product", async () => {
    const other = await prisma.user.create({ data: { email: `videotest-other-${stamp}@example.invalid`, password: 'x', firstName: 'O', lastName: 'T' } });
    await prisma.tenant.create({ data: { name: 'Other', slug: `videotest-other-${stamp}`, userId: other.id } });
    const file = upload();
    await expect(service.upload(other.id, productId, '', file)).rejects.toBeInstanceOf(NotFoundException);
    expect(existsSync(file.path)).toBe(false);
    await prisma.user.delete({ where: { id: other.id } });
  });

  it('turns uploads away when ffmpeg is missing', async () => {
    (service as any).available = false;
    await expect(service.upload(userId, productId, '', upload())).rejects.toThrow('aren’t available');
    (service as any).available = true;
  });

  it('deletes every video file of a deleted product', async () => {
    await service.removeFiles({ id: productId, tenantId });
    expect(existsSync(join(storageDir, `videos/${tenantId}/${productId}`))).toBe(false);
  });
});
