import { forwardRef, Module } from '@nestjs/common';
import { WabaModule } from '../waba/waba.module.js';
import { NotificationService } from './notification.service.js';

@Module({
  // forwardRef: WabaModule -> TenantModule -> NotificationModule -> WabaModule.
  imports: [forwardRef(() => WabaModule)],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
