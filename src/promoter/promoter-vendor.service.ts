import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, PromoterMembershipStatus as Status, PromoterStatus, Tenant } from '@prisma/client';
import { optionalEnv } from '../common/config.js';
import { isGhanaMobile, toE164, toGhanaLocal, toInternationalDigits } from '../common/phone.util.js';
import { COMMISSION_PERCENT } from '../payout/payout-math.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isLive, TenantService } from '../tenant/tenant.service.js';
import { WabaService } from '../waba/waba.service.js';
import { PromoterBotService } from './promoter-bot.service.js';
import { newCode, PROMOTER_RATE_MAX, PROMOTER_RATE_MIN } from './promoter-rules.js';
import { PromoterService } from './promoter.service.js';
import { PromoterStats, ReferralService } from './referral.service.js';

export interface PromotionSettingsInput {
  promotionsEnabled?: boolean;
  acceptPromoterRequests?: boolean;
  promoterRate?: number | null;
}

const MEMBERSHIP_INCLUDE = {
  promoter: true,
  links: { where: { active: true }, include: { product: { select: { name: true } } }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.PromoterMembershipInclude;

type MembershipWithLinks = Prisma.PromoterMembershipGetPayload<{ include: typeof MEMBERSHIP_INCLUDE }>;

/** The vendor's side of promoters: settings, requests, invites, links. Everything is scoped to the vendor's shop. */
@Injectable()
export class PromoterVendorService {
  private readonly logger = new Logger(PromoterVendorService.name);
  /** The platform number as people dial it, looked up from Meta once. */
  private platformNumber: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantService,
    private readonly promoters: PromoterService,
    private readonly bot: PromoterBotService,
    private readonly waba: WabaService,
    private readonly referrals: ReferralService,
  ) {}

  // ───────────────────────── Settings ─────────────────────────

  settings(tenant: Tenant) {
    return {
      promotionsEnabled: tenant.promotionsEnabled,
      acceptPromoterRequests: tenant.acceptPromoterRequests,
      promoterRate: tenant.promoterRate,
      /** MarketiX's own commission, which the vendor pays as well. */
      platformCommissionPercent: COMMISSION_PERCENT,
      minRate: PROMOTER_RATE_MIN,
      maxRate: PROMOTER_RATE_MAX,
      /** Promoters only see shops that are live. */
      shopLive: isLive(tenant),
    };
  }

  async updateSettings(tenant: Tenant, input: PromotionSettingsInput) {
    this.tenants.assertEditable(tenant);
    const rate = input.promoterRate !== undefined ? input.promoterRate : tenant.promoterRate;
    const enabled = input.promotionsEnabled ?? tenant.promotionsEnabled;
    if (enabled && !rate) throw new BadRequestException('Set a commission rate before turning promotions on.');

    const updated = await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        ...(input.promotionsEnabled !== undefined && { promotionsEnabled: input.promotionsEnabled }),
        ...(input.acceptPromoterRequests !== undefined && { acceptPromoterRequests: input.acceptPromoterRequests }),
        ...(input.promoterRate !== undefined && { promoterRate: input.promoterRate }),
      },
    });
    return this.settings(updated);
  }

  // ───────────────────────── Promoters ─────────────────────────

  /** Requests, invites and promoters, newest first. Declined and removed ones too, so the vendor can invite them back. */
  async list(tenant: Tenant, status?: Status) {
    const memberships = await this.prisma.promoterMembership.findMany({
      where: { tenantId: tenant.id, ...(status && { status }) },
      include: MEMBERSHIP_INCLUDE,
      orderBy: { requestedAt: 'desc' },
    });
    const platformNumber = memberships.some((m) => m.status === Status.INVITED) ? await this.platformDisplayNumber() : null;
    const stats = await this.referrals.statsForShop(tenant.id);
    return memberships.map((m) => this.toRow(tenant, m, platformNumber, stats));
  }

  /** Orders credited to promoters, newest first. */
  sales(tenant: Tenant, page: number, limit: number) {
    return this.referrals.salesForShop(tenant.id, { page, limit });
  }

  /** Approve a request for the whole shop (no products) or for chosen products. The promoter gets their links on WhatsApp. */
  async approve(tenant: Tenant, membershipId: string, productIds: string[] = []) {
    this.tenants.assertEditable(tenant);
    const membership = await this.membership(tenant, membershipId);
    if (membership.status !== Status.REQUESTED) throw new ConflictException('This request has already been answered.');
    const promoter = membership.promoter;
    if (!promoter || promoter.status !== PromoterStatus.ACTIVE) throw new ConflictException("This promoter's account is paused, so they can't be approved.");
    await this.assertOwnProducts(tenant, productIds);

    await this.prisma.$transaction(async (tx) => {
      await tx.promoterMembership.update({ where: { id: membership.id }, data: { status: Status.APPROVED, decidedAt: new Date() } });
      await this.promoters.ensureLinks(tx, { id: membership.id, tenantId: tenant.id, promoterId: promoter.id }, productIds);
    });
    this.logger.log(`${tenant.name} approved promoter ${promoter.id}.`);
    void this.bot.tell(promoter.phone, `🎉 *${tenant.name}* has approved you as a promoter!`).then(() => this.bot.sendLinks(promoter, tenant.id));
    return this.row(tenant, membership.id);
  }

  async decline(tenant: Tenant, membershipId: string) {
    this.tenants.assertEditable(tenant);
    const membership = await this.membership(tenant, membershipId);
    if (membership.status !== Status.REQUESTED) throw new ConflictException('This request has already been answered.');
    await this.prisma.promoterMembership.update({ where: { id: membership.id }, data: { status: Status.DECLINED, decidedAt: new Date() } });
    if (membership.promoter) {
      void this.bot.tell(membership.promoter.phone, `*${tenant.name}* has decided not to take on new promoters for now. Send *SHOPS* to find other shops.`);
    }
    return this.row(tenant, membership.id);
  }

  /**
   * Invite a phone number to promote the whole shop or chosen products. Returns the join link
   * for the vendor to send them. Someone who already asked to join is simply approved.
   */
  async invite(tenant: Tenant, phoneInput: string, productIds: string[] = []) {
    this.tenants.assertEditable(tenant);
    if (!isGhanaMobile(phoneInput)) throw new BadRequestException('Enter a Ghana phone number, e.g. 0244111222.');
    const phone = toE164(toGhanaLocal(phoneInput));
    await this.assertOwnProducts(tenant, productIds);

    const promoter = await this.prisma.promoter.findUnique({ where: { phone } });
    if (promoter) {
      const existing = await this.prisma.promoterMembership.findUnique({ where: { tenantId_promoterId: { tenantId: tenant.id, promoterId: promoter.id } } });
      if (existing?.status === Status.APPROVED) throw new ConflictException('This person already promotes your shop. Add links to them instead.');
      if (existing?.status === Status.REQUESTED) return this.approve(tenant, existing.id, productIds);
    }

    const open = await this.prisma.promoterMembership.findFirst({ where: { tenantId: tenant.id, status: Status.INVITED, invitedPhone: phone } });
    const membership = open
      ? await this.prisma.promoterMembership.update({ where: { id: open.id }, data: { inviteProductIds: productIds } })
      : await this.prisma.promoterMembership.create({
          data: { tenantId: tenant.id, status: Status.INVITED, invitedPhone: phone, inviteCode: newCode(), inviteProductIds: productIds },
        });
    return this.row(tenant, membership.id);
  }

  async cancelInvite(tenant: Tenant, membershipId: string) {
    this.tenants.assertEditable(tenant);
    const membership = await this.membership(tenant, membershipId);
    if (membership.status !== Status.INVITED) throw new ConflictException('This invite has already been accepted or cancelled.');
    await this.prisma.promoterMembership.delete({ where: { id: membership.id } });
  }

  /** Give an approved promoter another link: the whole shop (no product) or one product. */
  async addLink(tenant: Tenant, membershipId: string, productId?: string) {
    this.tenants.assertEditable(tenant);
    const membership = await this.membership(tenant, membershipId);
    const promoter = membership.promoter;
    if (membership.status !== Status.APPROVED || !promoter) throw new ConflictException('Only approved promoters can have links.');
    await this.assertOwnProducts(tenant, productId ? [productId] : []);

    const codes = await this.prisma.$transaction((tx) =>
      this.promoters.ensureLinks(tx, { id: membership.id, tenantId: tenant.id, promoterId: promoter.id }, productId ? [productId] : []),
    );
    if (!codes.length) throw new ConflictException('They already have that link.');
    void this.bot.tell(promoter.phone, `*${tenant.name}* gave you a new link to share 👇`).then(() => this.bot.sendLinks(promoter, tenant.id, codes));
    return this.row(tenant, membership.id);
  }

  /** Turn one link off. Buyers who already tapped it still count for the promoter until their 14 days end. */
  async removeLink(tenant: Tenant, linkId: string) {
    this.tenants.assertEditable(tenant);
    const { count } = await this.prisma.promoLink.updateMany({ where: { id: linkId, tenantId: tenant.id, active: true }, data: { active: false } });
    if (!count) throw new NotFoundException('That link was not found, or is already off.');
  }

  /** Stop working with a promoter: their links go off. Commission they already earned is still paid. */
  async remove(tenant: Tenant, membershipId: string) {
    this.tenants.assertEditable(tenant);
    const membership = await this.membership(tenant, membershipId);
    if (membership.status !== Status.APPROVED) throw new ConflictException('Only approved promoters can be removed.');
    await this.prisma.$transaction([
      this.prisma.promoterMembership.update({ where: { id: membership.id }, data: { status: Status.REMOVED, removedAt: new Date() } }),
      this.prisma.promoLink.updateMany({ where: { membershipId: membership.id, active: true }, data: { active: false } }),
    ]);
    if (membership.promoter) {
      void this.bot.tell(
        membership.promoter.phone,
        `*${tenant.name}* has stopped working with you as a promoter, so your links for them no longer work. Commission you've already earned will still be paid.`,
      );
    }
    return this.row(tenant, membership.id);
  }

  // ───────────────────────── Helpers ─────────────────────────

  private async membership(tenant: Tenant, id: string) {
    const membership = await this.prisma.promoterMembership.findFirst({ where: { id, tenantId: tenant.id }, include: MEMBERSHIP_INCLUDE });
    if (!membership) throw new NotFoundException('Promoter not found.');
    return membership;
  }

  private async row(tenant: Tenant, id: string) {
    const membership = await this.membership(tenant, id);
    const platformNumber = membership.status === Status.INVITED ? await this.platformDisplayNumber() : null;
    return this.toRow(tenant, membership, platformNumber, await this.referrals.statsForShop(tenant.id));
  }

  private async assertOwnProducts(tenant: Tenant, productIds: string[]) {
    if (!productIds.length) return;
    const found = await this.prisma.product.count({ where: { id: { in: productIds }, tenantId: tenant.id } });
    if (found !== new Set(productIds).size) throw new BadRequestException('Some of those products are not in your shop.');
  }

  private toRow(tenant: Tenant, m: MembershipWithLinks, platformNumber: string | null, stats: Map<string, PromoterStats>) {
    const joinLink =
      m.status === Status.INVITED && m.inviteCode && platformNumber
        ? `https://wa.me/${toInternationalDigits(platformNumber)}?text=${encodeURIComponent(`JOIN ${m.inviteCode}`)}`
        : null;
    return {
      id: m.id,
      status: m.status,
      requestedAt: m.requestedAt,
      decidedAt: m.decidedAt,
      removedAt: m.removedAt,
      promoter: m.promoter && {
        id: m.promoter.id,
        fullName: m.promoter.fullName,
        phone: toGhanaLocal(m.promoter.phone),
        momoName: m.promoter.momoName,
        momoVerified: Boolean(m.promoter.momoVerifiedAt),
      },
      invite:
        m.status === Status.INVITED
          ? {
              phone: toGhanaLocal(m.invitedPhone ?? ''),
              code: m.inviteCode,
              productIds: m.inviteProductIds,
              joinLink,
              /** Ready for the vendor to send from their own WhatsApp. */
              message: joinLink
                ? `Hi! I'd like you to promote *${tenant.name}* on WhatsApp. You earn ${tenant.promoterRate ?? '?'}% when a new customer orders through your link. Tap to join: ${joinLink}`
                : null,
            }
          : null,
      links: m.links.map((l) => ({ id: l.id, code: l.code, productId: l.productId, productName: l.product?.name ?? null, createdAt: l.createdAt })),
      /** Pesewas. Null for an invite nobody has accepted. */
      stats: m.promoter ? (stats.get(m.promoter.id) ?? { buyers: 0, orders: 0, sales: 0, commission: 0 }) : null,
    };
  }

  /**
   * The platform number people message to join (PLATFORM_WHATSAPP_NUMBER, else asked from Meta
   * for PLATFORM_PHONE_NUMBER_ID). Null when neither works: invites then have no link yet.
   */
  private async platformDisplayNumber(): Promise<string | null> {
    if (this.platformNumber) return this.platformNumber;
    const configured = optionalEnv('PLATFORM_WHATSAPP_NUMBER');
    if (configured) return (this.platformNumber = configured);
    const id = PromoterBotService.platformNumberId();
    if (!id) return null;
    try {
      const { displayPhoneNumber } = await this.waba.getPhoneNumberDetails(id);
      return (this.platformNumber = displayPhoneNumber ?? null);
    } catch (err: any) {
      this.logger.warn(`Could not look up the platform number for invite links: ${err?.message || err}`);
      return null;
    }
  }
}
