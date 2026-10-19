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
import { PrismaService } from '../prisma/prisma.service.js';
import { WabaService } from '../waba/waba.service.js';
import { PaystackService } from './paystack.service.js';

@Controller('api/v1/payments')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(
    private readonly paystackService: PaystackService,
    private readonly prisma: PrismaService,
    private readonly wabaService: WabaService,
  ) {}

  /**
   * POST /api/v1/payments/paystack/webhook
   * Webhook endpoint called by Paystack when payment status updates (e.g. charge.success).
   */
  @Post('paystack/webhook')
  @HttpCode(HttpStatus.OK)
  async handlePaystackWebhook(
    @Req() req: Request,
    @Headers('x-paystack-signature') signature: string,
  ) {
    const rawBody = (req as any).rawBody || JSON.stringify(req.body);

    // 1. Verify signature
    const isValid = this.paystackService.verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      this.logger.warn('Unauthorized webhook request: Invalid Paystack signature');
      throw new UnauthorizedException('Invalid signature');
    }

    const payload = req.body;
    const event = payload?.event;
    const data = payload?.data;

    this.logger.log(`Received Paystack Webhook Event: ${event} for reference: ${data?.reference}`);

    if (event === 'charge.success') {
      const reference = data?.reference;
      if (!reference) {
        throw new BadRequestException('Missing transaction reference');
      }

      // Find order by orderNumber
      const order = await this.prisma.order.findUnique({
        where: { orderNumber: reference },
        include: {
          tenant: true,
          items: true,
        },
      });

      if (!order) {
        this.logger.warn(`No order found matching Paystack reference: ${reference}`);
        return { status: 'ORDER_NOT_FOUND', reference };
      }

      // Idempotency: skip if already marked PAID
      if (order.status === OrderStatus.PAID) {
        this.logger.log(`Order ${reference} is already marked as PAID.`);
        return { status: 'ALREADY_PAID', reference };
      }

      const amountPaid = (data.amount ? data.amount / 100 : order.totalAmount).toFixed(2);
      const paymentChannel = data.channel || 'mobile_money';
      const paidAt = data.paid_at || new Date().toISOString();

      const existingNotes = order.notes || '';
      const updateNotes = `${existingNotes} | Paystack Verified: ₵${amountPaid} via ${paymentChannel} (${paidAt})`.trim();

      // Update Order Status to PAID
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.PAID,
          notes: updateNotes,
        },
      });

      this.logger.log(`Order ${order.orderNumber} successfully marked as PAID.`);

      // Send WhatsApp payment confirmation to buyer
      if (order.tenant?.whatsappPhoneNumberId && order.buyerPhone) {
        const confirmMsg = `🎉 *Payment Confirmed!*\n\nWe have received your payment of *GH₵${amountPaid}* for Order *${order.orderNumber}*.\n\nYour fresh groceries are now being packed and prepared. Thank you for shopping with *${order.tenant.name}*! 🛵💨`;

        try {
          await this.wabaService.sendTextMessage(
            order.tenant.whatsappPhoneNumberId,
            order.buyerPhone,
            confirmMsg,
          );
        } catch (msgErr: any) {
          this.logger.warn(
            `Failed to send WhatsApp payment confirmation message to ${order.buyerPhone}: ${msgErr.message || msgErr}`,
          );
        }
      }

      return { status: 'PROCESSED', reference };
    }

    return { status: 'IGNORED', event };
  }
}
