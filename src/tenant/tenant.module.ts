import { forwardRef, Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module.js';
import { TenantService } from './tenant.service.js';
import { OnboardingService } from './onboarding.service.js';
import { ShopBannerService } from './shop-banner.service.js';
import { ShopBannerController, TenantController } from './tenant.controller.js';

@Module({
  // forwardRef: NotificationModule -> WabaModule -> TenantModule.
  imports: [forwardRef(() => NotificationModule)],
  controllers: [TenantController, ShopBannerController],
  providers: [TenantService, OnboardingService, ShopBannerService],
  exports: [TenantService, OnboardingService, ShopBannerService],
})
export class TenantModule {}
