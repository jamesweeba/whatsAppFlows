import { Injectable, Logger } from '@nestjs/common';
import { PromoterMembershipStatus, PromoterStatus, Referral } from '@prisma/client';
import { isHiddenNumber } from '../common/phone.util.js';
import { PAID_ORDER_STATUSES } from '../order/order-status-groups.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { REFERRAL_DAYS } from './promoter-rules.js';
import { commissionFor, isPromotersOwnNumber, parseRefCode, referralState } from './referral-rules.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** An order as attachToOrder needs it. */
export interface AttributableOrder {
  id: string;
  tenantId: string;
  buyerPhone: string;
  totalAmount: number;
  deliveryFee: number;
  items: { productId: string | null; totalPrice: number }[];
}

const ORDER_FACTS = {
  id: true,
  orderNumber: true,
  createdAt: true,
  status: true,
  paymentMethod: true,
  paystackPaidAt: true,
  buyerPhone: true,
  paymentPhone: true,
} as const;

/** Per promoter, for the vendor's list. Amounts in pesewas. */
export interface PromoterStats {
  /** Different buyers who tapped their links. */
  buyers: number;
  /** First orders credited to them (not cancelled). */
  orders: number;
  /** What their orders' commission is on. */
  sales: number;
  /** Commission on orders that earn or still may (paid by MoMo/card, not cancelled). */
  commission: number;
}

/**
 * Which buyer came from which promoter's link, and the order it is credited to. Only
 * a buyer's first order with the shop counts, within REFERRAL_DAYS of tapping the link.
 * Money moves later, when promoter commission is settled.
 */
