import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { WabaStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateTenantDto } from './dto/create-tenant.dto.js';
import { UpdateTenantDto } from './dto/update-tenant.dto.js';
import { extractCountryCode } from './utils/country-code.util.js';

@Injectable()
export class TenantService {
  constructor(private readonly prisma: PrismaService) {}

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

    await this.assertWhatsappNumberAvailable(dto.whatsappNumber);

    return this.prisma.tenant.create({
      data: {
        name: dto.name,
        slug,
        whatsappNumber: dto.whatsappNumber,
        countryCode: dto.countryCode || extractCountryCode(dto.whatsappNumber),
        description: dto.description,
        ...(dto.deliveryFee !== undefined && { deliveryFee: dto.deliveryFee }),
        ...(dto.pickupNote !== undefined && { pickupNote: dto.pickupNote }),
        userId,
        wabaStatus: WabaStatus.PENDING_REGISTRATION,
      },
    });
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
        ...(dto.whatsappNumber !== undefined && { whatsappNumber: dto.whatsappNumber }),
        ...(countryCode !== undefined && { countryCode }),
        ...(dto.deliveryFee !== undefined && { deliveryFee: dto.deliveryFee }),
        ...(dto.pickupNote !== undefined && { pickupNote: dto.pickupNote }),
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
