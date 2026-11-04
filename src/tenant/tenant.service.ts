import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Tenant, TenantStatus, WabaStatus } from '@prisma/client';
import { optionalEnv } from '../common/config.js';
import { NotificationService } from '../notification/notification.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateTenantDto } from './dto/create-tenant.dto.js';
import { UpdateTenantDto } from './dto/update-tenant.dto.js';
import { extractCountryCode } from './utils/country-code.util.js';

/** Strip class instances down to plain JSON for a Prisma Json column. */
function toJson(value: object[]): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Owner and payout details a reviewer checks against the Ghana Card and MoMo account.
 * Once review starts they are frozen, so an approved shop cannot quietly redirect payouts.
 */
const KYC_FIELDS = ['ownerFullName', 'momoNumber', 'momoName'] as const;
const KYC_LOCKED: TenantStatus[] = [TenantStatus.UNDER_REVIEW, TenantStatus.ACTIVE];

/** A shop that is approved and has its number: the only kind that talks to buyers and takes orders. */
export function isLive(tenant: Pick<Tenant, 'status'>): boolean {
  return tenant.status === TenantStatus.ACTIVE;
}

/** Vendors bringing their own number via OTP (the original flow) instead of a pool number. */
export function ownNumberOnboardingEnabled(): boolean {
  return optionalEnv('ALLOW_OWN_NUMBER_ONBOARDING') === 'true';
}

