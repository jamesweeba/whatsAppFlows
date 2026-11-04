import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bannerState, bannerUrl, ShopBannerService } from './shop-banner.service.js';

const jpeg = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#c0392b' } }).jpeg().toBuffer();
const file = (buffer: Buffer) => ({ buffer, size: buffer.length }) as Express.Multer.File;

describe('ShopBannerService', () => {
  let files: Map<string, Buffer>;
  let shop: any;
  let prisma: any;
  let tenantService: any;
  let service: ShopBannerService;

  beforeEach(() => {
    files = new Map();
    shop = { id: 't1', status: 'ACTIVE', bannerUpdatedAt: null, bannerPendingAt: null, bannerRejectedReason: 'Too blurry' };
    const storage = {
      save: vi.fn(async (key: string, data: Buffer) => void files.set(key, data)),
      readBuffer: vi.fn(async (key: string) => files.get(key) ?? null),
      remove: vi.fn(async (key: string) => void files.delete(key)),
      read: vi.fn(async (key: string) => files.get(key)),
    };
    prisma = {
      tenant: {
        findUnique: vi.fn(async () => shop),
        update: vi.fn(async ({ data }: any) => (shop = { ...shop, ...data })),
      },
    };
    tenantService = {
      findByUser: vi.fn(async () => shop),
      assertEditable: vi.fn((t: any) => {
        if (t.status === 'SUSPENDED') throw new ForbiddenException('suspended');
      }),
    };
    service = new ShopBannerService(prisma, storage as any, tenantService);
  });

  it('keeps an upload pending (not public) and clears the last rejection', async () => {
    const state = await service.upload('u1', file(await jpeg(1200, 400)));
    expect(state).toMatchObject({ url: null, rejectedReason: null });
    expect(state.pendingAt).toBeInstanceOf(Date);
    expect(files.has('banners/t1/pending.jpg')).toBe(true);
    expect(files.has('banners/t1/live.jpg')).toBe(false);
  });

  it('refuses non-images, tiny images and suspended shops', async () => {
    await expect(service.upload('u1', file(Buffer.from('<svg></svg>')))).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.upload('u1', file(await jpeg(1200, 200)))).rejects.toThrow(/300 pixels on each side/);
    shop.status = 'SUSPENDED';
    await expect(service.upload('u1', file(await jpeg(1200, 400)))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('approves only the upload the admin looked at', async () => {
    await service.upload('u1', file(await jpeg(1200, 400)));
    const seen = shop.bannerPendingAt;
    await expect(service.approve(prisma, 't1', new Date(seen.getTime() - 1000))).rejects.toBeInstanceOf(ConflictException);

    const approved = await service.approve(prisma, 't1', seen);
    expect(bannerUrl(approved)).toMatch(/^\/api\/v1\/shops\/t1\/banner\?v=\d+$/);
    expect(approved.bannerPendingAt).toBeNull();
    expect(files.has('banners/t1/live.jpg')).toBe(true);
    expect(files.has('banners/t1/pending.jpg')).toBe(false);
    await expect(service.approve(prisma, 't1', seen)).rejects.toThrow(/no banner waiting/);
  });

  it('rejects with a reason the vendor sees', async () => {
    await service.upload('u1', file(await jpeg(1200, 400)));
    const rejected = await service.reject(prisma, 't1', shop.bannerPendingAt, 'Shows another shop’s name.');
    expect(bannerState(rejected)).toEqual({ url: null, pendingAt: null, rejectedReason: 'Shows another shop’s name.' });
    expect(files.size).toBe(0);
  });

  it('crops the approved banner to a 144×144 square for the order form list', async () => {
    await service.upload('u1', file(await jpeg(1600, 1200)));
    await service.approve(prisma, 't1', shop.bannerPendingAt);
    const base64 = await service.flowThumbnailBase64(shop);
    const meta = await sharp(Buffer.from(base64!, 'base64')).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 144, 144]);
    expect(await service.flowThumbnailBase64({ id: 't1', bannerUpdatedAt: null })).toBeNull();
  });

  it('removes the live banner, and 404s publicly afterwards', async () => {
    await service.upload('u1', file(await jpeg(1200, 400)));
    await service.approve(prisma, 't1', shop.bannerPendingAt);
    await service.flowThumbnailBase64(shop);
    await service.removeLive('u1');
    expect(shop.bannerUpdatedAt).toBeNull();
    expect(files.size).toBe(0);
    await expect(service.openLive('t1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.adminRemove(prisma, 't1')).rejects.toBeInstanceOf(ConflictException);
  });
});
