import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DocumentType, Tenant, TenantStatus, VendorDocument } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { isLive, TenantService } from './tenant.service.js';

/** Documents a reviewer needs before approving; BUSINESS_REG is optional. */
export const REQUIRED_DOCUMENTS: DocumentType[] = [
  DocumentType.GHANA_CARD_FRONT,
  DocumentType.GHANA_CARD_BACK,
  DocumentType.STALL_PHOTO,
];

export const DOCUMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** States in which the shop is waiting on MarketiX, not the vendor. */
const IN_REVIEW: TenantStatus[] = [TenantStatus.STOCKED, TenantStatus.UNDER_REVIEW];

type KycTenant = Pick<Tenant, 'ownerFullName' | 'ownerPhone' | 'momoNumber' | 'momoName'>;

/**
 * KYC items a reviewer checks, done or not. Shared by the vendor's checklist and the
 * admin review queue's completeness bar.
 */
export function kycItems(tenant: KycTenant, documents: Pick<VendorDocument, 'type'>[]) {
  const has = (type: DocumentType) => documents.some((d) => d.type === type);
  return [
    { key: 'ownerDetails', label: 'Owner name and phone', done: Boolean(tenant.ownerFullName && tenant.ownerPhone) },
    { key: 'momoPayout', label: 'MoMo payout number and registered name', done: Boolean(tenant.momoNumber && tenant.momoName) },
    { key: 'ghanaCardFront', label: 'Ghana Card (front)', done: has(DocumentType.GHANA_CARD_FRONT) },
    { key: 'ghanaCardBack', label: 'Ghana Card (back)', done: has(DocumentType.GHANA_CARD_BACK) },
    { key: 'stallPhoto', label: 'Photo of your stall', done: has(DocumentType.STALL_PHOTO) },
  ];
}

/** Share of KYC items done, 0..1. */
export function kycCompleteness(tenant: KycTenant, documents: Pick<VendorDocument, 'type'>[]): number {
  const items = kycItems(tenant, documents);
  return items.filter((i) => i.done).length / items.length;
}

/** Vendor-side onboarding: status transitions, the "what's left" checklist and KYC documents. */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantService: TenantService,
    private readonly storage: StorageService,
  ) {}

  /**
   * PENDING -> STOCKED once the shop has an in-stock product. Called after every catalogue
   * change; a no-op in any other state.
   */
  async markStockedIfReady(tenantId: string): Promise<boolean> {
    const { count } = await this.prisma.tenant.updateMany({
      where: { id: tenantId, status: TenantStatus.PENDING, products: { some: { inStock: true } } },
      data: { status: TenantStatus.STOCKED, submittedAt: new Date() },
    });
    return count === 1;
  }

  /** GET /tenants/status: where the shop is and what is left to do. */
  async status(userId: string) {
    const tenant = await this.tenantService.findByUser(userId);
    const [documents, inStock, latestReview, number] = await Promise.all([
      this.prisma.vendorDocument.findMany({ where: { tenantId: tenant.id }, select: { type: true } }),
      this.prisma.product.count({ where: { tenantId: tenant.id, inStock: true } }),
      this.prisma.vendorReview.findFirst({
        where: { tenantId: tenant.id },
        orderBy: { createdAt: 'desc' },
        select: { decision: true, notes: true, createdAt: true },
      }),
      this.prisma.whatsappNumber.findUnique({
        where: { tenantId: tenant.id },
        select: { displayNumber: true, displayName: true, assignedAt: true },
      }),
    ]);

    const steps = [
      { key: 'shop', label: 'Shop details', done: Boolean(tenant.name && tenant.market) },
      ...kycItems(tenant, documents),
      { key: 'products', label: 'At least one product in stock', done: inStock > 0 },
      { key: 'approved', label: 'Approved by MarketiX', done: isLive(tenant) },
    ];

    return {
      status: tenant.status,
      canResubmit: tenant.status === TenantStatus.MORE_INFO || tenant.status === TenantStatus.REJECTED,
      steps,
      // Only the reviewer's notes, never who reviewed it.
      latestReview,
      number,
    };
  }

  /** MORE_INFO / REJECTED -> back into the queue once the vendor has fixed things. */
  async resubmit(userId: string) {
    const tenant = await this.tenantService.findByUser(userId);
    if (tenant.status !== TenantStatus.MORE_INFO && tenant.status !== TenantStatus.REJECTED) {
      throw new BadRequestException(
        IN_REVIEW.includes(tenant.status) ? 'Your shop is already waiting for review.' : `A shop that is ${tenant.status} cannot be resubmitted.`,
      );
    }

    const inStock = await this.prisma.product.count({ where: { tenantId: tenant.id, inStock: true } });
    return this.prisma.tenant.update({
      where: { id: tenant.id },
      data: inStock > 0 ? { status: TenantStatus.STOCKED, submittedAt: new Date() } : { status: TenantStatus.PENDING },
    });
  }

  // ───────────────────────── KYC documents ─────────────────────────

  /** Store a KYC document; one per type, so uploading again replaces the old file. */
  async uploadDocument(userId: string, type: DocumentType, file: Express.Multer.File) {
    const tenant = await this.tenantService.findByUser(userId);
    this.tenantService.assertEditable(tenant);
    this.tenantService.assertKycEditable(tenant);
    if (!DOCUMENT_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException('Upload a JPEG, PNG, WebP or PDF file.');
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      throw new BadRequestException('Documents must be 5 MB or smaller.');
    }

    const storageKey = `kyc/${tenant.id}/${randomUUID()}${extname(file.originalname).toLowerCase()}`;
    await this.storage.save(storageKey, file.buffer);

    const previous = await this.prisma.vendorDocument.findUnique({ where: { tenantId_type: { tenantId: tenant.id, type } } });
    const document = await this.prisma.vendorDocument.upsert({
      where: { tenantId_type: { tenantId: tenant.id, type } },
      create: { tenantId: tenant.id, type, storageKey, fileName: file.originalname, mimeType: file.mimetype, size: file.size },
      update: { storageKey, fileName: file.originalname, mimeType: file.mimetype, size: file.size, uploadedAt: new Date() },
    });
    if (previous) {
      await this.storage.remove(previous.storageKey);
    }
    return this.publicDocument(document);
  }

  async listDocuments(userId: string) {
    const tenant = await this.tenantService.findByUser(userId);
    const documents = await this.prisma.vendorDocument.findMany({ where: { tenantId: tenant.id }, orderBy: { type: 'asc' } });
    return documents.map((d) => this.publicDocument(d));
  }

  /** The vendor's own document file. */
  async openOwnDocument(userId: string, documentId: string) {
    const tenant = await this.tenantService.findByUser(userId);
    return this.openDocument(tenant.id, documentId);
  }

  /** A document file, scoped to one shop so an id from another shop never resolves. */
  async openDocument(tenantId: string, documentId: string) {
    const document = await this.prisma.vendorDocument.findFirst({ where: { id: documentId, tenantId } });
    if (!document) {
      throw new NotFoundException('Document not found.');
    }
    return { document, stream: await this.storage.read(document.storageKey) };
  }

  /** Document metadata without the internal storage key. */
  publicDocument({ storageKey: _, ...document }: VendorDocument) {
    return document;
  }
}
