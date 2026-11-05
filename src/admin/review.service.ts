import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, DocumentType, NumberStatus, Prisma, ReviewDecision, Tenant, TenantStatus, WabaStatus } from '@prisma/client';
import { NotificationService } from '../notification/notification.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { kycCompleteness, kycItems, OnboardingService } from '../tenant/onboarding.service.js';
import { formatVendorRef } from '../tenant/vendor-ref.js';
import { ReviewChecksDto, ReviewDecisionDto, UpdateReviewChecksDto } from './dto/review-decision.dto.js';
import { formatGhanaInternational } from '../common/phone.util.js';
import { AuditService } from './audit.service.js';
import { NumberPoolService } from './number-pool.service.js';
import { bannerState } from '../tenant/shop-banner.service.js';
import { withPhotoUrl } from '../product/product-photo.service.js';

/** States a reviewer can decide on. */
export const REVIEWABLE: TenantStatus[] = [TenantStatus.STOCKED, TenantStatus.UNDER_REVIEW];
const PRODUCT_SAMPLE_SIZE = 10;

export const PRODUCT_STOCK_FILTERS = ['all', 'in', 'out'] as const;
export type ProductStockFilter = (typeof PRODUCT_STOCK_FILTERS)[number];

export interface ProductListQuery {
  search?: string;
  stock?: ProductStockFilter;
  page?: number;
  limit?: number;
}
const NOT_SUSPENDED = Object.values(TenantStatus).filter((s) => s !== TenantStatus.SUSPENDED);

/** The due-diligence checks, as the reviewer sees them. */
export const CHECK_LABELS: Record<keyof ReviewChecksDto, string> = {
  ghanaCardMatches: 'Ghana Card matches owner name',
  momoNameMatches: 'MoMo registered name matches',
  calledOwner: 'Called the owner',
  productsLookGenuine: 'Products look genuine',
};
const CHECK_KEYS = Object.keys(CHECK_LABELS) as (keyof ReviewChecksDto)[];
const NO_CHECKS: ReviewChecksDto = { ghanaCardMatches: false, momoNameMatches: false, calledOwner: false, productsLookGenuine: false };

const DOCUMENT_LABELS: Record<DocumentType, string> = {
  GHANA_CARD_FRONT: 'Ghana Card (front)',
  GHANA_CARD_BACK: 'Ghana Card (back)',
  STALL_PHOTO: 'stall photo',
  BUSINESS_REG: 'business registration',
};

const DECISION_ACTIONS: Record<ReviewDecision, AuditAction> = {
  APPROVED: AuditAction.APPROVED,
  MORE_INFO: AuditAction.MORE_INFO_REQUESTED,
  REJECTED: AuditAction.REJECTED,
  SUSPENDED: AuditAction.SUSPENDED,
  RELEASED: AuditAction.NUMBER_RELEASED,
  REINSTATED: AuditAction.REINSTATED,
};

/** A shop's saved ticks, with every check present. */
function savedChecks(tenant: Pick<Tenant, 'reviewChecks'>): ReviewChecksDto {
  return { ...NO_CHECKS, ...(tenant.reviewChecks as Partial<ReviewChecksDto> | null) };
}

interface ReviewRecord {
  reviewerId: string;
  tenantId: string;
  decision: ReviewDecision;
  /** Shown to the vendor where the decision has notes. */
  notes?: string | null;
  checks?: ReviewChecksDto;
  numberId?: string;
  /** The audit log line; defaults to the notes. */
  details?: string;
}

