import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, NumberStatus, Prisma, WhatsappNumber } from '@prisma/client';
import { optionalEnv } from '../common/config.js';
import { formatGhanaInternational, toInternationalDigits } from '../common/phone.util.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WabaService } from '../waba/waba.service.js';
import { AuditService } from './audit.service.js';
import { AddNumberDto } from './dto/add-number.dto.js';

/** A released number waits this long before another shop can get it. */
export const COOLING_MS = 7 * 24 * 60 * 60 * 1000;

/** Released before this moment means the cooling period is over. */
function coolingCutoff(now = Date.now()): Date {
  return new Date(now - COOLING_MS);
}

/** The one definition of "can be assigned": no shop, and FREE or done cooling. */
function availableSql(cutoff = coolingCutoff()): Prisma.Sql {
  return Prisma.sql`"tenantId" IS NULL AND ("status" = 'FREE' OR ("status" = 'COOLING' AND "releasedAt" < ${cutoff}))`;
}

/** Meta quality ratings worth a look before Meta restricts the number. */
const QUALITY_ISSUES = ['YELLOW', 'RED'];

/** "GREEN, 1K / day" for the audit log. */
function qualitySummary(qualityRating?: string | null, messagingLimit?: string | null): string {
  const quality = qualityRating && qualityRating !== 'UNKNOWN' ? qualityRating.toLowerCase() : 'unrated';
  const tier = messagingLimit ? messagingLimit.replace(/^TIER_/, '').replace('UNLIMITED', 'unlimited') : null;
  return `quality ${quality}${tier ? `, ${tier} / day` : ', no tier reported'}`;
}

type Tx = Prisma.TransactionClient;

/**
 * The pool of WhatsApp numbers under the MarketiX WABA. COOLING numbers become free on
 * their own once COOLING_MS has passed since release: no scheduled job flips them.
 */
