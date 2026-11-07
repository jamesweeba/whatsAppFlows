/**
 * The vendor's promoter actions against a real Postgres. Opt-in:
 * RUN_DB_TESTS=1 npx vitest run src/promoter/promoter-vendor.db.spec.ts
 * It makes throwaway shops and promoters and deletes them afterwards; WhatsApp is faked.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PromoterMembershipStatus as Status, PromoterStatus, Tenant, TenantStatus } from '@prisma/client';
import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { PromoterVendorService } from './promoter-vendor.service.js';
import { PromoterService } from './promoter.service.js';
import { ReferralService } from './referral.service.js';

describe.skipIf(!process.env.RUN_DB_TESTS)('promoters, vendor side (real database)', () => {
  const prisma = new PrismaService();
  const bot = { tell: vi.fn().mockResolvedValue(undefined), sendLinks: vi.fn().mockResolvedValue(undefined) };
  const promoters = new PromoterService(prisma, { promoterRequested: vi.fn() } as any);
  const service = new PromoterVendorService(prisma, new TenantService(prisma, {} as any), promoters, bot as any, {} as any, new ReferralService(prisma));
  const stamp = Date.now();
  const digits = String(stamp).slice(-7);
  const phone = (n: number) => `+2332${digits}${n}`;
  const userIds: string[] = [];
  let shop: Tenant;
  let otherShop: Tenant;
  let riceId = '';
  let oilId = '';

  const makeShop = async (n: number) => {
    const user = await prisma.user.create({ data: { email: `promovendor-${stamp}-${n}@example.invalid`, password: 'x', firstName: 'V', lastName: 'T' } });
    userIds.push(user.id);
    return prisma.tenant.create({
      data: { name: `Vendor Test Shop ${n}`, slug: `promovendor-${stamp}-${n}`, userId: user.id, status: TenantStatus.ACTIVE, whatsappNumber: `+2335${n}${digits}`, promotionsEnabled: true, promoterRate: 10 },
    });
  };
  /** A signed-up promoter who has asked to promote `shop`. */
  const requester = async (n: number) => {
    const promoter = await prisma.promoter.create({ data: { phone: phone(n), fullName: `Promoter ${n}`, status: PromoterStatus.ACTIVE, signupStep: null } });
    const membership = await prisma.promoterMembership.create({ data: { tenantId: shop.id, promoterId: promoter.id, status: Status.REQUESTED } });
    return { promoter, membership };
  };

  beforeAll(async () => {
    vi.stubEnv('PLATFORM_WHATSAPP_NUMBER', '+233 30 000 0000');
    shop = await makeShop(1);
    otherShop = await makeShop(2);
    riceId = (await prisma.product.create({ data: { name: 'Rice', price: 100, tenantId: shop.id } })).id;
    oilId = (await prisma.product.create({ data: { name: 'Oil', price: 50, tenantId: shop.id } })).id;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.promoter.deleteMany({ where: { phone: { startsWith: `+2332${digits}` } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    bot.tell.mockClear();
    bot.sendLinks.mockClear();
  });

  it('needs a rate before promotions can be turned on', async () => {
    const off = await prisma.tenant.update({ where: { id: otherShop.id }, data: { promotionsEnabled: false, promoterRate: null } });
    await expect(service.updateSettings(off, { promotionsEnabled: true })).rejects.toBeInstanceOf(BadRequestException);
    const on = await service.updateSettings(off, { promotionsEnabled: true, promoterRate: 15, acceptPromoterRequests: false });
    expect(on).toMatchObject({ promotionsEnabled: true, promoterRate: 15, acceptPromoterRequests: false, platformCommissionPercent: 10, maxRate: 20 });
  });

  it('approves a request for chosen products and sends the promoter their links', async () => {
    const { promoter, membership } = await requester(1);
    const row = await service.approve(shop, membership.id, [riceId, oilId]);

    expect(row.status).toBe(Status.APPROVED);
    expect(row.links.map((l) => l.productName).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(['Oil', 'Rice']);
    expect(row.promoter).toMatchObject({ fullName: 'Promoter 1', phone: `02${digits}1`, momoVerified: false });
    await vi.waitFor(() => expect(bot.sendLinks).toHaveBeenCalledWith(expect.objectContaining({ id: promoter.id }), shop.id));
    await expect(service.approve(shop, membership.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('declines a request and tells the promoter', async () => {
    const { membership } = await requester(2);
    expect((await service.decline(shop, membership.id)).status).toBe(Status.DECLINED);
    expect(bot.tell).toHaveBeenCalledWith(phone(2), expect.stringContaining('not to take on'));
  });

  it("refuses products from another shop and another shop's promoters", async () => {
    const { membership } = await requester(3);
    const foreign = await prisma.product.create({ data: { name: 'Yam', price: 20, tenantId: otherShop.id } });
    await expect(service.approve(shop, membership.id, [foreign.id])).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.approve(otherShop, membership.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('makes an invite with a join link, and reuses it when inviting the same number again', async () => {
    const first = await service.invite(shop, '024 000 0001');
    expect(first.status).toBe(Status.INVITED);
    expect(first.invite).toMatchObject({ phone: '0240000001', productIds: [] });
    expect(first.invite?.joinLink).toBe(`https://wa.me/233300000000?text=JOIN%20${first.invite?.code}`);
    expect(first.invite?.message).toContain('Vendor Test Shop 1');

    const again = await service.invite(shop, '+233240000001', [riceId]);
    expect(again.id).toBe(first.id);
    expect(again.invite).toMatchObject({ code: first.invite?.code, productIds: [riceId] });

    await service.cancelInvite(shop, first.id);
    await expect(service.cancelInvite(shop, first.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('approves straight away when inviting someone who already asked', async () => {
    const { membership } = await requester(4);
    const row = await service.invite(shop, phone(4), [riceId]);
    expect(row).toMatchObject({ id: membership.id, status: Status.APPROVED });
    await expect(service.invite(shop, phone(4))).rejects.toBeInstanceOf(ConflictException);
  });

  it('adds and removes links, then removes the promoter and turns their links off', async () => {
    const { membership } = await requester(5);
    await service.approve(shop, membership.id); // whole shop
    const withRice = await service.addLink(shop, membership.id, riceId);
    expect(withRice.links.map((l) => l.productName)).toEqual([null, 'Rice']);
    await vi.waitFor(() => expect(bot.sendLinks).toHaveBeenLastCalledWith(expect.anything(), shop.id, [withRice.links[1].code]));
    await expect(service.addLink(shop, membership.id)).rejects.toThrow('already have that link');

    await service.removeLink(shop, withRice.links[1].id);
    await expect(service.removeLink(shop, withRice.links[1].id)).rejects.toBeInstanceOf(NotFoundException);

    const removed = await service.remove(shop, membership.id);
    expect(removed).toMatchObject({ status: Status.REMOVED, links: [] });
    expect(bot.tell).toHaveBeenLastCalledWith(phone(5), expect.stringContaining('already earned will still be paid'));
  });

  it('lists by status', async () => {
    const requested = await service.list(shop, Status.REQUESTED);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((row) => row.status === Status.REQUESTED)).toBe(true);
  });
});
