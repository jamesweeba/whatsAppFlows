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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ProductMeasureDto } from './product-measure.dto.js';

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  /** Required unless measures are given; then it defaults to the cheapest measure. */
  @ValidateIf((o: CreateProductDto) => !o.measures?.length || o.price !== undefined)
  @IsNumber()
  @Min(0)
  price?: number;

  @IsString()
  @IsOptional()
  image?: string;

  @IsBoolean()
  @IsOptional()
  inStock?: boolean;

  /** One of the predefined category ids from GET /api/v1/categories, e.g. "veg_fruits". */
  @IsString()
  @IsNotEmpty()
  categoryId: string;

  @IsString()
  @IsOptional()
  note?: string;

  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ProductMeasureDto)
  @IsOptional()
  measures?: ProductMeasureDto[];
}