@Injectable()
export class NumberPoolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wabaService: WabaService,
    private readonly audit: AuditService,
  ) {}

  /** FREE, or COOLING for long enough that it counts as FREE. */
  effectiveStatus(number: Pick<WhatsappNumber, 'status' | 'releasedAt'>, now = Date.now()): NumberStatus {
    const cooled = number.status === NumberStatus.COOLING && number.releasedAt !== null && number.releasedAt < coolingCutoff(now);
    return cooled ? NumberStatus.FREE : number.status;
  }

  async list(filter: { statuses?: NumberStatus[]; qualityIssues?: boolean } = {}) {
    const numbers = await this.prisma.whatsappNumber.findMany({
      orderBy: { createdAt: 'asc' },
      include: { tenant: { select: { id: true, name: true, status: true } } },
    });
    return numbers
      .map((n) => ({ ...n, status: this.effectiveStatus(n), qualityIssue: QUALITY_ISSUES.includes(n.qualityRating ?? '') }))
      .filter((n) => (!filter.statuses || filter.statuses.includes(n.status)) && (!filter.qualityIssues || n.qualityIssue));
  }

  /** Tiles and filter-chip counts for the pool page, by effective status. */
  async summary() {
    const numbers = await this.list();
    const count = (status: NumberStatus) => numbers.filter((n) => n.status === status).length;
    return {
      total: numbers.length,
      free: count(NumberStatus.FREE),
      assigned: count(NumberStatus.ASSIGNED),
      cooling: count(NumberStatus.COOLING),
      qualityIssues: numbers.filter((n) => n.qualityIssue).length,
    };
  }

  async countFree(): Promise<number> {
    const [{ count }] = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS "count" FROM "WhatsappNumber" WHERE ${availableSql()}`;
    return count;
  }

  /**
   * Add a number that is already registered and verified under the WABA on Meta. Meta is
   * asked about it first, so a wrong id or a mistyped number never enters the pool.
   */
  async add(actorId: string, dto: AddNumberDto) {
    const wabaId = dto.wabaId || optionalEnv('META_WABA_ID');
    if (!wabaId) {
      throw new BadRequestException('Give a wabaId, or set META_WABA_ID.');
    }
    const clash = await this.prisma.whatsappNumber.findFirst({
      where: { OR: [{ phoneNumberId: dto.phoneNumberId }, { displayNumber: dto.displayNumber }] },
    });
    if (clash) {
      throw new ConflictException(`That number is already in the pool (${clash.displayNumber}).`);
    }

    const details = await this.wabaService.getPhoneNumberDetails(dto.phoneNumberId).catch((err: Error) => {
      throw new BadRequestException(`Meta could not find phone number id ${dto.phoneNumberId}. ${err.message}`);
    });
    if (toInternationalDigits(details.displayPhoneNumber ?? '') !== toInternationalDigits(dto.displayNumber)) {
      throw new BadRequestException(
        `Meta has phone number id ${dto.phoneNumberId} as ${details.displayPhoneNumber ?? 'no number'}, not ${dto.displayNumber}. Check both values.`,
      );
    }

    // Without its own Flow key the number would show buyers "Something went wrong".
    const flowKey = await this.wabaService.ensureFlowEncryptionKey(dto.phoneNumberId).catch((err: Error) => {
      throw new BadRequestException(`Could not set up the Flow encryption key on ${dto.displayNumber}. ${err.message}`);
    });

    return this.prisma.$transaction(async (tx) => {
      const number = await tx.whatsappNumber.create({
        data: {
          phoneNumberId: dto.phoneNumberId,
          displayNumber: dto.displayNumber,
          wabaId,
          displayName: dto.displayName ?? details.verifiedName ?? null,
          qualityRating: details.qualityRating ?? null,
          messagingLimit: details.messagingLimit ?? null,
          refreshedAt: new Date(),
        },
      });
      await this.audit.log(tx, {
        actorId,
        action: AuditAction.NUMBER_ADDED,
        numberId: number.id,
        details: `Registered under WABA ${wabaId} (${qualitySummary(number.qualityRating, number.messagingLimit)}).`,
        metadata: { phoneNumberId: number.phoneNumberId, wabaId, flowKey },
      });
      return number;
    });
  }

  /** Skip the rest of the cooling period. */
  async free(actorId: string, id: string) {
    const number = await this.findOrThrow(id);
    if (number.status !== NumberStatus.COOLING) {
      throw new BadRequestException(`Only a cooling number can be freed early; this one is ${this.effectiveStatus(number)}.`);
    }
    return this.prisma.$transaction(async (tx) => {
      const freed = await tx.whatsappNumber.update({ where: { id }, data: { status: NumberStatus.FREE } });
      await this.audit.log(tx, {
        actorId,
        action: AuditAction.NUMBER_FREED,
        numberId: id,
        details: `${formatGhanaInternational(number.displayNumber)} freed before its 7 days of cooling ended.`,
        metadata: { releasedAt: number.releasedAt?.toISOString() ?? null },
      });
      return freed;
    });
  }

  /** Pull the number's quality rating and messaging tier from Meta (read-only call). */
  async refresh(actorId: string, id: string) {
    const before = await this.findOrThrow(id);
    const after = await this.pullFromMeta(before);
    await this.audit.log(this.prisma, {
      actorId,
      action: AuditAction.NUMBER_REFRESHED,
      numberId: id,
      details: `Refreshed from Meta: ${qualitySummary(after.qualityRating, after.messagingLimit)}.`,
      metadata: {
        before: { qualityRating: before.qualityRating, messagingLimit: before.messagingLimit },
        after: { qualityRating: after.qualityRating, messagingLimit: after.messagingLimit },
      },
    });
    return after;
  }

  /**
   * Refresh every number, one at a time. A failure on one number does not stop the rest.
   * One audit entry for the whole run.
   */
  async refreshAll(actorId: string) {
    const numbers = await this.prisma.whatsappNumber.findMany({ orderBy: { createdAt: 'asc' } });
    const failed: { id: string; displayNumber: string; error: string }[] = [];
    for (const number of numbers) {
      await this.pullFromMeta(number).catch((err: Error) => failed.push({ id: number.id, displayNumber: number.displayNumber, error: err.message }));
    }
    const refreshed = numbers.length - failed.length;
    await this.audit.log(this.prisma, {
      actorId,
      action: AuditAction.NUMBER_REFRESHED,
      details:
        `Refreshed ${refreshed} of ${numbers.length} numbers from Meta.` +
        (failed.length ? ` Failed: ${failed.map((f) => formatGhanaInternational(f.displayNumber)).join(', ')}.` : ''),
      metadata: { total: numbers.length, refreshed, failed },
    });
    return { total: numbers.length, refreshed, failed };
  }

  private async pullFromMeta(number: WhatsappNumber) {
    const details = await this.wabaService.getPhoneNumberDetails(number.phoneNumberId);
    return this.prisma.whatsappNumber.update({
      where: { id: number.id },
      data: { qualityRating: details.qualityRating ?? null, messagingLimit: details.messagingLimit ?? null, refreshedAt: new Date() },
    });
  }

  /**
   * Lock a free number for assignment inside an approve transaction: the given one, or the
   * oldest free one. Row locks mean two admins approving at once never get the same number.
   * The number's Flow key is checked (and uploaded if needed) before it is handed over, which
   * also repairs numbers added before keys were set up on add; a failure rolls back the approval.
   */
  async claim(tx: Tx, numberId?: string): Promise<WhatsappNumber> {
    const rows = numberId
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "WhatsappNumber" WHERE "id" = ${numberId} AND ${availableSql()} FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "WhatsappNumber" WHERE ${availableSql()}
          ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED`;

    if (rows.length === 0) {
      throw new ConflictException(
        numberId ? 'That number is not free any more. Pick another.' : 'No free WhatsApp numbers left in the pool. Add one first.',
      );
    }
    const number = await tx.whatsappNumber.findUniqueOrThrow({ where: { id: rows[0].id } });
    await this.wabaService.ensureFlowEncryptionKey(number.phoneNumberId).catch((err: Error) => {
      throw new BadRequestException(
        `${formatGhanaInternational(number.displayNumber)} is not ready for the ordering Flow, so the shop was not approved. ${err.message}`,
      );
    });
    return number;
  }

  private async findOrThrow(id: string) {
    const number = await this.prisma.whatsappNumber.findUnique({ where: { id } });
    if (!number) {
      throw new NotFoundException('Number not found.');
    }
    return number;
  }
}
