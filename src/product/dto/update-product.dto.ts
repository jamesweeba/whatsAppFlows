import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PROMOTER_RATE_MAX, PROMOTER_RATE_MIN } from '../../promoter/promoter-rules.js';
import { ProductMeasureDto } from './product-measure.dto.js';

const RATE_MESSAGE = `promoterRate must be a whole number from ${PROMOTER_RATE_MIN} to ${PROMOTER_RATE_MAX}, or null for the shop's rate.`;

export class UpdateProductDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  price?: number;

  @IsString()
  @IsOptional()
  image?: string;

  @IsBoolean()
  @IsOptional()
  inStock?: boolean;

  /** Move the product to another predefined category. */
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  categoryId?: string;

  @IsString()
  @IsOptional()
  note?: string;

  /** Replaces all of the product's measures. An empty array removes them. */
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ProductMeasureDto)
  @IsOptional()
  measures?: ProductMeasureDto[];

  /** Promoter commission for this product's links, whole percent. Null: the shop's rate. */
  @IsInt({ message: RATE_MESSAGE })
  @Min(PROMOTER_RATE_MIN, { message: RATE_MESSAGE })
  @Max(PROMOTER_RATE_MAX, { message: RATE_MESSAGE })
  @IsOptional()
  promoterRate?: number | null;
}
