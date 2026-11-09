import { Injectable, Logger } from '@nestjs/common';
import { Order, OrderItem, PaymentMethod, PayoutSource, Promoter, Tenant, VendorPayout } from '@prisma/client';
import { optionalEnv } from '../common/config.js';
import { ghCedis } from '../common/money.util.js';
import { isHiddenNumber, toGhanaLocal, toInternationalDigits } from '../common/phone.util.js';
import { WabaService } from '../waba/waba.service.js';

/**
 * WhatsApp messages to vendors (not buyers). Onboarding messages come from the platform's
 * own number (PLATFORM_PHONE_NUMBER_ID); order alerts come from the shop's number.
 * Everything here is best-effort: a failed message is logged and never fails the caller.
 *
 * Meta only delivers free-form text inside a 24-hour window opened by the recipient, so
 * messages that must always arrive (new-order alerts) use an approved template instead.
 */
/** The approved new-order template (WhatsApp Manager); the name and language can be changed in the environment. */
const VENDOR_ORDER_TEMPLATE = () => ({
  name: optionalEnv('VENDOR_ORDER_TEMPLATE', 'order'),
  language: optionalEnv('VENDOR_ORDER_TEMPLATE_LANGUAGE', 'en_US'),
});

/** The approved delivery template sent to the rider when an order goes out (WhatsApp Manager). */
const RIDER_DELIVERY_TEMPLATE = () => ({
  name: optionalEnv('RIDER_DELIVERY_TEMPLATE', 'rider_delivery'),
  language: optionalEnv('RIDER_DELIVERY_TEMPLATE_LANGUAGE', 'en_US'),
});

/** How much of the item list fits in the rider template. */
const MAX_ITEMS_TEXT = 300;

/** What the rider's delivery message needs from an order. */
export type RiderOrder = Pick<
  Order,
  | 'orderNumber'
  | 'riderName'
  | 'riderPhone'
  | 'customerName'
  | 'contactPhone'
  | 'buyerPhone'
  | 'deliveryArea'
  | 'landmark'
  | 'deliveryAddress'
  | 'deliverySlot'
  | 'locationLatitude'
  | 'locationLongitude'
  | 'paymentMethod'
  | 'paystackPaidAt'
  | 'totalAmount'
