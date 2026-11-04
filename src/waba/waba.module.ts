import { forwardRef, Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module.js';
import { WabaController } from './waba.controller.js';
import { WabaService } from './waba.service.js';

@Module({
  // forwardRef: TenantModule -> NotificationModule -> WabaModule.
  imports: [forwardRef(() => TenantModule)],
  controllers: [WabaController],
  providers: [WabaService],
  exports: [WabaService],
})
export class WabaModule {}
