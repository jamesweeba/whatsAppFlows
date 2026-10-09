import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto.js';

@Injectable()
export class OrderService {
  constructor(private readonly prisma: PrismaService) {}

  private async getTenantForUser(userId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { userId },
    });
    if (!tenant) {
      throw new BadRequestException(
        'You must create a tenant before managing orders.',
      );
    }
    return tenant;
  }

  /**
   * Create an order with line items for a given tenant.
   */
  async createOrder(tenantId: string, dto: CreateOrderDto) {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('Order must contain at least one item.');
    }

    let totalAmount = 0;
    const itemsData = dto.items.map((item) => {
      const qty = Math.max(1, Number(item.quantity || 1));
      const unitPrice = Number(item.unitPrice || 0);
      const totalPrice = qty * unitPrice;
      totalAmount += totalPrice;

      return {
        productId: item.productId || null,
        productName: item.productName,
        unitPrice,
        quantity: qty,
        totalPrice,
      };
    });

    return this.prisma.order.create({
      data: {
        tenantId,
        buyerPhone: dto.buyerPhone,
        sessionId: dto.sessionId || null,
        status: dto.status || OrderStatus.PENDING,
        totalAmount,
        notes: dto.notes || null,
        items: {
          create: itemsData,
        },
      },
      include: {
        items: true,
        session: true,
      },
    });
  }

  /**
   * Create an order initiated by an authenticated vendor user.
   */
  async createForVendor(userId: string, dto: CreateOrderDto) {
    const tenant = await this.getTenantForUser(userId);
    return this.createOrder(tenant.id, dto);
  }

  /**
   * List all orders for the authenticated vendor's tenant.
   */
  async findAll(
    userId: string,
    page = 1,
    limit = 10,
    status?: OrderStatus,
    search?: string,
  ) {
    const tenant = await this.getTenantForUser(userId);

    const where: Prisma.OrderWhereInput = {
      tenantId: tenant.id,
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { buyerPhone: { contains: search, mode: 'insensitive' } },
              { orderNumber: { contains: search, mode: 'insensitive' } },
              { notes: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          items: true,
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data: orders,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get a single order by ID for the authenticated vendor's tenant.
   */
  async findOne(userId: string, orderId: string) {
    const tenant = await this.getTenantForUser(userId);

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: tenant.id },
      include: {
        items: {
          include: {
            product: true,
          },
        },
        session: true,
      },
    });

    if (!order) {
      throw new NotFoundException(`Order with ID "${orderId}" not found.`);
    }

    return order;
  }

  /**
   * Update order status or notes.
   */
  async updateStatus(userId: string, orderId: string, dto: UpdateOrderStatusDto) {
    const tenant = await this.getTenantForUser(userId);

    const existingOrder = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: tenant.id },
    });

    if (!existingOrder) {
      throw new NotFoundException(`Order with ID "${orderId}" not found.`);
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: dto.status,
        ...(dto.notes ? { notes: dto.notes } : {}),
      },
      include: {
        items: true,
      },
    });
  }

  /**
   * Delete an order by ID.
   */
  async remove(userId: string, orderId: string) {
    const tenant = await this.getTenantForUser(userId);

    const existingOrder = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: tenant.id },
    });

    if (!existingOrder) {
      throw new NotFoundException(`Order with ID "${orderId}" not found.`);
    }

    await this.prisma.order.delete({
      where: { id: orderId },
    });

    return { message: `Order "${orderId}" deleted successfully.` };
  }
}
