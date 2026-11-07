import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { WabaModule } from '../waba/waba.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { PayoutModule } from '../payout/payout.module.js';
import { ReferralModule } from '../promoter/referral.module.js';
import { OrderController } from './order.controller.js';
import { OrderService } from './order.service.js';

@Module({
  imports: [PrismaModule, TenantModule, WabaModule, PayoutModule, ReferralModule],
  controllers: [OrderController],
  providers: [OrderService],
  exports: [OrderService],
})
export class OrderModule {}
