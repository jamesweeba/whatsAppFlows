import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, Product, ProductVideo, ProductVideoStatus as Status, Tenant } from '@prisma/client';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { WabaService } from '../waba/waba.service.js';
import { convertVideo, MAX_VIDEO_UPLOAD_BYTES, VideoRejected, videoToolsAvailable } from './video-converter.js';

export type VideoSlot = 'pending' | 'live';
export type VideoFileKind = 'video' | 'poster';

/** The whole product. */
export const WHOLE_PRODUCT = '';

type ProductRef = Pick<Product, 'id' | 'tenantId'>;
type VideoRow = Pick<ProductVideo, 'status' | 'uploadedAt' | 'pendingSeconds' | 'pendingTrimmed' | 'message' | 'approvedAt' | 'liveSeconds'>;

/** Files: the whole product's at videos/<shop>/<product>/, each measure's in a m-<code>/ folder below. */
const folder = (product: ProductRef, measureCode: string) =>
  `videos/${product.tenantId}/${product.id}${measureCode ? `/m-${measureCode}` : ''}`;
const fileKey = (product: ProductRef, measureCode: string, slot: VideoSlot, kind: VideoFileKind) =>
  `${folder(product, measureCode)}/${slot}.${kind === 'video' ? 'mp4' : 'jpg'}`;

/** Meta keeps uploaded media 30 days; re-upload a little before that. */
const MEDIA_REUSE_MS = 25 * 24 * 60 * 60 * 1000;
/** The same buyer gets the same video at most this often (repeated taps). */
const RESEND_AFTER_MS = 60 * 1000;

/** Where uploads wait on disk until they are converted (they can be up to 100 MB, so not in memory). */
export const VIDEO_UPLOAD_DIR = join(tmpdir(), 'marketix-video-uploads');

/**
 * What the vendor app (and the admin) see about one video: the whole product's, or a
 * measure's. File URLs point at the vendor's routes, or the admin's with `forAdmin`.
 */
export function videoState(productId: string, measureCode: string, row: VideoRow | null, { forAdmin = false } = {}) {
  const base = forAdmin ? `/api/v1/admin/products/${productId}/video` : `/api/v1/products/${productId}/video`;
  const query = measureCode ? `?measure=${encodeURIComponent(measureCode)}` : '';
  const status = row?.status ?? Status.NONE;
  return {
    /** The latest upload: NONE, PROCESSING, PENDING (waiting for an admin), REJECTED or FAILED. */
    status,
    /** The approved video buyers can watch. */
    live: row?.approvedAt
      ? { approvedAt: row.approvedAt, seconds: row.liveSeconds, url: `${base}/live${query}`, posterUrl: `${base}/live/poster${query}` }
      : null,
    /** A converted upload waiting for an admin. */
    pending:
      row && status === Status.PENDING && row.uploadedAt
        ? { uploadedAt: row.uploadedAt, seconds: row.pendingSeconds, trimmed: row.pendingTrimmed, url: `${base}/pending${query}`, posterUrl: `${base}/pending/poster${query}` }
        : null,
    /** Why the upload was turned down or couldn't be converted. */
    message: row && (status === Status.REJECTED || status === Status.FAILED) ? row.message : null,
  };
}

/**
 * Product videos (see VIDEO_SPEC.md): one for the whole product, and one per measure (the
 * olonka, the table top...). A vendor's upload is converted in the background, one at a time,
 * then waits for an admin; approving it makes it the live video buyers can watch. Files are
 * private: the vendor and admins fetch them with their token.
 */
