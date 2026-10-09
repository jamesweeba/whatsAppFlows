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
   * A user can only have one tenant — if one already exists, this throws a ConflictException.
   */
  async create(userId: string, dto: CreateTenantDto) {
    // Check if the user already has a tenant
    const existingTenant = await this.prisma.tenant.findUnique({
      where: { userId },
    });

    if (existingTenant) {
      throw new ConflictException(
        'You already have a tenant. You can only update it.',
      );
    }

    // Generate slug from name if not provided
    const slug = dto.slug ?? this.generateSlug(dto.name);

    // Ensure the slug is unique
    const slugExists = await this.prisma.tenant.findUnique({
      where: { slug },
    });

    if (slugExists) {
      throw new ConflictException(
        `The slug "${slug}" is already taken. Please provide a different one.`,
      );
    }

    // Ensure the whatsapp number is unique
    const whatsappExists = await this.prisma.tenant.findUnique({
      where: { whatsappNumber: dto.whatsappNumber },
    });

    if (whatsappExists) {
      throw new ConflictException(
        'This WhatsApp number is already registered to another tenant.',
      );
    }

    // Derive countryCode from whatsappNumber automatically; allow override via dto
    const countryCode = dto.countryCode || extractCountryCode(dto.whatsappNumber);

    const tenant = await this.prisma.tenant.create({
      data: {
        name: dto.name,
        slug,
        whatsappNumber: dto.whatsappNumber,
        countryCode,
        description: dto.description,
        userId,
        wabaStatus: WabaStatus.PENDING_REGISTRATION,
      },
    });

    return tenant;
  }

  /**
   * Get the tenant belonging to the authenticated user.
   */
  async findByUser(userId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { userId },
    });

    if (!tenant) {
      throw new NotFoundException('You do not have a tenant yet.');
    }

    return tenant;
  }

  /**
   * Find a tenant by Meta WABA Phone Number ID (used in Webhook message routing).
   */
  async findByPhoneNumberId(whatsappPhoneNumberId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { whatsappPhoneNumberId },
    });

    if (!tenant) {
      throw new NotFoundException(
        `Tenant with WhatsApp Phone Number ID "${whatsappPhoneNumberId}" was not found.`,
      );
    }

    return tenant;
  }

  /**
   * Find a tenant by WhatsApp Number.
   */
  async findByWhatsappNumber(whatsappNumber: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { whatsappNumber },
    });

    if (!tenant) {
      throw new NotFoundException(
        `Tenant with WhatsApp number "${whatsappNumber}" was not found.`,
      );
    }

    return tenant;
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
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant with ID "${tenantId}" not found.`);
    }

    return this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...(data.whatsappPhoneNumberId && {
          whatsappPhoneNumberId: data.whatsappPhoneNumberId,
        }),
        wabaStatus: data.wabaStatus,
        ...(data.wabaRegisteredAt && {
          wabaRegisteredAt: data.wabaRegisteredAt,
        }),
      },
    });
  }

  /**
   * Update the tenant belonging to the authenticated user.
   * Only name, description, and whatsappNumber can be updated.
   */
  async update(userId: string, dto: UpdateTenantDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { userId },
    });

    if (!tenant) {
      throw new NotFoundException(
        'You do not have a tenant yet. Create one first.',
      );
    }

    // If updating whatsappNumber, ensure uniqueness
    if (dto.whatsappNumber && dto.whatsappNumber !== tenant.whatsappNumber) {
      const whatsappExists = await this.prisma.tenant.findUnique({
        where: { whatsappNumber: dto.whatsappNumber },
      });

      if (whatsappExists) {
        throw new ConflictException(
          'This WhatsApp number is already registered to another tenant.',
        );
      }
    }

    // If whatsappNumber is being updated, re-derive countryCode unless explicitly overridden
    let resolvedCountryCode: string | undefined;
    if (dto.whatsappNumber !== undefined) {
      resolvedCountryCode = dto.countryCode || extractCountryCode(dto.whatsappNumber);
    } else if (dto.countryCode !== undefined) {
      resolvedCountryCode = dto.countryCode;
    }

    const updated = await this.prisma.tenant.update({
      where: { userId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.whatsappNumber !== undefined && {
          whatsappNumber: dto.whatsappNumber,
        }),
        ...(resolvedCountryCode !== undefined && {
          countryCode: resolvedCountryCode,
        }),
      },
    });

    return updated;
  }

  /**
   * Convert a tenant name to a URL-friendly slug.
   * e.g. "My Business" → "my-business"
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