@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * A buyer's message to a shop: if it carries "(ref <code>)" from one of the shop's working
   * links and the buyer is new to the shop, remember the referral. Never throws.
   */
  async recordTap(tenantId: string, buyerPhone: string, text: string | null | undefined): Promise<Referral | null> {
    const code = parseRefCode(text);
    if (!code) return null;
    try {
      return await this.record(tenantId, buyerPhone, code);
    } catch (err: any) {
      this.logger.error(`Could not record referral ${code} for ${buyerPhone}: ${err?.message || err}`);
      return null;
    }
  }

  private async record(tenantId: string, buyerPhone: string, code: string): Promise<Referral | null> {
    const skip = (why: string) => {
      this.logger.log(`Referral ${code} from ${buyerPhone} not recorded: ${why}.`);
      return null;
    };
    if (isHiddenNumber(buyerPhone)) return skip('hidden number');

    const link = await this.prisma.promoLink.findUnique({
      where: { code },
      include: { membership: true, promoter: true, tenant: true, product: true },
    });
    if (!link || link.tenantId !== tenantId) return skip('not a link of this shop');
    if (
      !link.active ||
      link.membership.status !== PromoterMembershipStatus.APPROVED ||
      link.promoter.status !== PromoterStatus.ACTIVE ||
      !link.tenant.promotionsEnabled
    ) {
      return skip('link not in use');
    }
    if (isPromotersOwnNumber({ buyerPhone, paymentPhone: null }, link.promoter)) return skip("the promoter's own number");
    if (await this.hasPlacedOrder(tenantId, buyerPhone)) return skip('not a new customer');
    const ratePercent = link.product?.promoterRate ?? link.tenant.promoterRate;
    if (!ratePercent) return skip('no commission rate');

    const now = new Date();
    const window = { ratePercent, tappedAt: now, expiresAt: new Date(now.getTime() + REFERRAL_DAYS * DAY_MS) };
    // Tapping the same link again restarts the buyer's 14 days rather than adding a row.
    const latest = await this.openReferral(tenantId, buyerPhone, now);
    if (latest && latest.linkId === link.id) return this.prisma.referral.update({ where: { id: latest.id }, data: window });

    const referral = await this.prisma.referral.create({
      data: {
        tenantId,
        buyerPhone,
        promoterId: link.promoterId,
        linkId: link.id,
        linkCode: link.code,
        productId: link.productId,
        productName: link.product?.name ?? null,
        ...window,
      },
    });
    this.logger.log(`Buyer ${buyerPhone} came to ${link.tenant.name} from promoter ${link.promoterId} (${code}, ${ratePercent}%).`);
    return referral;
  }

  /**
   * Credit a new order to the promoter whose link the buyer tapped last, if it is the buyer's
   * first order with the shop and within the 14 days. A referral already on an order that was
   * cancelled or never paid moves to this one. Never throws: an order is never lost over this.
   */
  async attachToOrder(order: AttributableOrder): Promise<Referral | null> {
    try {
      if (isHiddenNumber(order.buyerPhone)) return null;
      if (await this.hasPlacedOrder(order.tenantId, order.buyerPhone, order.id)) return null;
      const now = new Date();
      const referral = await this.openReferral(order.tenantId, order.buyerPhone, now);
      if (!referral) return null;

      const { base, commission } = commissionFor(referral, order);
      const attached = await this.prisma.referral.update({
        where: { id: referral.id },
        data: { orderId: order.id, attachedAt: now, baseAmount: base, commissionAmount: commission },
      });
      this.logger.log(`Order ${order.id} credited to promoter ${referral.promoterId} (${referral.linkCode}): commission ${commission} pesewas.`);
      return attached;
    } catch (err: any) {
      this.logger.error(`Could not credit order ${order.id} to a promoter: ${err?.message || err}`);
      return null;
    }
  }

  /** The vendor's "Sales from promoters": credited orders, newest first. */
  async salesForShop(tenantId: string, { page, limit }: { page: number; limit: number }) {
    const where = { tenantId, orderId: { not: null } };
    const [rows, total] = await Promise.all([
      this.prisma.referral.findMany({
        where,
        include: { order: { select: ORDER_FACTS }, promoter: { select: { id: true, fullName: true, phone: true, momoNumber: true } } },
        orderBy: { attachedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.referral.count({ where }),
    ]);
    const data = rows.map((r) => {
      const { state, reason } = referralState(r, r.order, r.promoter);
      return {
        id: r.id,
        order: r.order && { id: r.order.id, orderNumber: r.order.orderNumber, status: r.order.status, paymentMethod: r.order.paymentMethod, createdAt: r.order.createdAt },
        promoter: { id: r.promoter.id, fullName: r.promoter.fullName },
        link: { code: r.linkCode, productId: r.productId, productName: r.productName },
        ratePercent: r.ratePercent,
        baseAmount: r.baseAmount ?? 0,
        commissionAmount: r.commissionAmount ?? 0,
        state,
        reason: reason ?? null,
      };
    });
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  /** Buyers, orders, sales and commission per promoter, for the shop. */
  async statsForShop(tenantId: string): Promise<Map<string, PromoterStats>> {
    const referrals = await this.prisma.referral.findMany({
      where: { tenantId },
      include: { order: { select: ORDER_FACTS }, promoter: { select: { phone: true, momoNumber: true } } },
    });
    const stats = new Map<string, PromoterStats & { buyerSet: Set<string> }>();
    for (const r of referrals) {
      const s = stats.get(r.promoterId) ?? { buyers: 0, orders: 0, sales: 0, commission: 0, buyerSet: new Set<string>() };
      s.buyerSet.add(r.buyerPhone);
      const { state, reason } = referralState(r, r.order, r.promoter);
      if (r.order && reason !== 'CANCELLED') {
        s.orders += 1;
        s.sales += r.baseAmount ?? 0;
      }
      if (state === 'PENDING' || state === 'EARNED') s.commission += r.commissionAmount ?? 0;
      stats.set(r.promoterId, s);
    }
    return new Map([...stats].map(([id, { buyerSet, ...s }]) => [id, { ...s, buyers: buyerSet.size }]));
  }

  /** Whether the buyer already has a paid or confirmed order with the shop (cancelled and unpaid ones don't count). */
  private async hasPlacedOrder(tenantId: string, buyerPhone: string, exceptOrderId?: string): Promise<boolean> {
    const count = await this.prisma.order.count({
      where: {
        tenantId,
        buyerPhone,
        status: { in: PAID_ORDER_STATUSES },
        // A vendor can't use up the buyer's first order by entering one for them.
        OR: [{ vendorCreated: false }, { paystackPaidAt: { not: null } }],
        ...(exceptOrderId && { id: { not: exceptOrderId } }),
      },
    });
    return count > 0;
  }

  /** The buyer's latest unexpired referral for the shop that isn't on a paid or confirmed order (and whose promoter isn't suspended). */
  private openReferral(tenantId: string, buyerPhone: string, now: Date) {
    return this.prisma.referral.findFirst({
      where: {
        tenantId,
        buyerPhone,
        expiresAt: { gt: now },
        promoter: { status: PromoterStatus.ACTIVE },
        OR: [{ orderId: null }, { order: { status: { notIn: PAID_ORDER_STATUSES } } }],
      },
      orderBy: { tappedAt: 'desc' },
    });
  }
}
