import { Module } from '@nestjs/common';
import { OrderModule } from '../order/order.module.js';
import { WabaModule } from '../waba/waba.module.js';
import { PayoutModule } from '../payout/payout.module.js';
import { PaymentController } from './payment.controller.js';
import { PaystackService } from './paystack.service.js';

@Module({
  imports: [OrderModule, WabaModule, PayoutModule],
  controllers: [PaymentController],
  providers: [PaystackService],
  exports: [PaystackService],
})
export class PaymentModule {}
