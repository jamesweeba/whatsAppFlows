import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsPhone } from '../../common/validators.js';
import { DeliveryAreaDto, DeliverySlotDto } from './delivery-options.dto.js';

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

  /** Shop owner, checked against the Ghana Card during review. */
  @IsString()
  @IsNotEmpty()
  ownerFullName: string;

  /** The owner's own phone: welcome, review and order alerts go here. Not the buyer-facing number. */
  @IsPhone()
  ownerPhone: string;

  /** Market or town, e.g. "Kejetia, Kumasi". */
  @IsString()
  @IsOptional()
  market?: string;

  /** Where the stall is inside the market. */
  @IsString()
  @IsOptional()
  stallLocation?: string;

  /** MoMo payout number and the name it is registered to. */
  @IsPhone()
  @IsOptional()
  momoNumber?: string;

  @IsString()
  @IsOptional()
  momoName?: string;

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

  /** Areas the shop delivers to, shown on the Flow CHECKOUT screen. */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeliveryAreaDto)
  @IsOptional()
  deliveryAreas?: DeliveryAreaDto[];

  /** Delivery time slots; an "asap" slot is added automatically when missing. */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeliverySlotDto)
  @IsOptional()
  deliverySlots?: DeliverySlotDto[];
}
