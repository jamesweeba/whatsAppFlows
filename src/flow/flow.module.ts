import { Module } from '@nestjs/common';
import { OrderModule } from '../order/order.module.js';
import { PaymentModule } from '../payment/payment.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { WabaModule } from '../waba/waba.module.js';
import { FlowController } from './flow.controller.js';
import { FlowCryptoService } from './flow-crypto.service.js';
import { FlowService } from './flow.service.js';

@Module({
  imports: [PrismaModule, WabaModule, PaymentModule, OrderModule, TenantModule],
  controllers: [FlowController],
  providers: [FlowService, FlowCryptoService],
  exports: [FlowService, FlowCryptoService],
})
export class FlowModule {}
