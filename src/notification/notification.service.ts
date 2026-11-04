import { Injectable, Logger } from '@nestjs/common';
import { Tenant } from '@prisma/client';
import { optionalEnv } from '../common/config.js';
import { ghCedis } from '../common/money.util.js';
import { toInternationalDigits } from '../common/phone.util.js';
import { WabaService } from '../waba/waba.service.js';

/**
 * WhatsApp messages to vendors (not buyers). Onboarding messages come from the platform's
 * own number (PLATFORM_PHONE_NUMBER_ID); order alerts come from the shop's number.
 * Everything here is best-effort: a failed message is logged and never fails the caller.
 *
 * Meta only delivers free-form text inside a 24-hour window opened by the recipient.
 * Until approved message templates exist, vendors who have not messaged the platform
 * number recently will not receive these.
 */
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

  /** New order alert, sent from the shop's own number to the owner's phone. */
  orderAlert(tenant: Tenant, order: { orderNumber: string; totalAmount: number; customerName?: string | null }) {
    const buyer = order.customerName ? ` from ${order.customerName}` : '';
    return this.send(
      tenant.whatsappPhoneNumberId,
      tenant.ownerPhone,
      `🛒 New order *${order.orderNumber}*${buyer}: ${ghCedis(order.totalAmount)}. Open your dashboard to pack it.`,
    );
  }

  private fromPlatform(tenant: Tenant, text: string) {
    return this.send(optionalEnv('PLATFORM_PHONE_NUMBER_ID') || null, tenant.ownerPhone, text);
  }

  private async send(fromPhoneNumberId: string | null, toPhone: string | null, text: string): Promise<boolean> {
    if (!fromPhoneNumberId || !toPhone) {
      this.logger.warn(`Vendor notification skipped (${!fromPhoneNumberId ? 'no sending number' : 'no owner phone'}).`);
      return false;
    }
    try {
      await this.wabaService.sendTextMessage(fromPhoneNumberId, toInternationalDigits(toPhone), text);
      return true;
    } catch (err: any) {
      this.logger.warn(`Vendor notification to ${toPhone} failed: ${err?.message || err}`);
      return false;
    }
  }
}