@Injectable()
export class TenantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Create a tenant for the authenticated user.
   * A user can only have one tenant. If one already exists, this throws a ConflictException.
   */
  async create(userId: string, dto: CreateTenantDto) {
    const existingTenant = await this.prisma.tenant.findUnique({ where: { userId } });
    if (existingTenant) {
      throw new ConflictException('You already have a tenant. You can only update it.');
    }

    const slug = dto.slug ?? this.generateSlug(dto.name);
    const slugExists = await this.prisma.tenant.findUnique({ where: { slug } });
    if (slugExists) {
      throw new ConflictException(`The slug "${slug}" is already taken. Please provide a different one.`);
    }

    // No WhatsApp number yet: a super admin assigns one from the pool on approval.
    const tenant = await this.prisma.tenant.create({
      data: {
        name: dto.name,
        slug,
        ...(dto.countryCode && { countryCode: dto.countryCode }),
        ownerFullName: dto.ownerFullName,
        ownerPhone: dto.ownerPhone,
        market: dto.market,
        stallLocation: dto.stallLocation,
        momoNumber: dto.momoNumber,
        momoName: dto.momoName,
        description: dto.description,
        ...(dto.deliveryFee !== undefined && { deliveryFee: dto.deliveryFee }),
        ...(dto.pickupNote !== undefined && { pickupNote: dto.pickupNote }),
        ...(dto.deliveryAreas !== undefined && { deliveryAreas: toJson(dto.deliveryAreas) }),
        ...(dto.deliverySlots !== undefined && { deliverySlots: toJson(dto.deliverySlots) }),
        userId,
        status: TenantStatus.PENDING,
        wabaStatus: WabaStatus.PENDING_REGISTRATION,
      },
    });
    await this.notifications.vendorWelcome(tenant);
    return tenant;
  }

  /**
   * Get the tenant belonging to the authenticated user, or throw.
   * This is the single place every vendor-scoped endpoint resolves its tenant.
   */
  async findByUser(userId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { userId } });
    if (!tenant) {
      throw new NotFoundException('You do not have a tenant yet.');
    }
    return tenant;
  }

  /**
   * Find a tenant by Meta WABA Phone Number ID (used for webhook message routing).
   * Returns null when no tenant owns that number so callers can drop the event.
   */
  findByPhoneNumberId(whatsappPhoneNumberId: string) {
    return this.prisma.tenant.findUnique({ where: { whatsappPhoneNumberId } });
  }

  /** A pool number by Meta's id, whether or not a shop has it (for unassigned-number replies). */
  findPoolNumber(phoneNumberId: string) {
    return this.prisma.whatsappNumber.findUnique({ where: { phoneNumberId } });
  }

  /** KYC details and documents cannot change while a shop is under review or approved. */
  assertKycEditable(tenant: Pick<Tenant, 'status'>, fields: string[] = []) {
    if (KYC_LOCKED.includes(tenant.status)) {
      const what = fields.length ? fields.join(', ') : 'KYC documents';
      throw new ForbiddenException(
        `${what} cannot be changed while your shop is ${isLive(tenant) ? 'live' : 'being reviewed'}. ` +
          'Contact MarketiX support to update owner or payout details.',
      );
    }
  }

  /** Suspended shops are read-only: no catalogue or settings changes. */
  assertEditable(tenant: Pick<Tenant, 'status'>) {
    if (tenant.status === TenantStatus.SUSPENDED) {
      throw new ForbiddenException('Your shop is suspended, so it is read-only. Contact MarketiX support.');
    }
  }

  /**
   * Update WABA registration details and status for a tenant.
   */
  async updateWabaStatus(
    tenantId: string,
    data: {
      whatsappPhoneNumberId?: string;
      wabaStatus: WabaStatus;
      wabaRegisteredAt?: Date;
    },
  ) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException(`Tenant with ID "${tenantId}" not found.`);
    }

    return this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...(data.whatsappPhoneNumberId && { whatsappPhoneNumberId: data.whatsappPhoneNumberId }),
        wabaStatus: data.wabaStatus,
        ...(data.wabaRegisteredAt && { wabaRegisteredAt: data.wabaRegisteredAt }),
      },
    });
  }

  /**
   * Update the tenant belonging to the authenticated user.
   */
  async update(userId: string, dto: UpdateTenantDto) {
    const tenant = await this.findByUser(userId);
    this.assertEditable(tenant);
    // Re-sending the current value is fine; only actual changes are blocked.
    const kycChanges = KYC_FIELDS.filter((field) => dto[field] !== undefined && dto[field] !== tenant[field]);
    if (kycChanges.length > 0) {
      this.assertKycEditable(tenant, [...kycChanges]);
    }

    if (dto.whatsappNumber !== undefined && !ownNumberOnboardingEnabled()) {
      throw new BadRequestException('WhatsApp numbers are assigned by MarketiX when your shop is approved.');
    }
    if (dto.whatsappNumber && dto.whatsappNumber !== tenant.whatsappNumber) {
      await this.assertWhatsappNumberAvailable(dto.whatsappNumber);
    }

    // If whatsappNumber changes, re-derive countryCode unless explicitly overridden.
    let countryCode: string | undefined;
    if (dto.whatsappNumber !== undefined) {
      countryCode = dto.countryCode || extractCountryCode(dto.whatsappNumber);
    } else if (dto.countryCode !== undefined) {
      countryCode = dto.countryCode;
    }

    return this.prisma.tenant.update({
      where: { userId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.ownerFullName !== undefined && { ownerFullName: dto.ownerFullName }),
        ...(dto.ownerPhone !== undefined && { ownerPhone: dto.ownerPhone }),
        ...(dto.market !== undefined && { market: dto.market }),
        ...(dto.stallLocation !== undefined && { stallLocation: dto.stallLocation }),
        ...(dto.momoNumber !== undefined && { momoNumber: dto.momoNumber }),
        ...(dto.momoName !== undefined && { momoName: dto.momoName }),
        ...(dto.whatsappNumber !== undefined && { whatsappNumber: dto.whatsappNumber }),
        ...(countryCode !== undefined && { countryCode }),
        ...(dto.deliveryFee !== undefined && { deliveryFee: dto.deliveryFee }),
        ...(dto.pickupNote !== undefined && { pickupNote: dto.pickupNote }),
        ...(dto.deliveryAreas !== undefined && { deliveryAreas: toJson(dto.deliveryAreas) }),
        ...(dto.deliverySlots !== undefined && { deliverySlots: toJson(dto.deliverySlots) }),
      },
    });
  }

  private async assertWhatsappNumberAvailable(whatsappNumber: string) {
    const exists = await this.prisma.tenant.findUnique({ where: { whatsappNumber } });
    if (exists) {
      throw new ConflictException('This WhatsApp number is already registered to another tenant.');
    }
  }

  /**
   * Convert a tenant name to a URL-friendly slug, e.g. "My Business" -> "my-business".
   */
  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
