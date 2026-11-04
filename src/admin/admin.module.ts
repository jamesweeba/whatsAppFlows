import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { WabaModule } from '../waba/waba.module.js';
import { AdminAuditController } from './admin-audit.controller.js';
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

/** Super admin: vendor directory, review queue, decisions, orders, the WhatsApp number pool, vendor notes and the audit log. */
@Module({
  imports: [TenantModule, WabaModule, NotificationModule],
  controllers: [AdminTenantsController, AdminVendorsController, AdminNumbersController, AdminOrdersController, AdminAuditController, AdminNotesController],
  providers: [ReviewService, NumberPoolService, VendorDirectoryService, AdminOrdersService, AuditService, VendorNotesService],
})
export class AdminModule {}
