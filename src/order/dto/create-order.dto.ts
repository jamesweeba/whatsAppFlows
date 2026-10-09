import { OrderStatus } from '@prisma/client';

export interface CreateOrderItemDto {
  productId?: string;
  productName: string;
  unitPrice: number;
  quantity: number;
}

export class CreateOrderDto {
  tenantId?: string;
  buyerPhone!: string;
  sessionId?: string;
  notes?: string;
  status?: OrderStatus;
  items!: CreateOrderItemDto[];
}
