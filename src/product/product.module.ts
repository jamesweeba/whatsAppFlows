import { forwardRef, Module } from '@nestjs/common';
import { CategoryModule } from '../category/category.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { WabaModule } from '../waba/waba.module.js';
import { ProductService } from './product.service.js';
import { ProductController, ProductPhotoController } from './product.controller.js';
import { ProductPhotoService } from './product-photo.service.js';
import { ProductVideoService } from './product-video.service.js';

@Module({
  imports: [TenantModule, CategoryModule, forwardRef(() => WabaModule)],
  controllers: [ProductController, ProductPhotoController],
  providers: [ProductService, ProductPhotoService, ProductVideoService],
  exports: [ProductService, ProductPhotoService, ProductVideoService],
})
export class ProductModule {}