> & { items: Pick<OrderItem, 'quantity' | 'productName'>[] };

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(private readonly wabaService: WabaService) {}

  vendorWelcome(tenant: Tenant) {
    return this.fromPlatform(
      tenant,
      `👋 Welcome to MarketiX, ${tenant.ownerFullName ?? tenant.name}! Your next step is loading your products. ` +
        'Once you have at least one product in stock, we will review your shop.',
    );
  }

  vendorLive(tenant: Tenant, displayNumber: string) {
    return this.fromPlatform(
      tenant,
      `🎉 *${tenant.name}* is live! Buyers can now order from you on WhatsApp at ${displayNumber}. ` +
        `Share this link with your customers: https://wa.me/${toInternationalDigits(displayNumber)}?text=Hi`,
    );
  }

  vendorMoreInfo(tenant: Tenant, notes: string) {
    return this.fromPlatform(tenant, `📝 We need a little more before *${tenant.name}* can go live:\n\n${notes}\n\nUpdate your shop, then tap Resubmit.`);
  }

  vendorRejected(tenant: Tenant, notes: string) {
    return this.fromPlatform(tenant, `We could not approve *${tenant.name}* yet:\n\n${notes}\n\nYou can fix this and apply again.`);
  }

  vendorSuspended(tenant: Tenant, reason: string) {
    return this.fromPlatform(tenant, `⚠️ *${tenant.name}* has been suspended: ${reason}\n\nBuyers will see that your shop is temporarily closed.`);
  }

  /**
   * New order alert, from the shop's own number to the owner's phone. Owners rarely write to
   * their own shop number, so it is sent as the approved template (VENDOR_ORDER_TEMPLATE),
   * which arrives whatever the 24-hour window: "Hello {{1}}, you have a new order on
   * MarketiX. Order: {{2}} Customer: {{3}} Total: GH₵ {{4}} ...".
   */
  orderAlert(tenant: Tenant, order: { orderNumber: string; totalAmount: number; customerName?: string | null }) {
    const owner = tenant.ownerFullName?.trim().split(/\s+/)[0] || tenant.name;
    const total = order.totalAmount.toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return this.deliver(tenant.whatsappPhoneNumberId, tenant.ownerPhone, (from, to) =>
      this.wabaService.sendTemplate(from, to, VENDOR_ORDER_TEMPLATE(), [owner, order.orderNumber, order.customerName?.trim() || 'a WhatsApp buyer', total]),
    );
  }

  /**
   * The delivery details, from the shop's number to the rider, as the approved template
   * (RIDER_DELIVERY_TEMPLATE), so it arrives even though riders never write to the shop:
   * "Hello {{1}}, {{2}} has a delivery for you. Order {{3}}, Buyer {{4}}, Phone {{5}},
   * Area {{6}}, When {{7}}, Collect {{8}}, Items {{9}}, Shop phone {{10}}", with an
   * "Open map" button. The map shows the buyer's pin, or searches their area without one.
   */
  riderDelivery(tenant: Tenant, order: RiderOrder) {
    const buyerPhone = order.contactPhone ?? (isHiddenNumber(order.buyerPhone) ? null : order.buyerPhone);
    const area = [order.deliveryArea, order.landmark].filter(Boolean).join(', ') || order.deliveryAddress || '';
    const pinned = order.locationLatitude != null && order.locationLongitude != null;
    const items = order.items.map((i) => `${i.quantity} × ${i.productName}`).join(', ');
    const params = [
      order.riderName?.trim().split(/\s+/)[0] || 'there',
      tenant.name,
      order.orderNumber,
      order.customerName?.trim() || 'the buyer',
      buyerPhone ? toGhanaLocal(buyerPhone) : 'not shared',
      area || 'see the map',
      order.deliverySlot || 'As soon as possible',
      collectText(order),
      items.length > MAX_ITEMS_TEXT ? `${items.slice(0, MAX_ITEMS_TEXT - 1)}…` : items || 'see the shop',
      toGhanaLocal(tenant.ownerPhone ?? tenant.whatsappNumber ?? '') || 'not shared',
    ];
    const mapQuery = pinned ? `${order.locationLatitude},${order.locationLongitude}` : area || `${tenant.name}, Ghana`;
    return this.deliver(tenant.whatsappPhoneNumberId, order.riderPhone, (from, to) =>
      this.wabaService.sendTemplate(from, to, RIDER_DELIVERY_TEMPLATE(), params, { urlButton: encodeURIComponent(mapQuery) }),
    );
  }

  /** A withdrawal (or admin payout) landed in the vendor's MoMo wallet. */
  payoutPaid(tenant: Tenant, payout: Pick<VendorPayout, 'amount' | 'momoNumber' | 'source'>) {
    return this.fromPlatform(
      tenant,
      `✅ ${ghCedis(payout.amount / 100)} has been sent to your MoMo (${toGhanaLocal(payout.momoNumber)}). ` +
        `${payout.source === PayoutSource.VENDOR ? 'Your withdrawal is complete.' : 'MarketiX paid out your balance.'} Thanks for selling on MarketiX!`,
    );
  }

  /** A payout failed and the money is back in the balance. Paystack's reason stays with admins. */
  payoutFailed(tenant: Tenant, payout: Pick<VendorPayout, 'amount' | 'source'>) {
    const what = payout.source === PayoutSource.VENDOR ? 'withdrawal' : 'payout';
    return this.fromPlatform(
      tenant,
      `⚠️ Your ${what} of ${ghCedis(payout.amount / 100)} didn't go through. The money is back in your MarketiX balance ` +
        'and our team has been told. You can withdraw it again from the Money page.',
    );
  }

  /** Someone asked to promote the shop; the vendor approves or declines in the dashboard. */
  promoterRequested(tenant: Tenant, promoter: Pick<Promoter, 'fullName' | 'phone'>) {
    const who = promoter.fullName ? `${promoter.fullName} (${toGhanaLocal(promoter.phone)})` : toGhanaLocal(promoter.phone);
    return this.fromPlatform(
      tenant,
      `🙋 ${who} wants to promote *${tenant.name}* and earn ${tenant.promoterRate ?? '?'}% on new customers' first orders. ` +
        'Approve or decline on the Promoters page of your dashboard.',
    );
  }

  /** A message to a promoter (earnings, payouts), from the platform number. */
  toPromoter(phone: string, text: string) {
    return this.send(optionalEnv('PLATFORM_PHONE_NUMBER_ID') || null, phone, text);
  }

  private fromPlatform(tenant: Tenant, text: string) {
    return this.send(optionalEnv('PLATFORM_PHONE_NUMBER_ID') || null, tenant.ownerPhone, text);
  }

  private send(fromPhoneNumberId: string | null, toPhone: string | null, text: string): Promise<boolean> {
    return this.deliver(fromPhoneNumberId, toPhone, (from, to) => this.wabaService.sendTextMessage(from, to, text));
  }

  /** Sends one message with `message(from, to)`; logs and returns false instead of throwing. */
  private async deliver(fromPhoneNumberId: string | null, toPhone: string | null, message: (from: string, to: string) => Promise<unknown>): Promise<boolean> {
    if (!fromPhoneNumberId || !toPhone) {
      this.logger.warn(`Notification skipped (${!fromPhoneNumberId ? 'no sending number' : 'no owner phone'}).`);
      return false;
    }
    try {
      await message(fromPhoneNumberId, toInternationalDigits(toPhone));
      return true;
    } catch (err: any) {
      this.logger.warn(`Notification to ${toPhone} failed: ${err?.message || err}`);
      return false;
    }
  }
}

/** What the rider collects from the buyer. */
function collectText(order: Pick<Order, 'paymentMethod' | 'paystackPaidAt' | 'totalAmount'>): string {
  if (order.paymentMethod === PaymentMethod.COD) return `${ghCedis(order.totalAmount)} in cash`;
  if (order.paystackPaidAt) return 'Nothing, already paid';
  return `${ghCedis(order.totalAmount)} (not paid yet, check with the shop)`;
}
