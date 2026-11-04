import { OrderStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus)
  status: OrderStatus;

  @IsString()
  @IsOptional()
  notes?: string;

  /** Shared with the buyer when the order goes OUT_FOR_DELIVERY. */
  @IsString()
  @IsOptional()
  riderName?: string;

  @IsString()
  @IsOptional()
  riderPhone?: string;
}
