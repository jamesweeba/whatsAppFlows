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
import { ghCedis } from '../common/money.util.js';
import { CANCELLED_ORDER_STATUSES, UNPAID_ORDER_STATUSES } from '../order/order-status-groups.js';
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

    if (CANCELLED_ORDER_STATUSES.includes(order.status)) {
      // Money arrived for an order that was cancelled: leave it alone, flag it for a refund.
      this.logger.error(`Payment received for ${order.status} order ${reference}. Check it and refund the buyer if needed.`);
      return { status: 'ORDER_CLOSED', reference };
    }
    if (!UNPAID_ORDER_STATUSES.includes(order.status)) {
      return { status: 'ALREADY_PAID', reference };
    }

    // The signature proves Paystack sent this, not that the buyer paid the full price in
    // cedis: check both before accepting it. Paystack amounts are in pesewas.
    const expectedPesewas = Math.round(order.totalAmount * 100);
    const paidPesewas = Number(data.amount);
    const currency = String(data.currency ?? '').toUpperCase();
    if (currency !== 'GHS' || !Number.isFinite(paidPesewas) || paidPesewas < expectedPesewas) {
      this.logger.error(
        `Rejected payment for ${reference}: got ${data.amount ?? 'no amount'} ${currency || 'no currency'}, expected ${expectedPesewas} GHS (pesewas). Order left unpaid.`,
      );
      return { status: 'AMOUNT_MISMATCH', reference };
    }

    const amountPaid = paidPesewas / 100;
    const channel = data.channel || 'mobile_money';
    const paidAt = data.paid_at || new Date().toISOString();
    const note = [order.notes, `Paystack verified: ${ghCedis(amountPaid)} via ${channel} (${paidAt})`]
      .filter(Boolean)
      .join(' | ');

    if (!(await this.orderService.markPaid(order.id, note))) {
      // A duplicate webhook (or a status change) got there first.
      return { status: 'ALREADY_PAID', reference };
    }
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
