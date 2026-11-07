import { PartialType } from '@nestjs/mapped-types';
import { CreateProductDto } from './create-product.dto.js';

/**
 * Every product field, all optional. `categoryId` moves the product to another category;
 * `measures` replaces all of the product's measures (an empty array removes them).
 */
export class UpdateProductDto extends PartialType(CreateProductDto) {}
