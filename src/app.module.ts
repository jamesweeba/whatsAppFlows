import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { TenantModule } from './tenant/tenant.module.js';
import { ProductModule } from './product/product.module.js';
import { WabaModule } from './waba/waba.module.js';
import { ChatModule } from './chat/chat.module.js';
import { FlowModule } from './flow/flow.module.js';
import { OrderModule } from './order/order.module.js';
import { PaymentModule } from './payment/payment.module.js';
import { PayoutModule } from './payout/payout.module.js';
import { StorageModule } from './storage/storage.module.js';
import { NotificationModule } from './notification/notification.module.js';
import { AdminModule } from './admin/admin.module.js';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    TenantModule,
    ProductModule,
    WabaModule,
    ChatModule,
    FlowModule,
    OrderModule,
    PaymentModule,
    PayoutModule,
    StorageModule,
    NotificationModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
