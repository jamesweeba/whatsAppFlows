import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaymentMethod, Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { ghCedis } from '../common/money.util.js';
import { isHiddenNumber, toE164 } from '../common/phone.util.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { WabaService } from '../waba/waba.service.js';
import { PayoutService } from '../payout/payout.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto.js';
import { DELIVERED_ORDER_STATUSES, PAID_ORDER_STATUSES, UNPAID_ORDER_STATUSES } from './order-status-groups.js';
import { lineTotal, normalizeQuantity, orderTotals } from './order-totals.util.js';

/** Characters used in order references; ambiguous glyphs (0/O, 1/I) are excluded. */
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERENCE_LENGTH = 6;
const MAX_REFERENCE_ATTEMPTS = 5;
/** A location pin is attached to the newest order that asked for one within this window. */
const LOCATION_PIN_WINDOW_MS = 30 * 60 * 1000;

/**
 * The reply button on the "on its way" message: its id is this prefix plus the order
 * number, which WhatsApp sends back when the buyer taps it.
 */
export const ORDER_RECEIVED_BUTTON_PREFIX = 'order_received:';
export const ORDER_RECEIVED_BUTTON_TITLE = '✅ I got my order';
const ORDER_RECEIVED_PATTERN = /^order_received:(\S+)$/;

/** The order number in an "I got my order" button tap, or null for any other message. */
export function orderReceivedTap(text: string): string | null {
  return ORDER_RECEIVED_PATTERN.exec(text.trim())?.[1] ?? null;
}

/** The rows of the "rate your order" list: their id is this prefix, the order number, and the stars. */
export const ORDER_RATING_PREFIX = 'rate_order:';
const ORDER_RATING_PATTERN = /^rate_order:(\S+):([1-5])$/;
const RATING_ROWS: { stars: number; label: string }[] = [
  { stars: 5, label: 'Excellent' },
  { stars: 4, label: 'Good' },
  { stars: 3, label: 'Okay' },
  { stars: 2, label: 'Poor' },
  { stars: 1, label: 'Very poor' },
];

/** The order and rating in a "rate your order" list tap, or null for any other message. */
export function orderRatingTap(text: string): { orderNumber: string; rating: number } | null {
  const match = ORDER_RATING_PATTERN.exec(text.trim());
  return match ? { orderNumber: match[1], rating: Number(match[2]) } : null;
}

/** Delivery and Flow details that only the server sets, never the vendor-facing DTO. */
export type OrderDetails = Pick<
  Prisma.OrderUncheckedCreateInput,
  'customerName' | 'deliveryArea' | 'landmark' | 'contactPhone' | 'deliverySlot' | 'flowCartId'
>;

