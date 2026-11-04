import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';
import { ReviewDecision } from '@prisma/client';

/** The due-diligence checklist. Every item must be true to approve. */
export class ReviewChecksDto {
  /** Name and photo on the Ghana Card match the owner details. */
  @IsBoolean()
  ghanaCardMatches: boolean;

  /** The MoMo payout number is registered to the owner, not a third party. */
  @IsBoolean()
  momoNameMatches: boolean;

  /** Confirmed the stall location by phone, and that the owner expects WhatsApp orders. */
  @IsBoolean()
  calledOwner: boolean;

  /** Real groceries, sensible prices, no prohibited items. */
  @IsBoolean()
  productsLookGenuine: boolean;
}

export const REVIEW_DECISIONS = [ReviewDecision.APPROVED, ReviewDecision.MORE_INFO, ReviewDecision.REJECTED] as const;

export class ReviewDecisionDto {
  @IsIn(REVIEW_DECISIONS, { message: `decision must be one of: ${REVIEW_DECISIONS.join(', ')}` })
  decision: (typeof REVIEW_DECISIONS)[number];

  /** Optional: ticks saved with PUT /admin/tenants/:id/checks count. Ticks sent here win. */
  @ValidateNested()
  @Type(() => ReviewChecksDto)
  @IsOptional()
  checks?: ReviewChecksDto;

  /** Shown to the vendor. Required for MORE_INFO and REJECTED. */
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  notes?: string;

  /** APPROVED only: the pool number to assign. Defaults to the oldest free one. */
  @IsUUID()
  @IsOptional()
  numberId?: string;

  /** APPROVED only: the WhatsApp display name. Defaults to the shop name. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @IsOptional()
  displayName?: string;
}

export class SuspendTenantDto {
  /** Recorded on the review trail and shown to the vendor. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason: string;
}

export class ReleaseNumberDto {
  /** Required when the shop is still open: it is suspended first, and the vendor is told why. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  @IsOptional()
  reason?: string;
}

/** PUT /admin/tenants/:id/checks: any subset of the checks, saved as the reviewer ticks them. */
export class UpdateReviewChecksDto extends PartialType(ReviewChecksDto) {}
