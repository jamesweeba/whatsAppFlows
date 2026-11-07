import { Module } from '@nestjs/common';
import { FlowModule } from '../flow/flow.module.js';
import { OrderModule } from '../order/order.module.js';
import { PaymentModule } from '../payment/payment.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PromoterModule } from '../promoter/promoter.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { WabaWebhookController } from '../waba/waba-webhook.controller.js';
import { WabaModule } from '../waba/waba.module.js';
import { AiClassifierService } from './ai-classifier.service.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { InteractiveOrderService } from './interactive-order.service.js';

@Module({
  imports: [PrismaModule, WabaModule, FlowModule, OrderModule, PaymentModule, TenantModule, PromoterModule],
  controllers: [ChatController, WabaWebhookController],
  providers: [ChatService, AiClassifierService, InteractiveOrderService],
  exports: [ChatService, AiClassifierService, InteractiveOrderService],
})
export class ChatModule {}
