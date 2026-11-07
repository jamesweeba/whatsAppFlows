/**
 * Promoter memberships and links against a real Postgres (transactions and partial unique
 * indexes can't be faked). Opt-in: RUN_DB_TESTS=1 npx vitest run src/promoter/promoter.db.spec.ts
 * It makes a throwaway shop and promoters and deletes them afterwards.
 */
import { Prisma, PromoterMembershipStatus as Status, PromoterStatus, TenantStatus } from '@prisma/client';
import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { PromoterService } from './promoter.service.js';

describe.skipIf(!process.env.RUN_DB_TESTS)('promoters (real database)', () => {
  const prisma = new PrismaService();
  const notifications = { promoterRequested: vi.fn() };
  const service = new PromoterService(prisma, notifications as any);
  const stamp = Date.now();
  const phone = (n: number) => `+2332${String(stamp).slice(-7)}${n}`;
  let userId = '';
  let tenantId = '';
  let riceId = '';
  let oilId = '';

  const newPromoter = (n: number) =>
    prisma.promoter.create({ data: { phone: phone(n), fullName: `Promoter ${n}`, status: PromoterStatus.ACTIVE, signupStep: null } });
  const invite = (invitedPhone: string, productIds: string[] = []) =>
    prisma.promoterMembership.create({
      data: { tenantId, status: Status.INVITED, invitedPhone, inviteCode: `T${String(++inviteN).padStart(5, '0')}`, inviteProductIds: productIds },
    });
  let inviteN = stamp % 90000;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { email: `promotest-${stamp}@example.invalid`, password: 'x', firstName: 'Promo', lastName: 'Test' } });
    userId = user.id;
    const tenant = await prisma.tenant.create({
      data: {
        name: 'Promoter Test Shop',
        slug: `promotest-${stamp}`,
        userId,
        status: TenantStatus.ACTIVE,
        whatsappNumber: `+23350${String(stamp).slice(-7)}`,
        promotionsEnabled: true,
        promoterRate: 10,
      },
    });
    tenantId = tenant.id;
    riceId = (await prisma.product.create({ data: { name: 'Rice', price: 100, tenantId } })).id;
    oilId = (await prisma.product.create({ data: { name: 'Oil', price: 50, tenantId } })).id;
  });

  afterAll(async () => {
    await prisma.promoter.deleteMany({ where: { phone: { startsWith: phone(0).slice(0, -1) } } });
    await prisma.user.delete({ where: { id: userId } }); // cascades to the shop, products, memberships and links
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { acceptPromoterRequests: true, promotionsEnabled: true } });
    notifications.promoterRequested.mockClear();
  });

  it('lists the shop while it takes requests', async () => {
    const listed = async () => {
      const shops: { id: string }[] = [];
      for (let page = 0; ; page++) {
        const result = await service.openShops(page);
        shops.push(...result.shops);
        if (!result.hasMore) return shops.some((s) => s.id === tenantId);
      }
    };
    expect(await listed()).toBe(true);
    await prisma.tenant.update({ where: { id: tenantId }, data: { acceptPromoterRequests: false } });
    expect(await listed()).toBe(false);
  });

  it('records a request once and tells the vendor', async () => {
    const promoter = await newPromoter(1);
    expect(await service.requestToJoin(promoter, tenantId)).toEqual({ kind: 'requested', shopName: 'Promoter Test Shop' });
    expect(await service.requestToJoin(promoter, tenantId)).toEqual({ kind: 'already_requested', shopName: 'Promoter Test Shop' });
    expect(notifications.promoterRequested).toHaveBeenCalledTimes(1);
  });

  it('refuses requests when the shop stops taking them', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { acceptPromoterRequests: false } });
    expect(await service.requestToJoin(await newPromoter(2), tenantId)).toEqual({ kind: 'closed' });
  });

  it('accepts an invite only from the invited number, with links for the chosen products', async () => {
    const promoter = await newPromoter(3);
    const stranger = await newPromoter(4);
    const { inviteCode } = await invite(promoter.phone, [riceId, oilId]);

    expect(await service.acceptInvite(stranger, inviteCode!)).toEqual({ kind: 'wrong_number' });
    expect(await service.acceptInvite(promoter, inviteCode!.toLowerCase())).toEqual({ kind: 'approved', shopName: 'Promoter Test Shop', tenantId });
    expect(await service.acceptInvite(promoter, inviteCode!)).toEqual({ kind: 'invalid_invite' }); // used up

    const links = await service.activeLinks(promoter.id);
    expect(links.map((l) => l.product?.name).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(['Oil', 'Rice']);
    expect(links.every((l) => /^[A-HJKMNP-Z2-9]{6}$/.test(l.code))).toBe(true);
  });

  it('turns an earlier request into an approval when the vendor invites the same person', async () => {
    const promoter = await newPromoter(5);
    await service.requestToJoin(promoter, tenantId);
    await invite(promoter.phone);

    // Asking again while invited accepts the invite.
    expect(await service.requestToJoin(promoter, tenantId)).toMatchObject({ kind: 'approved' });
    const memberships = await prisma.promoterMembership.findMany({ where: { tenantId, OR: [{ promoterId: promoter.id }, { invitedPhone: promoter.phone }] } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].status).toBe(Status.APPROVED);
    expect((await service.activeLinks(promoter.id)).map((l) => l.productId)).toEqual([null]);
    expect(await service.requestToJoin(promoter, tenantId)).toMatchObject({ kind: 'already_approved' });
  });

  it('keeps one active link per product, enforced by the database too', async () => {
    const promoter = await newPromoter(6);
    const { inviteCode } = await invite(promoter.phone);
    await service.acceptInvite(promoter, inviteCode!);
    const membership = await prisma.promoterMembership.findFirstOrThrow({ where: { tenantId, promoterId: promoter.id } });
    const m = { id: membership.id, tenantId, promoterId: promoter.id };

    await prisma.$transaction((tx) => service.ensureLinks(tx, m, []));
    expect(await prisma.promoLink.count({ where: { membershipId: m.id, active: true } })).toBe(1);

    const duplicate = prisma.promoLink.create({ data: { code: 'ZZZZZ9', membershipId: m.id, tenantId, promoterId: promoter.id } });
    await expect(duplicate).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('hides links while the shop has promotions off', async () => {
    const promoter = await newPromoter(7);
    const { inviteCode } = await invite(promoter.phone);
    await service.acceptInvite(promoter, inviteCode!);
    await prisma.tenant.update({ where: { id: tenantId }, data: { promotionsEnabled: false } });
    expect(await service.activeLinks(promoter.id)).toEqual([]);
  });
});
