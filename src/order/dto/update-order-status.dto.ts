import { OrderStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus)
  status: OrderStatus;

  @IsString()
  @IsOptional()
  notes?: string;

  /** Shared with the buyer when the order goes OUT_FOR_DELIVERY. */
  @IsString()
  @MaxLength(60)
  @IsOptional()
  riderName?: string;

  @IsString()
  @MaxLength(20)
  @Matches(/^\+?[0-9 ()-]*$/, { message: 'riderPhone must be a phone number.' })
  @IsOptional()
  riderPhone?: string;
}
