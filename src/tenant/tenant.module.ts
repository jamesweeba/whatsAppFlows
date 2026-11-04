import { forwardRef, Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module.js';
import { TenantService } from './tenant.service.js';
import { OnboardingService } from './onboarding.service.js';
import { TenantController } from './tenant.controller.js';

@Module({
  // forwardRef: NotificationModule -> WabaModule -> TenantModule.
  imports: [forwardRef(() => NotificationModule)],
  controllers: [TenantController],
  providers: [TenantService, OnboardingService],
  exports: [TenantService, OnboardingService],
})
export class TenantModule {}
