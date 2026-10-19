import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { WabaModule } from '../waba/waba.module.js';
import { PaystackService } from './paystack.service.js';
import { PaymentController } from './payment.controller.js';

@Module({
  imports: [PrismaModule, WabaModule],
  controllers: [PaymentController],
  providers: [PaystackService],
  exports: [PaystackService],
})
export class PaymentModule {}
