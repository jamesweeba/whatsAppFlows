import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto.js';
import { lineTotal, normalizeQuantity, orderTotals } from './order-totals.util.js';

/** Characters used in order references; ambiguous glyphs (0/O, 1/I) are excluded. */
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERENCE_LENGTH = 6;
const MAX_REFERENCE_ATTEMPTS = 5;

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantService: TenantService,
  ) {}

  /**
   * Generate a buyer-friendly, collision-resistant order reference such as `MX-7K2QXD`.
   * The reference doubles as the Paystack transaction reference.
   */
  generateOrderNumber(): string {
    const bytes = crypto.randomBytes(REFERENCE_LENGTH);
    let suffix = '';
    for (let i = 0; i < REFERENCE_LENGTH; i++) {
      suffix += REFERENCE_ALPHABET[bytes[i] % REFERENCE_ALPHABET.length];
    }
    return `MX-${suffix}`;
  }

  /**
   * Create an order with line items for a tenant. Totals are computed server-side.
   * Retries with a fresh reference if the generated order number already exists.
   */
  async createOrder(tenantId: string, dto: CreateOrderDto) {
    const items = dto.items.map((item) => {
      const quantity = normalizeQuantity(item.quantity);
      const unitPrice = Number(item.unitPrice || 0);
      return {
        productId: item.productId || null,
        productName: item.productName,
        unitPrice,
        quantity,
        totalPrice: lineTotal({ unitPrice, quantity }),
      };
    });

    const totals = orderTotals(items, dto.deliveryFee ?? 0);

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.order.create({
          data: {
            tenantId,
            orderNumber: this.generateOrderNumber(),
            buyerPhone: dto.buyerPhone,
            sessionId: dto.sessionId || null,
            status: dto.status || OrderStatus.PENDING,
            totalAmount: totals.total,
            deliveryFee: totals.deliveryFee,
            paymentMethod: dto.paymentMethod ?? null,
            paymentPhone: dto.paymentPhone ?? null,
            momoNetwork: dto.momoNetwork ?? null,
            fulfillment: dto.fulfillment ?? null,
            deliveryAddress: dto.deliveryAddress ?? null,
            notes: dto.notes || null,
            items: { create: items },
          },
          include: { items: true, session: true },
        });
      } catch (err) {
        if (this.isOrderNumberCollision(err) && attempt < MAX_REFERENCE_ATTEMPTS) {
          this.logger.warn(`Order number collision on attempt ${attempt}, retrying.`);
          continue;
        }
        throw err;
      }
    }
  }

  private isOrderNumberCollision(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      String((err.meta as any)?.target ?? '').includes('orderNumber')
    );
  }

  /** Look up an order by its public reference, with items and tenant. */
  findByOrderNumber(orderNumber: string) {
    return this.prisma.order.findUnique({
      where: { orderNumber },
      include: { items: true, tenant: true },
    });
  }

  /** Latest order a buyer placed with a tenant, used for "track my order". */
  findLatestForBuyer(tenantId: string, buyerPhone: string) {
    return this.prisma.order.findFirst({
      where: { tenantId, buyerPhone },
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    });
  }

  /** Attach an order to the chat session it was placed from. */
  linkSession(orderId: string, sessionId: string) {
    return this.prisma.order.update({ where: { id: orderId }, data: { sessionId } });
  }

  /** Record a verified payment. */
  markPaid(orderId: string, note: string) {
    return this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.PAID, notes: note },
    });
  }

  /** Remove an order that could not be completed (e.g. payment initiation failed). */
  async discard(orderId: string) {
    await this.prisma.order.delete({ where: { id: orderId } }).catch((err) => {
      this.logger.warn(`Could not discard order ${orderId}: ${err?.message || err}`);
    });
  }

  /**
   * Create an order initiated by an authenticated vendor user.
   */
  async createForVendor(userId: string, dto: CreateOrderDto) {
    const tenant = await this.tenantService.findByUser(userId);
    return this.createOrder(tenant.id, dto);
  }

  /**
   * List all orders for the authenticated vendor's tenant.
   */
  async findAll(userId: string, page = 1, limit = 10, status?: OrderStatus, search?: string) {
    const tenant = await this.tenantService.findByUser(userId);

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

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { items: true },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data: orders,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Get a single order by ID for the authenticated vendor's tenant.
   */
  async findOne(userId: string, orderId: string) {
    const tenant = await this.tenantService.findByUser(userId);
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: tenant.id },
      include: { items: { include: { product: true } }, session: true },
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
    await this.findOwnedOrder(userId, orderId);
    return this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: dto.status,
        ...(dto.notes ? { notes: dto.notes } : {}),
      },
      include: { items: true },
    });
  }

  /**
   * Delete an order by ID.
   */
  async remove(userId: string, orderId: string) {
    await this.findOwnedOrder(userId, orderId);
    await this.prisma.order.delete({ where: { id: orderId } });
    return { message: `Order "${orderId}" deleted successfully.` };
  }

  private async findOwnedOrder(userId: string, orderId: string) {
    const tenant = await this.tenantService.findByUser(userId);
    const order = await this.prisma.order.findFirst({ where: { id: orderId, tenantId: tenant.id } });
    if (!order) {
      throw new NotFoundException(`Order with ID "${orderId}" not found.`);
    }
    return order;
  }
}
