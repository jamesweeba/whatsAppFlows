import { forwardRef, Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module.js';
import { PayoutModule } from '../payout/payout.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { WabaModule } from '../waba/waba.module.js';
import { PromoterBotService } from './promoter-bot.service.js';
import { PromoterVendorController } from './promoter-vendor.controller.js';
import { PromoterVendorService } from './promoter-vendor.service.js';
import { PromoterService } from './promoter.service.js';
import { ReferralModule } from './referral.module.js';

/** Promoters: the bot on the platform number, shop memberships and links, and the vendor's /promotions API. See PROMOTERS_SPEC.md. */
@Module({
  imports: [PrismaModule, forwardRef(() => WabaModule), forwardRef(() => NotificationModule), PayoutModule, TenantModule, ReferralModule],
  controllers: [PromoterVendorController],
  providers: [PromoterService, PromoterBotService, PromoterVendorService],
  exports: [PromoterService, PromoterBotService],
})
export class PromoterModule {}
