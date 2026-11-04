import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ProductService } from './product.service.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { ParseExcelFilePipe } from './pipes/parse-excel-file.pipe.js';
import { BulkUploadDto } from './dto/bulk-upload.dto.js';
import { MAX_PHOTO_BYTES, ProductPhotoService } from './product-photo.service.js';

@Controller('api/v1/products')
@UseGuards(JwtAuthGuard)
export class ProductController {
  constructor(
    private readonly productService: ProductService,
    private readonly photoService: ProductPhotoService,
  ) { }

  /**
   * Create a single product.
   * POST /products
   */
  @Post()
  async create(@Request() req: any, @Body() dto: CreateProductDto) {
    return this.productService.create(req.user.id, dto);
  }

  /**
   * Bulk-create products from an uploaded Excel file (.xlsx / .xls) laid out like the
   * template. Multipart form: `file`, plus an optional `categoryId` for rows with no
   * category. All or nothing: any invalid row means nothing is imported (400 with the list).
   * POST /products/upload
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async bulkUpload(
    @Request() req: any,
    @UploadedFile(ParseExcelFilePipe) file: Express.Multer.File,
    @Body() dto: BulkUploadDto,
  ) {
    return this.productService.bulkCreateFromExcel(req.user.id, file.buffer, dto.categoryId);
  }

  /**
   * The Excel template for bulk upload, with an example row and the list of categories.
   * GET /products/upload/template
   */
  @Get('upload/template')
  async uploadTemplate() {
    return new StreamableFile(await this.productService.uploadTemplate(), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment; filename="marketix-products-template.xlsx"',
    });
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
   * Upload or replace a product's photo. Multipart form: `file` (JPEG, PNG or WebP, max 5 MB).
   * Returns `{ photoUrl }`.
   * POST /products/:id/photo
   */
  @Post(':id/photo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PHOTO_BYTES } }))
  async uploadPhoto(@Request() req: any, @Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('Attach the photo as the "file" field.');
    }
    return this.photoService.upload(req.user.id, id, file);
  }

  /**
   * Remove a product's photo. Returns `{ photoUrl: null }`.
   * DELETE /products/:id/photo
   */
  @Delete(':id/photo')
  async removePhoto(@Request() req: any, @Param('id') id: string) {
    return this.photoService.remove(req.user.id, id);
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

/**
 * Product photos are public: buyers' browsers and WhatsApp load them without a token.
 * Kept apart from ProductController, whose routes all require a login.
 */
@Controller('api/v1/products')
export class ProductPhotoController {
  constructor(private readonly photoService: ProductPhotoService) { }

  /**
   * A product's photo. The URL carries a version (`?v=`), so it can be cached for good.
   * GET /products/:id/photo
   */
  @Get(':id/photo')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  @Header('X-Content-Type-Options', 'nosniff')
  async photo(@Param('id') id: string) {
    const { mimeType, stream } = await this.photoService.open(id);
    return new StreamableFile(stream, { type: mimeType, disposition: 'inline' });
  }
}
