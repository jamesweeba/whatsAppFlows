import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from './audit.service.js';

const NOTE_SELECT = {
  id: true,
  body: true,
  createdAt: true,
  editedAt: true,
  author: { select: { id: true, firstName: true, lastName: true } },
} as const;

type NoteRow = {
  id: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  author: { id: string; firstName: string; lastName: string };
};

/** Admins' private notes on a shop. Every add, edit and delete goes to the audit log. */
@Injectable()
export class VendorNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Newest first. `mine` says whether this admin may edit or delete it. */
  async list(adminId: string, tenantId: string) {
    await this.ensureShop(tenantId);
    const notes = await this.prisma.vendorNote.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: NOTE_SELECT,
    });
    return notes.map((note) => this.toResponse(note, adminId));
  }

  async add(adminId: string, tenantId: string, body: string) {
    await this.ensureShop(tenantId);
    const note = await this.prisma.$transaction(async (tx) => {
      const created = await tx.vendorNote.create({ data: { tenantId, authorId: adminId, body }, select: NOTE_SELECT });
      await this.audit.log(tx, { actorId: adminId, action: AuditAction.NOTE_ADDED, tenantId, details: body, metadata: { noteId: created.id } });
      return created;
    });
    return this.toResponse(note, adminId);
  }

  /** Only the author may edit. The text before the edit is kept in the audit log. */
  async update(adminId: string, tenantId: string, noteId: string, body: string) {
    const existing = await this.ownNote(adminId, tenantId, noteId);
    if (existing.body === body) return this.toResponse(existing, adminId);

    const note = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.vendorNote.update({ where: { id: noteId }, data: { body, editedAt: new Date() }, select: NOTE_SELECT });
      await this.audit.log(tx, {
        actorId: adminId,
        action: AuditAction.NOTE_EDITED,
        tenantId,
        details: `Now: "${body}" Before: "${existing.body}"`,
        metadata: { noteId, previous: existing.body },
      });
      return updated;
    });
    return this.toResponse(note, adminId);
  }

  /** Only the author may delete. The deleted text is kept in the audit log. */
  async remove(adminId: string, tenantId: string, noteId: string) {
    const existing = await this.ownNote(adminId, tenantId, noteId);
    await this.prisma.$transaction(async (tx) => {
      await tx.vendorNote.delete({ where: { id: noteId } });
      await this.audit.log(tx, { actorId: adminId, action: AuditAction.NOTE_DELETED, tenantId, details: existing.body, metadata: { noteId } });
    });
  }

  private async ensureShop(tenantId: string) {
    const shop = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!shop) throw new NotFoundException('Shop not found.');
  }

  private async ownNote(adminId: string, tenantId: string, noteId: string): Promise<NoteRow> {
    const note = await this.prisma.vendorNote.findFirst({ where: { id: noteId, tenantId }, select: NOTE_SELECT });
    if (!note) throw new NotFoundException('Note not found. It may have been deleted.');
    if (note.author.id !== adminId) throw new ForbiddenException('You can only change your own notes.');
    return note;
  }

  private toResponse(note: NoteRow, adminId: string) {
    const { author, ...rest } = note;
    return {
      ...rest,
      author: { id: author.id, name: `${author.firstName} ${author.lastName}`.trim() },
      mine: author.id === adminId,
    };
  }
}
