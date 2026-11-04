import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { photoUrl, ProductPhotoService, sniffImageType } from './product-photo.service.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

const file = (buffer: Buffer, mimetype = 'image/jpeg') => ({ buffer, size: buffer.length, mimetype, originalname: 'x.jpg' }) as Express.Multer.File;

describe('sniffImageType', () => {
  it('reads the type from the bytes', () => {
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(WEBP)).toBe('image/webp');
  });

  it('refuses anything else, whatever its name or claimed type', () => {
    expect(sniffImageType(HTML)).toBeNull();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('photoUrl', () => {
  it('is versioned by the upload time, and null without a photo', () => {
    expect(photoUrl({ id: 'p1', photoUpdatedAt: new Date(1700000000000) })).toBe('/api/v1/products/p1/photo?v=1700000000000');
    expect(photoUrl({ id: 'p1', photoUpdatedAt: null })).toBeNull();
  });
});

describe('ProductPhotoService', () => {
  let service: ProductPhotoService;
  let prisma: any;
  let storage: any;
  let tenantService: any;

  beforeEach(() => {
    prisma = {
      product: {
        findFirst: vi.fn(async ({ where }: any) => (where.id === 'p1' && where.tenantId === 'tenant-1' ? { id: 'p1', tenantId: 'tenant-1' } : null)),
        findUnique: vi.fn(),
        update: vi.fn(async ({ data }: any) => ({ id: 'p1', tenantId: 'tenant-1', ...data })),
      },
    };
    storage = { save: vi.fn(), remove: vi.fn(), read: vi.fn().mockResolvedValue('stream') };
    tenantService = {
      findByUser: vi.fn().mockResolvedValue({ id: 'tenant-1', status: 'ACTIVE' }),
      assertEditable: vi.fn((tenant: any) => {
        if (tenant.status === 'SUSPENDED') throw new ForbiddenException('suspended');
      }),
    };
    service = new ProductPhotoService(prisma, storage, tenantService);
  });

  it('stores the photo under the product and returns its versioned URL', async () => {
    const result = await service.upload('user-1', 'p1', file(PNG, 'image/jpeg'));
    expect(storage.save).toHaveBeenCalledWith('products/tenant-1/p1', PNG);
    // The sniffed type wins over the claimed one.
    expect(prisma.product.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ photoMimeType: 'image/png' }) }),
    );
    expect(result.photoUrl).toMatch(/^\/api\/v1\/products\/p1\/photo\?v=\d+$/);
  });

  it('rejects a file that is not a real image', async () => {
    await expect(service.upload('user-1', 'p1', file(HTML, 'image/jpeg'))).rejects.toThrow(BadRequestException);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('rejects a photo over 5 MB', async () => {
    const big = { ...file(JPEG), size: 5 * 1024 * 1024 + 1 } as Express.Multer.File;
    await expect(service.upload('user-1', 'p1', big)).rejects.toThrow('Photos must be 5 MB or smaller.');
  });

  it("refuses another shop's product", async () => {
    await expect(service.upload('user-1', 'p2', file(JPEG))).rejects.toThrow(NotFoundException);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('refuses changes while the shop is suspended', async () => {
    tenantService.findByUser.mockResolvedValue({ id: 'tenant-1', status: 'SUSPENDED' });
    await expect(service.upload('user-1', 'p1', file(JPEG))).rejects.toThrow(ForbiddenException);
    await expect(service.remove('user-1', 'p1')).rejects.toThrow(ForbiddenException);
  });

  it('removes the photo and its file', async () => {
    await expect(service.remove('user-1', 'p1')).resolves.toEqual({ photoUrl: null });
    expect(prisma.product.update).toHaveBeenCalledWith(expect.objectContaining({ data: { photoMimeType: null, photoUpdatedAt: null } }));
    expect(storage.remove).toHaveBeenCalledWith('products/tenant-1/p1');
  });

  it('serves a photo to anyone, and 404s when there is none', async () => {
    prisma.product.findUnique.mockResolvedValueOnce({ id: 'p1', tenantId: 'tenant-1', photoMimeType: 'image/webp' });
    await expect(service.open('p1')).resolves.toEqual({ mimeType: 'image/webp', stream: 'stream' });
    expect(storage.read).toHaveBeenCalledWith('products/tenant-1/p1');

    prisma.product.findUnique.mockResolvedValueOnce({ id: 'p1', tenantId: 'tenant-1', photoMimeType: null });
    await expect(service.open('p1')).rejects.toThrow(NotFoundException);
  });
});