@Injectable()
export class ProductVideoService implements OnModuleInit {
  private readonly logger = new Logger(ProductVideoService.name);
  private available = false;
  /** Conversions run one after another, so a burst of uploads can't swamp the server. */
  private queue: Promise<void> = Promise.resolve();
  /** When each buyer last got each video: `${videoId}:${buyerPhone}` → time. */
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly tenantService: TenantService,
    private readonly waba: WabaService,
  ) {}

  async onModuleInit() {
    this.available = await videoToolsAvailable();
    if (!this.available) this.logger.warn('ffmpeg/ffprobe not found: product video uploads are off. Install ffmpeg (the Dockerfile does).');
    // A conversion the server was running when it stopped will never finish.
    const { count } = await this.prisma.productVideo.updateMany({
      where: { status: Status.PROCESSING },
      data: { status: Status.FAILED, message: 'Processing was interrupted. Please upload the video again.' },
    });
    if (count) this.logger.warn(`${count} video conversion(s) were interrupted by a restart and marked failed.`);
  }

  // ───────────────────────── Vendor ─────────────────────────

  /** Every video of a product: the whole product's and each measure's, for the product editor. */
  async overview(userId: string, productId: string) {
    const product = await this.ownProduct(userId, productId);
    const [measures, rows] = await Promise.all([
      this.prisma.productMeasure.findMany({ where: { productId }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.productVideo.findMany({ where: { productId } }),
    ]);
    const rowFor = (code: string) => rows.find((r) => r.measureCode === code) ?? null;
    return {
      product: videoState(product.id, WHOLE_PRODUCT, rowFor(WHOLE_PRODUCT)),
      measures: measures.map((m) => ({ code: m.code, label: m.label, video: videoState(product.id, m.code, rowFor(m.code)) })),
    };
  }

  async state(userId: string, productId: string, measureCode = WHOLE_PRODUCT) {
    const product = await this.ownProduct(userId, productId);
    await this.assertMeasure(product.id, measureCode);
    return videoState(product.id, measureCode, await this.row(product.id, measureCode));
  }

  /**
   * Accepts an upload (a temp file on disk) and converts it in the background. Replaces any
   * earlier upload that hasn't been approved; the live video stays until a new one is approved.
   */
  async upload(userId: string, productId: string, measureCode: string, file: Express.Multer.File | undefined) {
    if (!file?.path) throw new BadRequestException('Attach the video as the "file" field.');
    let handedOver = false;
    try {
      const product = await this.ownProduct(userId, productId, { editable: true });
      await this.assertMeasure(product.id, measureCode);
      if (!this.available) throw new ServiceUnavailableException('Videos aren’t available right now. Please try again later.');
      if (file.size > MAX_VIDEO_UPLOAD_BYTES) throw new BadRequestException('Videos must be 100 MB or smaller.');

      const uploadedAt = new Date();
      const fresh = { status: Status.PROCESSING, uploadedAt, message: null, pendingSeconds: null, pendingTrimmed: false };
      const row = await this.prisma.productVideo.upsert({
        where: { productId_measureCode: { productId: product.id, measureCode } },
        create: { productId: product.id, measureCode, ...fresh },
        update: fresh,
      });
      await this.removeSlot(product, measureCode, 'pending');
      this.enqueue(() => this.process(product, row.id, measureCode, file.path, uploadedAt));
      handedOver = true;
      return videoState(product.id, measureCode, row);
    } finally {
      if (!handedOver) await rm(file.path, { force: true });
    }
  }

  /** Drops the upload that isn't approved yet (processing, waiting, turned down or failed). */
  async cancelPending(userId: string, productId: string, measureCode = WHOLE_PRODUCT) {
    const product = await this.ownProduct(userId, productId, { editable: true });
    const row = await this.row(product.id, measureCode);
    if (!row) return videoState(product.id, measureCode, null);
    const updated = await this.prisma.productVideo.update({
      where: { id: row.id },
      data: { status: Status.NONE, uploadedAt: null, message: null, pendingSeconds: null, pendingTrimmed: false },
    });
    await this.removeSlot(product, measureCode, 'pending');
    return videoState(product.id, measureCode, updated);
  }

  /** Takes the live video down. Buyers stop seeing it at once; no approval needed. */
  async removeLive(userId: string, productId: string, measureCode = WHOLE_PRODUCT) {
    const product = await this.ownProduct(userId, productId, { editable: true });
    const row = await this.row(product.id, measureCode);
    if (!row) return videoState(product.id, measureCode, null);
    const updated = await this.prisma.productVideo.update({ where: { id: row.id }, data: liveCleared() });
    await this.removeSlot(product, measureCode, 'live');
    return videoState(product.id, measureCode, updated);
  }

  /** One of the vendor's own video files. */
  async openOwn(userId: string, productId: string, measureCode: string, slot: VideoSlot, kind: VideoFileKind) {
    const product = await this.ownProduct(userId, productId);
    return this.openFile(product, measureCode, slot, kind);
  }

  /** Deletes every video file of a product that is being deleted (its rows go with the product). */
  async removeFiles(product: ProductRef) {
    await this.storage.removeFolder(folder(product, WHOLE_PRODUCT));
  }

  /**
   * After a product's measures were saved: videos of measures that no longer exist go too.
   * (Measure codes are kept when a vendor edits a measure, so only deleted ones are affected.)
   */
  async pruneMeasures(product: ProductRef, keptCodes: string[]) {
    const gone = await this.prisma.productVideo.findMany({
      where: { productId: product.id, measureCode: { notIn: [WHOLE_PRODUCT, ...keptCodes] } },
    });
    if (!gone.length) return;
    await this.prisma.productVideo.deleteMany({ where: { id: { in: gone.map((g) => g.id) } } });
    for (const g of gone) await this.storage.removeFolder(folder(product, g.measureCode));
    this.logger.log(`Removed ${gone.length} video(s) of deleted measures of product ${product.id}.`);
  }

  // ───────────────────────── Admin ─────────────────────────

  /** A video file, for an admin reviewing it. */
  async openFor(productId: string, measureCode: string, slot: VideoSlot, kind: VideoFileKind) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found.');
    return this.openFile(product, measureCode, slot, kind);
  }

  /**
   * Makes the waiting upload the live video. `uploadedAt` is the upload the admin watched: if
   * the vendor has replaced it since, this refuses rather than approving something unseen.
   */
  async approve(tx: Prisma.TransactionClient, productId: string, measureCode: string, uploadedAt: Date) {
    const { product, row } = await this.pendingRow(tx, productId, measureCode, uploadedAt);
    for (const kind of ['video', 'poster'] as const) {
      const data = await this.storage.readBuffer(fileKey(product, measureCode, 'pending', kind));
      if (!data) throw new ConflictException('The video file is missing. Ask the vendor to upload it again.');
      await this.storage.save(fileKey(product, measureCode, 'live', kind), data);
    }
    await this.removeSlot(product, measureCode, 'pending');
    const updated = await tx.productVideo.update({
      where: { id: row.id },
      data: {
        ...liveCleared(),
        approvedAt: new Date(),
        liveSeconds: row.pendingSeconds,
        status: Status.NONE,
        uploadedAt: null,
        pendingSeconds: null,
        pendingTrimmed: false,
        message: null,
      },
    });
    return { product, video: updated };
  }

  /** Turns the waiting upload down; the vendor sees `reason` until they upload again. */
  async reject(tx: Prisma.TransactionClient, productId: string, measureCode: string, uploadedAt: Date, reason: string) {
    const { product, row } = await this.pendingRow(tx, productId, measureCode, uploadedAt);
    await this.removeSlot(product, measureCode, 'pending');
    const updated = await tx.productVideo.update({
      where: { id: row.id },
      data: { status: Status.REJECTED, message: reason, pendingSeconds: null, pendingTrimmed: false },
    });
    return { product, video: updated };
  }

  /** An admin takes a live video down; the vendor sees `reason`. */
  async adminRemove(tx: Prisma.TransactionClient, productId: string, measureCode: string, reason: string) {
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found.');
    const row = await tx.productVideo.findUnique({ where: { productId_measureCode: { productId, measureCode } } });
    if (!row?.approvedAt) throw new ConflictException('There is no live video here.');
    await this.removeSlot(product, measureCode, 'live');
    // Keep any newer upload that's waiting; otherwise show the reason as a rejection.
    const keepsUpload = row.status === Status.PENDING || row.status === Status.PROCESSING;
    const updated = await tx.productVideo.update({
      where: { id: row.id },
      data: { ...liveCleared(), ...(!keepsUpload && { status: Status.REJECTED, message: reason }) },
    });
    return { product, video: updated };
  }

  // ───────────────────────── Buyers ─────────────────────────

  /**
   * The approved video to show for a measure: the measure's own, or else the whole product's.
   * Null when there's neither.
   */
  async liveVideoFor(productId: string, measureCode: string | null) {
    const rows = await this.prisma.productVideo.findMany({
      where: { productId, approvedAt: { not: null }, measureCode: { in: [WHOLE_PRODUCT, ...(measureCode ? [measureCode] : [])] } },
    });
    return rows.find((r) => r.measureCode && r.measureCode === measureCode) ?? rows.find((r) => r.measureCode === WHOLE_PRODUCT) ?? null;
  }

  /**
   * Sends an approved video to a buyer on WhatsApp, from the shop's number. Reuses Meta's
   * copy for 25 days; if Meta has dropped it (or the shop changed numbers), uploads again
   * once. `too_soon`: the same buyer just got it. Never throws.
   */
  async sendToBuyer(
    tenant: Pick<Tenant, 'id' | 'name' | 'whatsappPhoneNumberId'>,
    video: ProductVideo,
    buyerPhone: string,
    title: string,
  ): Promise<'sent' | 'too_soon' | 'unavailable' | 'failed'> {
    const product = await this.prisma.product.findFirst({ where: { id: video.productId, tenantId: tenant.id } });
    const from = tenant.whatsappPhoneNumberId;
    if (!product || !video.approvedAt || !from || !buyerPhone) return 'unavailable';
    const key = `${video.id}:${buyerPhone}`;
    if (Date.now() - (this.lastSent.get(key) ?? 0) < RESEND_AFTER_MS) return 'too_soon';
    this.lastSent.set(key, Date.now());

    const caption = `🎥 ${title} from ${tenant.name}. Open the order form again to carry on; your basket is saved.`;
    try {
      const fresh = video.waMediaId && video.waMediaUploadedAt && Date.now() - video.waMediaUploadedAt.getTime() < MEDIA_REUSE_MS;
      const mediaId = fresh ? video.waMediaId! : await this.uploadToMeta(product, video, from);
      try {
        await this.waba.sendVideo(from, buyerPhone, mediaId, caption);
      } catch (err) {
        if (!fresh) throw err;
        // Meta may have dropped our copy early, or it was made for an old number: upload again once.
        this.logger.warn(`Sending stored media for video ${video.id} failed; uploading it again.`);
        await this.waba.sendVideo(from, buyerPhone, await this.uploadToMeta(product, video, from), caption);
      }
      this.logger.log(`Sent the video "${title}" to ${buyerPhone}.`);
      return 'sent';
    } catch (err: any) {
      this.lastSent.delete(key);
      this.logger.error(`Couldn't send video ${video.id} to ${buyerPhone}: ${err?.message || err}`);
      return 'failed';
    }
  }

  /** Uploads a live video to Meta for the shop's number and remembers the media id. */
  private async uploadToMeta(product: ProductRef, video: ProductVideo, phoneNumberId: string): Promise<string> {
    const data = await this.storage.readBuffer(fileKey(product, video.measureCode, 'live', 'video'));
    if (!data) throw new Error('the live video file is missing');
    const mediaId = await this.waba.uploadMedia(phoneNumberId, data, 'video/mp4', `${video.id}.mp4`);
    // Only if it's still the same live video (a newer one may have been approved meanwhile).
    await this.prisma.productVideo.updateMany({
      where: { id: video.id, approvedAt: video.approvedAt },
      data: { waMediaId: mediaId, waMediaUploadedAt: new Date() },
    });
    return mediaId;
  }

  // ───────────────────────── Conversion ─────────────────────────

  /** Resolves once every queued conversion has finished (for tests and shutdown). */
  whenIdle(): Promise<void> {
    return this.queue;
  }

  private enqueue(job: () => Promise<void>) {
    this.queue = this.queue.then(job, job);
  }

  /** Converts one upload. Gives up quietly if the vendor has replaced or cancelled it meanwhile. */
  private async process(product: ProductRef, videoId: string, measureCode: string, input: string, uploadedAt: Date) {
    const stillWanted = { id: videoId, uploadedAt, status: Status.PROCESSING };
    const work = await mkdtemp(join(tmpdir(), 'video-'));
    try {
      if (!(await this.prisma.productVideo.count({ where: stillWanted }))) return;
      const output = join(work, 'out.mp4');
      const poster = join(work, 'poster.jpg');
      const result = await convertVideo(input, output, poster);

      if (!(await this.prisma.productVideo.count({ where: stillWanted }))) return;
      await this.storage.save(fileKey(product, measureCode, 'pending', 'video'), await readFile(output));
      await this.storage.save(fileKey(product, measureCode, 'pending', 'poster'), await readFile(poster));
      const { count } = await this.prisma.productVideo.updateMany({
        where: stillWanted,
        data: { status: Status.PENDING, pendingSeconds: result.seconds, pendingTrimmed: result.trimmed },
      });
      if (count) {
        this.logger.log(
          `Video ${videoId} (product ${product.id}${measureCode ? `, ${measureCode}` : ''}) converted: ${result.seconds}s, ${Math.round(result.bytes / 1024)} KB; waiting for approval.`,
        );
      }
    } catch (err: any) {
      const message = err instanceof VideoRejected ? err.message : 'We couldn’t process that video. Please try again.';
      if (!(err instanceof VideoRejected)) this.logger.error(`Video conversion ${videoId} failed: ${err?.message || err}`);
      await this.prisma.productVideo.updateMany({ where: stillWanted, data: { status: Status.FAILED, message } }).catch(() => undefined);
    } finally {
      await rm(input, { force: true });
      await rm(work, { recursive: true, force: true });
    }
  }

  // ───────────────────────── Helpers ─────────────────────────

  private row(productId: string, measureCode: string) {
    return this.prisma.productVideo.findUnique({ where: { productId_measureCode: { productId, measureCode } } });
  }

  /** A measure code must be one of the product's measures ('' is the whole product). */
  private async assertMeasure(productId: string, measureCode: string) {
    if (measureCode === WHOLE_PRODUCT) return;
    const exists = await this.prisma.productMeasure.count({ where: { productId, code: measureCode } });
    if (!exists) throw new NotFoundException('This product has no such measure.');
  }

  private async pendingRow(tx: Prisma.TransactionClient, productId: string, measureCode: string, uploadedAt: Date) {
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found.');
    const row = await tx.productVideo.findUnique({ where: { productId_measureCode: { productId, measureCode } } });
    if (!row || row.status !== Status.PENDING || row.uploadedAt?.getTime() !== uploadedAt.getTime()) {
      throw new ConflictException('The vendor has changed this video since you opened it.');
    }
    return { product, row };
  }

  private async openFile(product: ProductRef, measureCode: string, slot: VideoSlot, kind: VideoFileKind) {
    const row = await this.row(product.id, measureCode);
    const exists = slot === 'live' ? Boolean(row?.approvedAt) : row?.status === Status.PENDING;
    if (!exists) throw new NotFoundException(slot === 'live' ? 'There is no live video here.' : 'There is no video waiting here.');
    return { mimeType: kind === 'video' ? 'video/mp4' : 'image/jpeg', stream: await this.storage.read(fileKey(product, measureCode, slot, kind)) };
  }

  private async removeSlot(product: ProductRef, measureCode: string, slot: VideoSlot) {
    await this.storage.remove(fileKey(product, measureCode, slot, 'video'));
    await this.storage.remove(fileKey(product, measureCode, slot, 'poster'));
  }

  private async ownProduct(userId: string, productId: string, { editable = false } = {}) {
    const tenant = await this.tenantService.findByUser(userId);
    if (editable) this.tenantService.assertEditable(tenant);
    const product = await this.prisma.product.findFirst({ where: { id: productId, tenantId: tenant.id } });
    if (!product) throw new NotFoundException('Product not found.');
    return product;
  }
}

function liveCleared() {
  return { approvedAt: null, liveSeconds: null, waMediaId: null, waMediaUploadedAt: null };
}
