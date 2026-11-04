import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CategoryService } from './category.service.js';

@Controller('api/v1/categories')
@UseGuards(JwtAuthGuard)
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  /**
   * The predefined categories a vendor picks from when adding products.
   * GET /api/v1/categories
   */
  @Get()
  async findAll(@Request() req: any) {
    return this.categoryService.findAll(req.user.id);
  }
}
