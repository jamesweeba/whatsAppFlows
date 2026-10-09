import {
  Body,
  Controller,
  Get,
  Patch,
  Put,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { TenantService } from './tenant.service.js';
import { CreateTenantDto } from './dto/create-tenant.dto.js';
import { UpdateTenantDto } from './dto/update-tenant.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';

@Controller('api/v1/tenants')
@UseGuards(JwtAuthGuard)
export class TenantController {
  constructor(private readonly tenantService: TenantService) { }

  @Post()
  async create(@Request() req: any, @Body() dto: CreateTenantDto) {
    return this.tenantService.create(req.user.id, dto);
  }

  @Get('')
  async findMine(@Request() req: any) {
    return this.tenantService.findByUser(req.user.id);
  }

  @Put('')
  async updateMine(@Request() req: any, @Body() dto: UpdateTenantDto) {
    return this.tenantService.update(req.user.id, dto);
  }
}
