import { OmitType, PartialType } from '@nestjs/mapped-types';
import { IsOptional, IsString } from 'class-validator';
import { CreateTenantDto } from './create-tenant.dto.js';

/** Every shop setting from CreateTenantDto, all optional, except the slug (fixed once created). */
export class UpdateTenantDto extends PartialType(OmitType(CreateTenantDto, ['slug'] as const)) {
  /**
   * The shop's own WhatsApp number, for own-number OTP onboarding only
   * (ALLOW_OWN_NUMBER_ONBOARDING=true). Pool numbers are assigned by a super admin.
   */
  @IsString()
  @IsOptional()
  whatsappNumber?: string;
}
