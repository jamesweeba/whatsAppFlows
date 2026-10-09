import { Module } from '@nestjs/common';
import { FlowController } from './flow.controller.js';
import { FlowService } from './flow.service.js';
import { FlowCryptoService } from './flow-crypto.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { WabaModule } from '../waba/waba.module.js';

@Module({
  imports: [PrismaModule, WabaModule],
  controllers: [FlowController],
  providers: [FlowService, FlowCryptoService],
  exports: [FlowService, FlowCryptoService],
})
export class FlowModule {}
