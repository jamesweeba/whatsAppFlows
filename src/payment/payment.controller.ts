import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { OrderStatus } from '@prisma/client';
import { ghCedis } from '../common/money.util.js';
import { OrderService } from '../order/order.service.js';
import { WabaService } from '../waba/waba.service.js';
import { PaystackService } from './paystack.service.js';

@Controller('api/v1/payments')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(
    private readonly paystackService: PaystackService,
    private readonly orderService: OrderService,
    private readonly wabaService: WabaService,
  ) {}

  /**
   * POST /api/v1/payments/paystack/webhook
   * Called by Paystack when a payment status changes (e.g. charge.success).
   */
  @Post('paystack/webhook')
  @HttpCode(HttpStatus.OK)
  async handlePaystackWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-paystack-signature') signature: string,
  ) {
    const rawBody = req.rawBody ?? JSON.stringify(req.body);
    if (!this.paystackService.verifyWebhookSignature(rawBody, signature)) {
      this.logger.warn('Rejected Paystack webhook: invalid signature');
      throw new UnauthorizedException('Invalid signature');
    }

    const { event, data } = req.body ?? {};
    this.logger.log(`Paystack webhook ${event} for reference ${data?.reference}`);

    if (event !== 'charge.success') {
      return { status: 'IGNORED', event };
    }

    const reference = data?.reference;
    if (!reference) {
      throw new BadRequestException('Missing transaction reference');
    }

    const order = await this.orderService.findByOrderNumber(reference);
    if (!order) {
      this.logger.warn(`No order found matching Paystack reference: ${reference}`);
      return { status: 'ORDER_NOT_FOUND', reference };
    }

    if (order.status === OrderStatus.PAID) {
      return { status: 'ALREADY_PAID', reference };
    }

    const amountPaid = data.amount ? data.amount / 100 : order.totalAmount;
    const channel = data.channel || 'mobile_money';
    const paidAt = data.paid_at || new Date().toISOString();
    const note = [order.notes, `Paystack verified: ${ghCedis(amountPaid)} via ${channel} (${paidAt})`]
      .filter(Boolean)
      .join(' | ');

    await this.orderService.markPaid(order.id, note);
    this.logger.log(`Order ${order.orderNumber} marked as PAID.`);

    if (order.tenant?.whatsappPhoneNumberId && order.buyerPhone) {
      const message =
        `🎉 *Payment Confirmed!*\n\nWe have received your payment of *${ghCedis(amountPaid)}* for Order *${order.orderNumber}*.\n\n` +
        `Your order is now being prepared. Thank you for shopping with *${order.tenant.name}*!`;
      try {
        await this.wabaService.sendTextMessage(order.tenant.whatsappPhoneNumberId, order.buyerPhone, message);
      } catch (err: any) {
        this.logger.warn(`Failed to send payment confirmation for ${order.orderNumber}: ${err?.message || err}`);
      }
    }

    return { status: 'PROCESSED', reference };
  }
}
