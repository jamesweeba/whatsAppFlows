import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AiClassifierService } from './ai-classifier.service.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';

import { WabaModule } from '../waba/waba.module.js';
import { FlowModule } from '../flow/flow.module.js';
import { OrderModule } from '../order/order.module.js';
import { PaymentModule } from '../payment/payment.module.js';
import { InteractiveOrderService } from './interactive-order.service.js';
import { WabaWebhookController } from '../waba/waba-webhook.controller.js';

@Module({
  imports: [
    PrismaModule,
    WabaModule,
    forwardRef(() => FlowModule),
    OrderModule,
    PaymentModule,
  ],
  controllers: [ChatController, WabaWebhookController],
  providers: [ChatService, AiClassifierService, InteractiveOrderService],
  exports: [ChatService, AiClassifierService, InteractiveOrderService],
})
export class ChatModule {}
