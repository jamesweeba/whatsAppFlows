import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module.js';
import { CategoryController } from './category.controller.js';
import { CategoryService } from './category.service.js';

/** The platform-wide category list, shared by products, the Excel upload and the Flow. */
@Module({
  imports: [TenantModule],
  controllers: [CategoryController],
  providers: [CategoryService],
  exports: [CategoryService],
})
export class CategoryModule {}
