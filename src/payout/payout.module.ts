import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { PaystackTransfersClient } from './paystack-transfers.client.js';
import { PayoutReportService } from './payout-report.service.js';
import { PayoutController } from './payout.controller.js';
import { PayoutService } from './payout.service.js';

/** The vendor money ledger and MoMo payouts through Paystack Transfers. */
@Module({
  imports: [PrismaModule, TenantModule],
  controllers: [PayoutController],
  providers: [PayoutService, PayoutReportService, PaystackTransfersClient],
  exports: [PayoutService, PayoutReportService],
})
export class PayoutModule {}
