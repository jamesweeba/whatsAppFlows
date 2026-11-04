import { IsNotEmpty, IsNumber, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

/** A way a product is sold, e.g. { code: "basket", label: "Basket", price: 120 }. */
export class ProductMeasureDto {
  @IsString()
  @Matches(/^[a-z0-9_]+$/, { message: 'Measure code must be lowercase letters, digits or underscores (e.g. "basket").' })
  code: string;

  @IsString()
  @IsNotEmpty()
  /** Shown as "<label> · GH₵ <price>" in a 30-character option, so keep it short. */
  @MaxLength(15)
  label: string;

  @IsNumber()
  @Min(0)
  price: number;

  /** Optional hint under the option, e.g. "Best value". */
  @IsString()
  @IsOptional()
  @MaxLength(300)
  description?: string;
}
