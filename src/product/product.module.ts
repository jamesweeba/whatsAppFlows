import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module.js';
import { ProductService } from './product.service.js';
import { ProductController } from './product.controller.js';

@Module({
  imports: [TenantModule],
  controllers: [ProductController],
  providers: [ProductService],
  exports: [ProductService],
})
export class ProductModule {}
