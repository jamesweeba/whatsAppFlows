import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { WabaModule } from '../waba/waba.module.js';
import { PayoutModule } from '../payout/payout.module.js';
import { AdminDailySummaryController } from './admin-daily-summary.controller.js';
import { DailySummaryService } from './daily-summary.service.js';
import { AdminPayoutsController } from './admin-payouts.controller.js';
import { AdminPayoutsService } from './admin-payouts.service.js';
import { AdminPromotersController } from './admin-promoters.controller.js';
import { AdminPromotersService } from './admin-promoters.service.js';
import { AdminAuditController } from './admin-audit.controller.js';
import { AdminBannerController } from './admin-banner.controller.js';
import { AdminBannerService } from './admin-banner.service.js';
import { AdminNotesController } from './admin-notes.controller.js';
import { AdminNumbersController } from './admin-numbers.controller.js';
import { AdminOrdersController } from './admin-orders.controller.js';
import { AdminOrdersService } from './admin-orders.service.js';
import { AdminTenantsController } from './admin-tenants.controller.js';
import { AdminVendorsController } from './admin-vendors.controller.js';
import { AuditService } from './audit.service.js';
import { NumberPoolService } from './number-pool.service.js';
import { ReviewService } from './review.service.js';
import { VendorDirectoryService } from './vendor-directory.service.js';
import { VendorNotesService } from './vendor-notes.service.js';

/** Super admin: vendor directory, review queue, decisions, orders, the WhatsApp number pool, vendor notes, shop banners, payouts, promoters, the daily summary and the audit log. */
@Module({
  imports: [TenantModule, WabaModule, NotificationModule, PayoutModule],
  controllers: [AdminTenantsController, AdminVendorsController, AdminNumbersController, AdminOrdersController, AdminAuditController, AdminNotesController, AdminBannerController, AdminPayoutsController, AdminDailySummaryController, AdminPromotersController],
  providers: [ReviewService, NumberPoolService, VendorDirectoryService, AdminOrdersService, AuditService, VendorNotesService, AdminBannerService, AdminPayoutsService, DailySummaryService, AdminPromotersService],
})
export class AdminModule {}
