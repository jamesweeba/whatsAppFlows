import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { ProductMeasureDto } from './product-measure.dto.js';

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
}
