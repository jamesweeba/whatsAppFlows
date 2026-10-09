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
  UseGuards,
} from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { OrderService } from './order.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';

@Controller('api/v1/orders')
@UseGuards(JwtAuthGuard)
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  /**
   * Create an order (vendor initiated).
   * POST /api/v1/orders
   */
  @Post()
  async create(@Request() req: any, @Body() dto: CreateOrderDto) {
    return this.orderService.createForVendor(req.user.id, dto);
  }

  /**
   * List orders for vendor's tenant with pagination, status filtering, and search.
   * GET /api/v1/orders?page=1&limit=10&status=PENDING&search=+233
   */
  @Get()
  async findAll(
    @Request() req: any,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('status') status?: OrderStatus,
    @Query('search') search?: string,
  ) {
    return this.orderService.findAll(req.user.id, page, limit, status, search);
  }

  /**
   * Get single order by ID.
   * GET /api/v1/orders/:id
   */
  @Get(':id')
  async findOne(@Request() req: any, @Param('id') id: string) {
    return this.orderService.findOne(req.user.id, id);
  }

  /**
   * Update order status / notes.
   * PATCH /api/v1/orders/:id/status
   */
  @Patch(':id/status')
  async updateStatus(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.orderService.updateStatus(req.user.id, id, dto);
  }

  /**
   * Delete an order.
   * DELETE /api/v1/orders/:id
   */
  @Delete(':id')
  async remove(@Request() req: any, @Param('id') id: string) {
    return this.orderService.remove(req.user.id, id);
  }
}
