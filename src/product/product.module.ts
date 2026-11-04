import { Module } from '@nestjs/common';
import { CategoryModule } from '../category/category.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { ProductService } from './product.service.js';
import { ProductController, ProductPhotoController } from './product.controller.js';
import { ProductPhotoService } from './product-photo.service.js';

@Module({
  imports: [TenantModule, CategoryModule],
  controllers: [ProductController, ProductPhotoController],
  providers: [ProductService, ProductPhotoService],
  exports: [ProductService, ProductPhotoService],
})
export class ProductModule {}
