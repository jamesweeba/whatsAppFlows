import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Request, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/guards/roles.guard.js';
import { VendorNoteDto } from './dto/vendor-note.dto.js';
import { VendorNotesService } from './vendor-notes.service.js';

/** Private admin notes on a shop. Vendors never see them. */
@Controller('api/v1/admin/tenants/:id/notes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminNotesController {
  constructor(private readonly notes: VendorNotesService) {}

  /** Newest first. GET /admin/tenants/:id/notes */
  @Get()
  list(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.notes.list(req.user.id, id);
  }

  /** POST /admin/tenants/:id/notes { body } */
  @Post()
  add(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VendorNoteDto) {
    return this.notes.add(req.user.id, id, dto.body);
  }

  /** Author only. PATCH /admin/tenants/:id/notes/:noteId { body } */
  @Patch(':noteId')
  update(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body() dto: VendorNoteDto,
  ) {
    return this.notes.update(req.user.id, id, noteId, dto.body);
  }

  /** Author only. DELETE /admin/tenants/:id/notes/:noteId */
  @Delete(':noteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Param('noteId', ParseUUIDPipe) noteId: string) {
    return this.notes.remove(req.user.id, id, noteId);
  }
}