/** Super admin review of vendor shops. Every decision writes a VendorReview row and an audit entry. */
@Injectable()
export class ReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numberPool: NumberPoolService,
    private readonly onboarding: OnboardingService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
  ) {}

  /** Tiles at the top of the review queue. */
  async summary() {
    const [waiting, moreInfo, freeNumbers, activeShops, pendingBanners] = await Promise.all([
      this.prisma.tenant.count({ where: { status: { in: REVIEWABLE } } }),
      this.prisma.tenant.count({ where: { status: TenantStatus.MORE_INFO } }),
      this.numberPool.countFree(),
      this.prisma.tenant.count({ where: { status: TenantStatus.ACTIVE } }),
      this.prisma.tenant.count({ where: { bannerPendingAt: { not: null } } }),
    ]);
    return { waiting, moreInfo, freeNumbers, activeShops, pendingBanners };
  }

  /** The review queue: oldest submission first. Defaults to shops waiting for review. */
  async queue(statuses: TenantStatus[] = REVIEWABLE) {
    const tenants = await this.prisma.tenant.findMany({
      where: { status: { in: statuses } },
      orderBy: [{ submittedAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      include: {
        documents: { select: { type: true } },
        _count: { select: { products: { where: { inStock: true } } } },
      },
    });
    return tenants.map((t) => ({
      id: t.id,
      ref: formatVendorRef(t.refNumber),
      name: t.name,
      ownerFullName: t.ownerFullName,
      ownerPhone: t.ownerPhone,
      market: t.market,
      status: t.status,
      productCount: t._count.products,
      kycCompleteness: kycCompleteness(t, t.documents),
      submittedAt: t.submittedAt,
    }));
  }

  /** Everything a reviewer needs on one page. */
  async detail(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        user: { select: { email: true, firstName: true, lastName: true, createdAt: true } },
        documents: { orderBy: { type: 'asc' } },
        number: true,
        reviews: { orderBy: { createdAt: 'desc' }, include: { reviewer: { select: { firstName: true, lastName: true, email: true } } } },
      },
    });
    if (!tenant) {
      throw new NotFoundException('Shop not found.');
    }

    const [products, inStock, uncategorised] = await Promise.all([
      this.prisma.product.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
        take: PRODUCT_SAMPLE_SIZE,
        include: { category: { select: { id: true, title: true } }, measures: { orderBy: { sortOrder: 'asc' } } },
      }),
      this.prisma.product.count({ where: { tenantId, inStock: true } }),
      this.prisma.product.count({ where: { tenantId, categoryId: null } }),
    ]);

    const { documents, ...shop } = tenant;
    return {
      ...shop,
      ref: formatVendorRef(tenant.refNumber),
      documents: documents.map((d) => this.onboarding.publicDocument(d)),
      kyc: kycItems(tenant, documents),
      products: { sample: products.map(withPhotoUrl), inStock, uncategorised },
      banner: bannerState(tenant),
    };
  }

  /**
   * Every product of one shop, in the order the vendor added them, so a reviewer can see
   * all of what the shop wants to sell (the detail page only carries a sample).
   */
  async products(tenantId: string, { search, stock = 'all', page = 1, limit = 20 }: ProductListQuery) {
    const exists = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!exists) {
      throw new NotFoundException('Shop not found.');
    }
    const safePage = Math.max(page, 1);
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const base: Prisma.ProductWhereInput = {
      tenantId,
      ...(search?.trim() && { name: { contains: search.trim(), mode: 'insensitive' } }),
    };
    const where: Prisma.ProductWhereInput = stock === 'all' ? base : { ...base, inStock: stock === 'in' };

    const [products, total, all, inStock] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        include: { category: { select: { id: true, title: true } }, measures: { orderBy: { sortOrder: 'asc' } } },
      }),
      this.prisma.product.count({ where }),
      this.prisma.product.count({ where: base }),
      this.prisma.product.count({ where: { ...base, inStock: true } }),
    ]);

    return {
      data: products.map(withPhotoUrl),
      meta: { total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) },
      // Tab badges; they follow `search` but not `stock`.
      counts: { all, in: inStock, out: all - inStock },
    };
  }

  /** A reviewer opens a waiting shop: STOCKED -> UNDER_REVIEW, so others can see it is taken. */
  async startReview(reviewerId: string, tenantId: string) {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await this.transition(tenantId, [TenantStatus.STOCKED], { status: TenantStatus.UNDER_REVIEW }, 'start reviewing', tx);
      await this.audit.log(tx, { actorId: reviewerId, action: AuditAction.REVIEW_STARTED, tenantId, details: 'Started reviewing.' });
      return tenant;
    });
  }

  /**
   * Save due-diligence ticks as the reviewer makes them, so a reload or another admin sees
   * the progress. Each changed tick is one audit entry.
   */
  async saveChecks(reviewerId: string, tenantId: string, dto: UpdateReviewChecksDto) {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await this.lockTenant(tx, tenantId);
      if (tenant.status !== TenantStatus.UNDER_REVIEW) {
        throw new ConflictException(`Start the review before ticking checks; this shop is ${tenant.status}.`);
      }
      const before = savedChecks(tenant);
      const changed = CHECK_KEYS.filter((key) => dto[key] !== undefined && dto[key] !== before[key]);
      const checks = { ...before, ...dto };
      if (changed.length === 0) {
        return { checks };
      }

      await tx.tenant.update({ where: { id: tenantId }, data: { reviewChecks: { ...checks } } });
      for (const key of changed) {
        await this.audit.log(tx, {
          actorId: reviewerId,
          action: AuditAction.CHECKLIST_UPDATED,
          tenantId,
          details: `${checks[key] ? 'Ticked' : 'Unticked'} “${CHECK_LABELS[key]}”.`,
          metadata: { check: key, value: checks[key] },
        });
      }
      return { checks };
    });
  }

  /** Approve, ask for more info, or reject a shop under review. */
  async decide(reviewerId: string, tenantId: string, dto: ReviewDecisionDto) {
    if (dto.decision === ReviewDecision.APPROVED) {
      return this.approve(reviewerId, tenantId, dto);
    }
    if (!dto.notes?.trim()) {
      throw new BadRequestException('Add notes for the vendor explaining what to fix.');
    }

    const status = dto.decision === ReviewDecision.MORE_INFO ? TenantStatus.MORE_INFO : TenantStatus.REJECTED;
    const tenant = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockTenant(tx, tenantId);
      const checks = { ...savedChecks(current), ...dto.checks };
      const updated = await this.transition(
        tenantId,
        REVIEWABLE,
        { status, reviewChecks: Prisma.DbNull },
        dto.decision.toLowerCase().replace('_', ' '),
        tx,
      );
      await this.record(tx, { reviewerId, tenantId, decision: dto.decision, notes: dto.notes, checks });
      return updated;
    });

    await (status === TenantStatus.MORE_INFO
      ? this.notifications.vendorMoreInfo(tenant, dto.notes)
      : this.notifications.vendorRejected(tenant, dto.notes));
    return tenant;
  }

  /**
   * Approve: assign a pool number and go live, all in one transaction. The shop row is
   * locked first so a double-click or two admins cannot approve it twice.
   */
  private async approve(reviewerId: string, tenantId: string, dto: ReviewDecisionDto) {
    const { tenant, number } = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockTenant(tx, tenantId);
      // Ticks saved along the way count; any sent with the decision win.
      const checks = { ...savedChecks(current), ...dto.checks };
      const unticked = CHECK_KEYS.filter((key) => checks[key] !== true);
      if (unticked.length > 0) {
        throw new BadRequestException(`Tick every due-diligence check before approving. Missing: ${unticked.join(', ')}.`);
      }
      if (!REVIEWABLE.includes(current.status)) {
        throw new ConflictException(`Only a shop waiting for review can be approved; this one is ${current.status}.`);
      }
      if (current.number) {
        throw new ConflictException(`This shop already has ${current.number.displayNumber}.`);
      }

      const claimed = await this.numberPool.claim(tx, dto.numberId);
      const now = new Date();
      const number = await tx.whatsappNumber.update({
        where: { id: claimed.id },
        data: {
          status: NumberStatus.ASSIGNED,
          tenantId,
          displayName: dto.displayName ?? current.name,
          assignedAt: now,
          releasedAt: null,
        },
      });
      const tenant = await tx.tenant.update({
        where: { id: tenantId },
        data: {
          status: TenantStatus.ACTIVE,
          whatsappNumber: number.displayNumber,
          whatsappPhoneNumberId: number.phoneNumberId,
          wabaStatus: WabaStatus.VERIFIED,
          wabaRegisteredAt: now,
          reviewChecks: Prisma.DbNull,
        },
      });
      await this.record(tx, {
        reviewerId,
        tenantId,
        decision: ReviewDecision.APPROVED,
        notes: dto.notes,
        checks,
        numberId: number.id,
        details: [`Assigned ${formatGhanaInternational(number.displayNumber)}.`, dto.notes?.trim()].filter(Boolean).join(' '),
      });
      return { tenant, number };
    });

    await this.notifications.vendorLive(tenant, number.displayNumber);
    return { tenant, number };
  }

  /** Close a shop. It keeps its number; buyers are told it is temporarily closed. */
  async suspend(reviewerId: string, tenantId: string, reason: string) {
    const tenant = await this.prisma.$transaction(async (tx) => {
      const updated = await this.transition(tenantId, NOT_SUSPENDED, { status: TenantStatus.SUSPENDED }, 'suspend', tx);
      await this.record(tx, { reviewerId, tenantId, decision: ReviewDecision.SUSPENDED, notes: reason });
      return updated;
    });
    await this.notifications.vendorSuspended(tenant, reason);
    return tenant;
  }

  /** Take the number back from a suspended shop. It cools for 7 days before reuse. */
  async release(reviewerId: string, tenantId: string) {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await this.lockTenant(tx, tenantId);
      if (tenant.status !== TenantStatus.SUSPENDED) {
        throw new ConflictException('Suspend the shop before releasing its number.');
      }
      if (!tenant.number) {
        throw new ConflictException('This shop has no number to release.');
      }
      return this.releaseLocked(tx, reviewerId, tenantId, tenant.number.id, null);
    });
  }

  /**
   * Release from the number pool page: suspends the shop first when it is still open
   * (the vendor is told `reason`), then releases its number, in one transaction.
   */
  async releaseNumber(reviewerId: string, numberId: string, reason?: string) {
    const assigned = await this.prisma.whatsappNumber.findUnique({ where: { id: numberId } });
    if (!assigned) throw new NotFoundException('Number not found.');
    if (!assigned.tenantId) throw new ConflictException('This number is not assigned to a shop.');
    const tenantId = assigned.tenantId;

    const result = await this.prisma.$transaction(async (tx) => {
      const tenant = await this.lockTenant(tx, tenantId);
      if (tenant.number?.id !== numberId) {
        throw new ConflictException('This number has already been released.');
      }
      const suspend = tenant.status !== TenantStatus.SUSPENDED;
      if (suspend) {
        if (!reason?.trim()) {
          throw new BadRequestException(`Give a reason: ${tenant.name} is ${tenant.status} and will be suspended, and the vendor is told why.`);
        }
        await tx.tenant.update({ where: { id: tenantId }, data: { status: TenantStatus.SUSPENDED } });
        await this.record(tx, { reviewerId, tenantId, decision: ReviewDecision.SUSPENDED, notes: reason });
      }
      return { ...(await this.releaseLocked(tx, reviewerId, tenantId, numberId, reason)), suspended: suspend };
    });

    if (result.suspended) {
      await this.notifications.vendorSuspended(result.tenant, reason!);
    }
    return result;
  }

  /** Number -> COOLING and off the shop. The caller holds the shop's row lock. */
  private async releaseLocked(tx: Prisma.TransactionClient, reviewerId: string, tenantId: string, numberId: string, reason?: string | null) {
    const number = await tx.whatsappNumber.update({
      where: { id: numberId },
      data: { status: NumberStatus.COOLING, tenantId: null, releasedAt: new Date() },
    });
    const updated = await tx.tenant.update({
      where: { id: tenantId },
      data: { whatsappNumber: null, whatsappPhoneNumberId: null, wabaStatus: WabaStatus.PENDING_REGISTRATION },
    });
    await this.record(tx, {
      reviewerId,
      tenantId,
      decision: ReviewDecision.RELEASED,
      numberId: number.id,
      details: [`${formatGhanaInternational(number.displayNumber)} released.`, reason?.trim()].filter(Boolean).join(' '),
    });
    return { tenant: updated, number };
  }

  /**
   * Lift a suspension. A shop that kept its number is ACTIVE again; one whose number was
   * released goes back into the queue to be approved for a new one.
   */
  async reinstate(reviewerId: string, tenantId: string) {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await this.lockTenant(tx, tenantId);
      const inStock = tenant.number ? 0 : await tx.product.count({ where: { tenantId, inStock: true } });

      const next: Prisma.TenantUpdateInput = tenant.number
        ? { status: TenantStatus.ACTIVE }
        : inStock > 0
          ? { status: TenantStatus.STOCKED, submittedAt: new Date() }
          : { status: TenantStatus.PENDING };
      const updated = await this.transition(tenantId, [TenantStatus.SUSPENDED], next, 'reinstate', tx);
      await this.record(tx, {
        reviewerId,
        tenantId,
        decision: ReviewDecision.REINSTATED,
        details: tenant.number
          ? 'Reopened with its number.'
          : inStock > 0
            ? 'Back in the review queue for a new number.'
            : 'Back to not submitted: no products in stock.',
      });
      return updated;
    });
  }

  /**
   * Lock the shop row for the rest of the transaction, so concurrent admin actions on the
   * same shop run one after the other, then load it with its number.
   */
  private async lockTenant(tx: Prisma.TransactionClient, tenantId: string) {
    await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, include: { number: true } });
    if (!tenant) throw new NotFoundException('Shop not found.');
    return tenant;
  }

  /** A KYC file for the review screen. Every view is logged: these are ID documents. */
  async openDocument(reviewerId: string, tenantId: string, documentId: string) {
    const opened = await this.onboarding.openDocument(tenantId, documentId);
    await this.audit.log(this.prisma, {
      actorId: reviewerId,
      action: AuditAction.DOCUMENT_VIEWED,
      tenantId,
      details: `Opened ${DOCUMENT_LABELS[opened.document.type]}.`,
      metadata: { documentId, type: opened.document.type },
    });
    return opened;
  }

  /**
   * Change a shop's state only if it is still in one of `from`, so two admins acting on
   * the same shop cannot both succeed.
   */
  private async transition(
    tenantId: string,
    from: TenantStatus[],
    data: Prisma.TenantUpdateInput,
    action: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<Tenant> {
    const { count } = await tx.tenant.updateMany({ where: { id: tenantId, status: { in: from } }, data: data as Prisma.TenantUpdateManyMutationInput });
    if (count === 0) {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) throw new NotFoundException('Shop not found.');
      throw new ConflictException(`Cannot ${action} a shop that is ${tenant.status}.`);
    }
    return tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  }

  /** The vendor-facing review row and the audit entry, in the caller's transaction. */
  private async record(tx: Prisma.TransactionClient, entry: ReviewRecord) {
    const notes = entry.notes?.trim() || null;
    await tx.vendorReview.create({
      data: {
        tenantId: entry.tenantId,
        reviewerId: entry.reviewerId,
        decision: entry.decision,
        notes,
        ...(entry.checks && { checks: { ...entry.checks } }),
        ...(entry.numberId && { numberId: entry.numberId }),
      },
    });
    await this.audit.log(tx, {
      actorId: entry.reviewerId,
      action: DECISION_ACTIONS[entry.decision],
      tenantId: entry.tenantId,
      numberId: entry.numberId,
      details: entry.details ?? notes,
      ...(entry.checks && { metadata: { checks: { ...entry.checks } } }),
    });
  }
}
