import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

export class CreateTenantDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsOptional()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Slug must be lowercase alphanumeric with hyphens only (e.g. "my-business")',
  })
  slug?: string;

  @IsString()
  @IsNotEmpty()
  whatsappNumber: string;

  @IsString()
  @IsOptional()
  countryCode?: string;

  @IsString()
  @IsOptional()
  description?: string;

  /** Flat delivery fee in GHS added to delivery orders. */
  @IsNumber()
  @Min(0)
  @IsOptional()
  deliveryFee?: number;

  /** Shown to buyers who choose pickup, e.g. "Pick up at Osu branch, ready in 30 minutes." */
  @IsString()
  @IsOptional()
  pickupNote?: string;
}
