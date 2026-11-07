import { forwardRef, Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module.js';
import { PayoutModule } from '../payout/payout.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { WabaModule } from '../waba/waba.module.js';
import { PromoterBotService } from './promoter-bot.service.js';
import { PromoterService } from './promoter.service.js';

/** Promoters: the bot on the platform number, shop memberships and links. See PROMOTERS_SPEC.md. */
@Module({
  imports: [PrismaModule, forwardRef(() => WabaModule), forwardRef(() => NotificationModule), PayoutModule],
  providers: [PromoterService, PromoterBotService],
  exports: [PromoterService, PromoterBotService],
})
export class PromoterModule {}
