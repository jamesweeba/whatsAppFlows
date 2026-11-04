import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** One option in the Flow CHECKOUT "Delivery area" dropdown. */
export class DeliveryAreaDto {
  @IsString()
  @Matches(/^[a-z0-9_]+$/, { message: 'Area id must be lowercase letters, digits or underscores (e.g. "knust").' })
  id: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  title: string;
}

/** One option in the Flow CHECKOUT "When" dropdown. The list always contains id "asap". */
export class DeliverySlotDto {
  @IsString()
  @Matches(/^[a-z0-9_]+$/, { message: 'Slot id must be lowercase letters, digits or underscores (e.g. "today_pm").' })
  id: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  title: string;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  description?: string;
}
