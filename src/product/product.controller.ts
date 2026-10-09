import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ProductService } from './product.service.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { ParseExcelFilePipe } from './pipes/parse-excel-file.pipe.js';

@Controller('api/v1/products')
@UseGuards(JwtAuthGuard)
export class ProductController {
  constructor(private readonly productService: ProductService) { }

  /**
   * Create a single product.
   * POST /products
   */
  @Post()
  async create(@Request() req: any, @Body() dto: CreateProductDto) {
    return this.productService.create(req.user.id, dto);
  }

  /**
   * Bulk-create products from an uploaded Excel file (.xlsx / .xls).
   * POST /products/upload
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async bulkUpload(
    @Request() req: any,
    @UploadedFile(ParseExcelFilePipe) file: Express.Multer.File,
  ) {
    return this.productService.bulkCreateFromExcel(req.user.id, file.buffer);
  }

  /**
   * List all products for the user's tenant (paginated, with optional search by product name).
   * GET /api/v1/products?page=1&limit=20&search=phone (or ?name=phone)
   */
  @Get()
  async findAll(
    @Request() req: any,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(5), ParseIntPipe) limit: number,
    @Query('search') search?: string,
    @Query('name') name?: string,
  ) {
    const queryTerm = search || name;
    const safeLimit = Math.min(Math.max(limit, 1), 5);
    return this.productService.findAll(req.user.id, page, safeLimit, queryTerm);
  }

  /**
   * Get a single product by ID.
   * GET /products/:id
   */
  @Get(':id')
  async findOne(@Request() req: any, @Param('id') id: string) {
    return this.productService.findOne(req.user.id, id);
  }

  /**
   * Update a product by ID.
   * PATCH /products/:id
   */
  @Patch(':id')
  async update(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.productService.update(req.user.id, id, dto);
  }

  /**
   * Delete a product by ID.
   * DELETE /products/:id
   */
  @Delete(':id')
  async remove(@Request() req: any, @Param('id') id: string) {
    return this.productService.remove(req.user.id, id);
  }
}
