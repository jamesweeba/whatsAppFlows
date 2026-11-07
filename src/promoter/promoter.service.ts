import { Injectable, Logger } from '@nestjs/common';
import { Prisma, Promoter, PromoterMembershipStatus as Status, TenantStatus } from '@prisma/client';
import { NotificationService } from '../notification/notification.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isLive } from '../tenant/tenant.service.js';
import { newCode } from './promoter-rules.js';

/** Shops listed per page under SHOPS (a WhatsApp list holds 10 rows; one is "More shops"). */
export const SHOPS_PAGE_SIZE = 9;

/** The outcome of asking to promote a shop, or of accepting an invite. */
export type JoinResult =
  | { kind: 'requested'; shopName: string }
  | { kind: 'approved'; shopName: string; tenantId: string }
  | { kind: 'already_requested'; shopName: string }
  | { kind: 'already_approved'; shopName: string }
  | { kind: 'not_accepted'; shopName: string }
  /** The shop isn't live or isn't taking promoters. */
  | { kind: 'closed' }
  | { kind: 'invalid_invite' }
  | { kind: 'wrong_number' };

type Tx = Prisma.TransactionClient;

/** Promoters' memberships of shops and their links. */
@Injectable()
export class PromoterService {
  private readonly logger = new Logger(PromoterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /** Live shops that take requests from new promoters, by name. */
  async openShops(page: number) {
    const rows = await this.prisma.tenant.findMany({
      where: {
        status: TenantStatus.ACTIVE,
        promotionsEnabled: true,
        acceptPromoterRequests: true,
        promoterRate: { not: null },
        whatsappNumber: { not: null },
      },
      orderBy: { name: 'asc' },
      skip: page * SHOPS_PAGE_SIZE,
      take: SHOPS_PAGE_SIZE + 1,
      select: { id: true, name: true, market: true, promoterRate: true },
    });
    return { shops: rows.slice(0, SHOPS_PAGE_SIZE), hasMore: rows.length > SHOPS_PAGE_SIZE };
  }

  /**
   * Ask to promote a shop. The vendor is told and approves or declines in the dashboard.
   * If the shop already invited this number, the invite is accepted instead.
   */
  async requestToJoin(promoter: Promoter, tenantId: string): Promise<JoinResult> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || !isLive(tenant) || !tenant.promotionsEnabled || !tenant.promoterRate) return { kind: 'closed' };

    const invite = await this.prisma.promoterMembership.findFirst({
      where: { tenantId, status: Status.INVITED, invitedPhone: promoter.phone, inviteCode: { not: null } },
    });
    if (invite?.inviteCode) return this.acceptInvite(promoter, invite.inviteCode);

    const shopName = tenant.name;
    const existing = await this.prisma.promoterMembership.findUnique({
      where: { tenantId_promoterId: { tenantId, promoterId: promoter.id } },
    });
    if (existing?.status === Status.APPROVED) return { kind: 'already_approved', shopName };
    if (existing?.status === Status.REQUESTED) return { kind: 'already_requested', shopName };
    if (existing) return { kind: 'not_accepted', shopName }; // declined or removed: the vendor can invite them back
    if (!tenant.acceptPromoterRequests) return { kind: 'closed' };

    try {
      await this.prisma.promoterMembership.create({ data: { tenantId, promoterId: promoter.id, status: Status.REQUESTED } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { kind: 'already_requested', shopName };
      throw err;
    }
    this.logger.log(`Promoter ${promoter.id} asked to promote ${tenant.name}.`);
    void this.notifications.promoterRequested(tenant, promoter);
    return { kind: 'requested', shopName };
  }

  /** The invite with this code, if it is still open. */
  findOpenInvite(code: string) {
    return this.prisma.promoterMembership.findFirst({ where: { inviteCode: code.toUpperCase(), status: Status.INVITED } });
  }

  /**
   * Accept a vendor's invite (JOIN <code>): only the invited number can. The promoter is
   * approved and gets links for what the vendor chose. An earlier request, decline or
   * removal for the same shop is overridden, since the vendor is asking them now.
   */
  async acceptInvite(promoter: Promoter, code: string): Promise<JoinResult> {
    return this.prisma.$transaction(async (tx) => {
      const invite = await tx.promoterMembership.findUnique({ where: { inviteCode: code.toUpperCase() }, include: { tenant: true } });
      if (!invite || invite.status !== Status.INVITED) return { kind: 'invalid_invite' } as const;
      if (invite.invitedPhone !== promoter.phone) return { kind: 'wrong_number' } as const;
      if (!isLive(invite.tenant) || !invite.tenant.promotionsEnabled) return { kind: 'closed' } as const;

      const approved = { status: Status.APPROVED, decidedAt: new Date(), removedAt: null };
      const existing = await tx.promoterMembership.findUnique({
        where: { tenantId_promoterId: { tenantId: invite.tenantId, promoterId: promoter.id } },
      });
      let membershipId: string;
      if (existing) {
        await tx.promoterMembership.update({ where: { id: existing.id }, data: approved });
        await tx.promoterMembership.delete({ where: { id: invite.id } });
        membershipId = existing.id;
      } else {
        await tx.promoterMembership.update({ where: { id: invite.id }, data: { ...approved, promoterId: promoter.id, inviteCode: null } });
        membershipId = invite.id;
      }
      await this.ensureLinks(tx, { id: membershipId, tenantId: invite.tenantId, promoterId: promoter.id }, invite.inviteProductIds);
      this.logger.log(`Promoter ${promoter.id} accepted ${invite.tenant.name}'s invite.`);
      return { kind: 'approved', shopName: invite.tenant.name, tenantId: invite.tenantId } as const;
    });
  }

  /**
   * Make sure a membership has an active link for each product, or for the whole shop when
   * `productIds` is empty. Existing active links are kept; products not in the shop are skipped.
   * Returns the codes of the links it created.
   */
  async ensureLinks(tx: Tx, membership: { id: string; tenantId: string; promoterId: string }, productIds: string[]): Promise<string[]> {
    let targets: (string | null)[] = [null];
    if (productIds.length) {
      const products = await tx.product.findMany({ where: { id: { in: productIds }, tenantId: membership.tenantId }, select: { id: true } });
      targets = products.map((p) => p.id);
    }
    const created: string[] = [];
    for (const productId of targets) {
      const exists = await tx.promoLink.findFirst({ where: { membershipId: membership.id, productId, active: true } });
      if (exists) continue;
      const link = await tx.promoLink.create({
        data: { code: newCode(), membershipId: membership.id, tenantId: membership.tenantId, promoterId: membership.promoterId, productId },
      });
      created.push(link.code);
    }
    return created;
  }

  /** A promoter's links that work right now (approved, shop live and promoting), optionally for one shop. */
  activeLinks(promoterId: string, tenantId?: string) {
    return this.prisma.promoLink.findMany({
      where: {
        promoterId,
        active: true,
        ...(tenantId && { tenantId }),
        membership: { status: Status.APPROVED },
        tenant: { status: TenantStatus.ACTIVE, promotionsEnabled: true, whatsappNumber: { not: null } },
      },
      include: { tenant: { select: { name: true, market: true, whatsappNumber: true } }, product: { select: { name: true } } },
      orderBy: [{ tenantId: 'asc' }, { createdAt: 'asc' }],
    });
  }
}