export interface DeliveryLocation {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

export const PAYSTACK_ONLY_MESSAGE =
  'Only Paystack can mark this order as paid: the buyer was sent a MoMo prompt. It changes to Paid by itself once they approve it on their phone.';

/**
 * Once a Paystack MoMo prompt went out, the order becomes paid only when Paystack confirms the
 * money arrived, never by hand: otherwise a vendor could pack and send an order MarketiX was
 * never paid for. Cash orders, orders the vendor took and collected for themselves (no prompt),
 * orders Paystack confirmed, and orders already past payment are not affected.
 */
export function canMarkPaidByHand(
  order: { status: OrderStatus; paymentMethod: PaymentMethod | null; paymentRequestedAt: Date | null; paystackPaidAt: Date | null },
  next: OrderStatus,
): boolean {
  if (order.paymentMethod === PaymentMethod.COD || !order.paymentRequestedAt || order.paystackPaidAt) return true;
  if (!PAID_ORDER_STATUSES.includes(next)) return true; // e.g. cancelling an unpaid order
  return PAID_ORDER_STATUSES.includes(order.status); // already moving through delivery
}

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantService: TenantService,
    private readonly wabaService: WabaService,
    private readonly payouts: PayoutService,
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
  async createOrder(tenantId: string, dto: CreateOrderDto, details: OrderDetails = {}) {
    const items = dto.items.map((item) => {
      const quantity = normalizeQuantity(item.quantity);
      const unitPrice = Number(item.unitPrice || 0);
      return {
        productId: item.productId || null,
        productName: item.productName,
        measureCode: item.measureCode ?? null,
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
            ...details,
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

  /** Look up the order a Flow cart was checked out into, if any. */
  findByFlowCart(flowCartId: string) {
    return this.prisma.order.findUnique({ where: { flowCartId }, include: { items: true } });
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

  /**
   * Record a verified payment. Only an unpaid order moves to PAID, so a repeated webhook
   * can't pull an order that has moved on (or was cancelled) back to PAID. Returns false
   * when nothing changed.
   */
  async markPaid(orderId: string, note: string, amountPesewas: number, channel: string | null = null): Promise<boolean> {
    const { count } = await this.prisma.order.updateMany({
      where: { id: orderId, status: { in: UNPAID_ORDER_STATUSES } },
      // paystackPaidAt: the money is in MarketiX's Paystack balance, so the vendor can be paid from it.
      // paystackChannel: card earnings are held before the vendor can withdraw them.
      data: { status: OrderStatus.PAID, notes: note, paystackPaidAt: new Date(), paystackAmount: amountPesewas, paystackChannel: channel },
    });
    return count === 1;
  }

  /** Mark the MoMo prompt as sent. Returns false if another request already claimed it. */
  async claimPaymentRequest(orderId: string): Promise<boolean> {
    const { count } = await this.prisma.order.updateMany({
      where: { id: orderId, paymentRequestedAt: null },
      data: { paymentRequestedAt: new Date() },
    });
    return count === 1;
  }

  /** Mark a Flow order's confirmation as sent. Returns false if another request already claimed it. */
  async claimConfirmation(orderId: string): Promise<boolean> {
    const { count } = await this.prisma.order.updateMany({
      where: { id: orderId, confirmationSentAt: null },
      data: { confirmationSentAt: new Date() },
    });
    return count === 1;
  }

  /** Release the claim so the vendor can retry after the MoMo prompt failed to start. */
  releasePaymentRequest(orderId: string) {
    return this.prisma.order.update({ where: { id: orderId }, data: { paymentRequestedAt: null } });
  }

  markLocationRequested(orderId: string) {
    return this.prisma.order.update({ where: { id: orderId }, data: { locationRequestedAt: new Date() } });
  }

  /**
   * Attach a shared location pin to the buyer's newest order that asked for one in the
   * last 30 minutes. Returns the order, or null when no order is waiting for a pin.
   */
  async attachLocation(tenantId: string, buyerPhone: string, location: DeliveryLocation) {
    const order = await this.prisma.order.findFirst({
      where: {
        tenantId,
        buyerPhone,
        locationRequestedAt: { gte: new Date(Date.now() - LOCATION_PIN_WINDOW_MS) },
      },
      orderBy: { locationRequestedAt: 'desc' },
    });
    if (!order) return null;

    return this.prisma.order.update({
      where: { id: order.id },
      data: {
        locationLatitude: location.latitude,
        locationLongitude: location.longitude,
        locationName: location.name ?? null,
        locationAddress: location.address ?? null,
        locationReceivedAt: new Date(),
      },
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
    const previous = await this.findOwnedOrder(userId, orderId);
    if (!canMarkPaidByHand(previous, dto.status)) throw new BadRequestException(PAYSTACK_ONLY_MESSAGE);
    const order = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: dto.status,
        ...(dto.notes ? { notes: dto.notes } : {}),
        ...(dto.riderName !== undefined && { riderName: dto.riderName }),
        ...(dto.riderPhone !== undefined && { riderPhone: dto.riderPhone }),
      },
      include: { items: true, tenant: true },
    });

    if (previous.status !== order.status) {
      await this.notifyStatusChange(order);
      if (DELIVERED_ORDER_STATUSES.includes(order.status)) this.settle(order.id);
    }
    const { tenant: _, ...result } = order;
    return result;
  }

  /**
   * WhatsApp the buyer when their order is packed, dispatched or delivered.
   * Failures are logged, never surfaced: the status change itself already succeeded.
   */
  private async notifyStatusChange(order: Prisma.OrderGetPayload<{ include: { tenant: true } }>) {
    const message = this.statusMessage(order);
    const phoneNumberId = order.tenant.whatsappPhoneNumberId;
    if (!message || !phoneNumberId || !order.buyerPhone || isHiddenNumber(order.buyerPhone)) return;

    try {
      if (order.status === OrderStatus.OUT_FOR_DELIVERY) {
        await this.sendOutForDelivery(phoneNumberId, order.buyerPhone, order.orderNumber, message);
      } else {
        await this.wabaService.sendTextMessage(phoneNumberId, order.buyerPhone, message);
      }
    } catch (err: any) {
      this.logger.warn(`Failed to send ${order.status} update for ${order.orderNumber}: ${err?.message || err}`);
    }
  }

  /**
   * Update the vendor's balance for a delivered order and pay them if due. In the
   * background: a slow Paystack call must not hold up the vendor or the buyer's reply.
   */
  private settle(orderId: string) {
    this.payouts.settleOrder(orderId).catch((err: any) => this.logger.error(`Payout step for order ${orderId} failed: ${err?.message || err}`));
  }

  /** "On its way" with an "I got my order" button; plain text if WhatsApp refuses the button. */
  private async sendOutForDelivery(phoneNumberId: string, buyerPhone: string, orderNumber: string, message: string) {
    try {
      await this.wabaService.sendInteractiveButtons({
        phoneNumberId,
        toPhone: buyerPhone,
        bodyText: `${message}\n\nTap the button when you have your order.`,
        buttons: [{ id: `${ORDER_RECEIVED_BUTTON_PREFIX}${orderNumber}`, title: ORDER_RECEIVED_BUTTON_TITLE }],
      });
    } catch (err: any) {
      this.logger.warn(`Out-for-delivery button for ${orderNumber} failed (${err?.message || err}); sending text instead.`);
      await this.wabaService.sendTextMessage(phoneNumberId, buyerPhone, message);
    }
  }

  /**
   * The buyer tapped "I got my order". Only the buyer's own number can confirm, and only an
   * order that is out for delivery moves to DELIVERED. Returns the reply for the buyer.
   */
  async confirmReceivedByBuyer(tenantId: string, buyerPhone: string, orderNumber: string): Promise<string> {
    const order = await this.prisma.order.findFirst({ where: { tenantId, orderNumber } });
    if (!order || toE164(order.buyerPhone) !== toE164(buyerPhone)) {
      this.logger.warn(`Ignored "I got my order" for ${orderNumber}: not this buyer's order.`);
      return `We couldn't find order *${orderNumber}* on your number. If you need help, just reply here.`;
    }

    if (order.status === OrderStatus.OUT_FOR_DELIVERY) {
      // Conditional, so a double tap or a vendor update at the same moment can't apply twice.
      const { count } = await this.prisma.order.updateMany({
        where: { id: order.id, status: OrderStatus.OUT_FOR_DELIVERY },
        data: { status: OrderStatus.DELIVERED, deliveryConfirmedAt: new Date() },
      });
      if (count === 1) {
        this.logger.log(`Buyer confirmed receipt of ${orderNumber}; marked DELIVERED.`);
        this.settle(order.id);
        return `✅ Thank you! Order *${orderNumber}* is marked as received. Enjoy, and thanks for shopping with us!`;
      }
      return this.confirmReceivedByBuyer(tenantId, buyerPhone, orderNumber);
    }

    if (order.status === OrderStatus.DELIVERED || order.status === OrderStatus.COMPLETED) {
      if (!order.deliveryConfirmedAt) {
        await this.prisma.order.update({ where: { id: order.id }, data: { deliveryConfirmedAt: new Date() } });
        this.settle(order.id);
      }
      return `✅ Order *${orderNumber}* is already marked as received. Thanks for confirming!`;
    }

    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REFUNDED) {
      return `Order *${orderNumber}* was cancelled, so there's nothing to confirm. If that's wrong, just reply here.`;
    }
    return `Order *${orderNumber}* isn't out for delivery yet. We'll message you when it's on its way.`;
  }

  /**
   * Ask the buyer to rate an order they've confirmed receiving: a 1-5 list on WhatsApp. Sent
   * once per order, only to the buyer who placed it, and not once it's rated.
   */
  async requestRating(tenant: { id: string; name: string; whatsappPhoneNumberId: string | null }, buyerPhone: string, orderNumber: string): Promise<void> {
    if (!tenant.whatsappPhoneNumberId) return;
    const order = await this.prisma.order.findFirst({ where: { tenantId: tenant.id, orderNumber } });
    if (!order || toE164(order.buyerPhone) !== toE164(buyerPhone) || !order.deliveryConfirmedAt || order.buyerRating !== null) return;

    // Claimed first, so a double tap doesn't send two lists.
    const { count } = await this.prisma.order.updateMany({ where: { id: order.id, ratingRequestedAt: null }, data: { ratingRequestedAt: new Date() } });
    if (count !== 1) return;
    try {
      await this.wabaService.sendInteractiveList({
        phoneNumberId: tenant.whatsappPhoneNumberId,
        toPhone: buyerPhone,
        bodyText: `How was your order *${orderNumber}* from *${tenant.name}*? Your rating helps other buyers and keeps shops on MarketiX at their best.`,
        buttonText: 'Rate your order',
        sectionTitle: 'Your rating',
        rows: RATING_ROWS.map((r) => ({ id: `${ORDER_RATING_PREFIX}${orderNumber}:${r.stars}`, title: '⭐'.repeat(r.stars), description: r.label })),
      });
    } catch (err: any) {
      this.logger.warn(`Rating request for ${orderNumber} failed: ${err?.message || err}`);
      await this.prisma.order.update({ where: { id: order.id }, data: { ratingRequestedAt: null } }); // can be asked again
    }
  }

  /**
   * The buyer picked a rating from the list. Only the buyer's own, received order can be
   * rated, and only once. Returns the reply for the buyer.
   */
  async rateByBuyer(tenantId: string, buyerPhone: string, orderNumber: string, rating: number): Promise<string> {
    const order = await this.prisma.order.findFirst({ where: { tenantId, orderNumber } });
    if (!order || toE164(order.buyerPhone) !== toE164(buyerPhone)) {
      this.logger.warn(`Ignored rating for ${orderNumber}: not this buyer's order.`);
      return `We couldn't find order *${orderNumber}* on your number. If you need help, just reply here.`;
    }
    if (!order.deliveryConfirmedAt) return `You can rate order *${orderNumber}* once you have it.`;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return 'Please pick a rating from 1 to 5 stars.';

    const { count } = await this.prisma.order.updateMany({ where: { id: order.id, buyerRating: null }, data: { buyerRating: rating, ratedAt: new Date() } });
    if (count !== 1) return `You've already rated order *${orderNumber}*. Thank you!`;

    this.logger.log(`${orderNumber} rated ${rating}/5 by the buyer.`);
    if (rating >= 4) return `🙏 Thank you for rating order *${orderNumber}* ${'⭐'.repeat(rating)}! We're glad you enjoyed it.`;
    if (rating === 3) return `Thanks for rating order *${orderNumber}*. We'll keep working to make your next order better.`;
    return `😔 We're sorry order *${orderNumber}* wasn't great, and thank you for telling us. MarketiX will look into it. If you'd like to say what went wrong, just reply here.`;
  }

  private statusMessage(order: { orderNumber: string; status: OrderStatus; riderName: string | null; riderPhone: string | null; totalAmount: number; paymentMethod: string | null }): string | null {
    switch (order.status) {
      case OrderStatus.PROCESSING:
        return `📦 Your order *${order.orderNumber}* is packed and will be on its way shortly.`;
      case OrderStatus.OUT_FOR_DELIVERY: {
        const rider = [order.riderName, order.riderPhone].filter(Boolean).join(', ');
        const cash = order.paymentMethod === 'COD' ? `\nPlease have *${ghCedis(order.totalAmount)}* ready in cash.` : '';
        return `🛵 Your order *${order.orderNumber}* is on its way!${rider ? `\nRider: ${rider}` : ''}${cash}`;
      }
      case OrderStatus.DELIVERED:
        return `✅ Your order *${order.orderNumber}* has been delivered. Thank you for shopping with us!`;
      default:
        return null;
    }
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
