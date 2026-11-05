import { forwardRef, Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { PaystackTransfersClient } from './paystack-transfers.client.js';
import { PayoutReportService } from './payout-report.service.js';
import { PayoutController } from './payout.controller.js';
import { PayoutService } from './payout.service.js';
import { SalesSummaryService } from './sales-summary.service.js';

/** The vendor money ledger and MoMo payouts through Paystack Transfers. */
@Module({
  imports: [PrismaModule, TenantModule, forwardRef(() => NotificationModule)],
  controllers: [PayoutController],
  providers: [PayoutService, PayoutReportService, PaystackTransfersClient, SalesSummaryService],
  exports: [PayoutService, PayoutReportService, SalesSummaryService],
})
export class PayoutModule {}
