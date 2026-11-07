import { Fulfillment, OrderStatus, PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_DELIVERY_FEE } from '../../payout/payout-math.js';

export class CreateOrderItemDto {
  @IsString()
  @IsOptional()
  productId?: string;

  @IsString()
  @IsNotEmpty()
  productName: string;

  /** Measure the item was sold in (e.g. "basket"); lets the Flow repeat a past order. */
  @IsString()
  @IsOptional()
  measureCode?: string;

  @IsNumber()
  @Min(0)
  unitPrice: number;

  @IsNumber()
  @Min(1)
  quantity: number;
}

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  buyerPhone: string;

  @IsString()
  @IsOptional()
  sessionId?: string;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsEnum(OrderStatus)
  @IsOptional()
  status?: OrderStatus;

  @IsEnum(PaymentMethod)
  @IsOptional()
  paymentMethod?: PaymentMethod;

  /** Number charged for mobile money, which may differ from the buyer's WhatsApp number. */
  @IsString()
  @IsOptional()
  paymentPhone?: string;

  @IsString()
  @IsOptional()
  momoNetwork?: string;

  @IsEnum(Fulfillment)
  @IsOptional()
  fulfillment?: Fulfillment;

  @IsString()
  @IsOptional()
  deliveryAddress?: string;

  @IsNumber()
  @Min(0)
  @Max(MAX_DELIVERY_FEE, { message: `deliveryFee can be at most GH₵ ${MAX_DELIVERY_FEE}.` })
  @IsOptional()
  deliveryFee?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];
}
