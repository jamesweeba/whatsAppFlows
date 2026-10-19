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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
