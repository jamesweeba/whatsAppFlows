import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, Product, ProductVideoStatus as Status, Tenant } from '@prisma/client';
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

type VideoProduct = Pick<
  Product,
  'id' | 'tenantId' | 'videoStatus' | 'videoUploadedAt' | 'pendingVideoSeconds' | 'pendingVideoTrimmed' | 'videoMessage' | 'videoApprovedAt' | 'liveVideoSeconds'
>;

const fileKey = (product: Pick<Product, 'id' | 'tenantId'>, slot: VideoSlot, kind: VideoFileKind) =>
  `videos/${product.tenantId}/${product.id}/${slot}.${kind === 'video' ? 'mp4' : 'jpg'}`;

/** Meta keeps uploaded media 30 days; re-upload a little before that. */
const MEDIA_REUSE_MS = 25 * 24 * 60 * 60 * 1000;
/** The same buyer gets the same product's video at most this often (repeated taps). */
const RESEND_AFTER_MS = 60 * 1000;

/** Where uploads wait on disk until they are converted (they can be up to 100 MB, so not in memory). */
export const VIDEO_UPLOAD_DIR = join(tmpdir(), 'marketix-video-uploads');

/**
 * What the vendor app (and the admin) see about a product's video. File URLs point at the
 * vendor's routes, or the admin's with `forAdmin`.
 */
export function videoState(product: VideoProduct, { forAdmin = false } = {}) {
  const base = forAdmin ? `/api/v1/admin/products/${product.id}/video` : `/api/v1/products/${product.id}/video`;
  return {
    /** The latest upload: NONE, PROCESSING, PENDING (waiting for an admin), REJECTED or FAILED. */
    status: product.videoStatus,
    /** The approved video buyers can watch. */
    live: product.videoApprovedAt
      ? { approvedAt: product.videoApprovedAt, seconds: product.liveVideoSeconds, url: `${base}/live`, posterUrl: `${base}/live/poster` }
      : null,
    /** A converted upload waiting for an admin. */
    pending:
      product.videoStatus === Status.PENDING && product.videoUploadedAt
        ? {
            uploadedAt: product.videoUploadedAt,
            seconds: product.pendingVideoSeconds,
            trimmed: product.pendingVideoTrimmed,
            url: `${base}/pending`,
            posterUrl: `${base}/pending/poster`,
          }
        : null,
    /** Why the upload was turned down or couldn't be converted. */
    message: product.videoStatus === Status.REJECTED || product.videoStatus === Status.FAILED ? product.videoMessage : null,
  };
}

/**
 * Product videos (see VIDEO_SPEC.md). A vendor's upload is converted in the background, one
 * at a time, then waits for an admin; approving it makes it the live video buyers can watch.
 * Files are private: the vendor and admins fetch them with their token.
 */
@Injectable()
export class ProductVideoService implements OnModuleInit {
  private readonly logger = new Logger(ProductVideoService.name);
  private available = false;
  /** Conversions run one after another, so a burst of uploads can't swamp the server. */
  private queue: Promise<void> = Promise.resolve();
  /** When each buyer last got each product's video: `${productId}:${buyerPhone}` → time. */
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
    const { count } = await this.prisma.product.updateMany({
      where: { videoStatus: Status.PROCESSING },
      data: { videoStatus: Status.FAILED, videoMessage: 'Processing was interrupted. Please upload the video again.' },
    });
    if (count) this.logger.warn(`${count} video conversion(s) were interrupted by a restart and marked failed.`);
  }

  // ───────────────────────── Vendor ─────────────────────────

  async state(userId: string, productId: string) {
    return videoState(await this.ownProduct(userId, productId));
  }

  /**
   * Accepts an upload (a temp file on disk) and converts it in the background. Replaces any
   * earlier upload that hasn't been approved; the live video stays until a new one is approved.
   */
  async upload(userId: string, productId: string, file: Express.Multer.File | undefined) {
    if (!file?.path) throw new BadRequestException('Attach the video as the "file" field.');
    let handedOver = false;
    try {
      const product = await this.ownProduct(userId, productId, { editable: true });
      if (!this.available) throw new ServiceUnavailableException('Videos aren’t available right now. Please try again later.');
      if (file.size > MAX_VIDEO_UPLOAD_BYTES) throw new BadRequestException('Videos must be 100 MB or smaller.');

      const uploadedAt = new Date();
      const updated = await this.prisma.product.update({
        where: { id: product.id },
        data: { videoStatus: Status.PROCESSING, videoUploadedAt: uploadedAt, videoMessage: null, pendingVideoSeconds: null, pendingVideoTrimmed: false },
      });
      await this.removeSlot(product, 'pending');
      this.enqueue(() => this.process(product, file.path, uploadedAt));
      handedOver = true;
      return videoState(updated);
    } finally {
      if (!handedOver) await rm(file.path, { force: true });
    }
  }

  /** Drops the upload that isn't approved yet (processing, waiting, turned down or failed). */
  async cancelPending(userId: string, productId: string) {
    const product = await this.ownProduct(userId, productId, { editable: true });
    const updated = await this.prisma.product.update({
      where: { id: product.id },
      data: { videoStatus: Status.NONE, videoUploadedAt: null, videoMessage: null, pendingVideoSeconds: null, pendingVideoTrimmed: false },
    });
    await this.removeSlot(product, 'pending');
    return videoState(updated);
  }

  /** Takes the live video down. Buyers stop seeing it at once; no approval needed. */
  async removeLive(userId: string, productId: string) {
    const product = await this.ownProduct(userId, productId, { editable: true });
    const updated = await this.prisma.product.update({ where: { id: product.id }, data: this.liveCleared() });
    await this.removeSlot(product, 'live');
    return videoState(updated);
  }

  /** One of the vendor's own video files. */
  async openOwn(userId: string, productId: string, slot: VideoSlot, kind: VideoFileKind) {
    return this.openFile(await this.ownProduct(userId, productId), slot, kind);
  }

  /** Deletes every video file of a product that is being deleted. */
  async removeFiles(product: Pick<Product, 'id' | 'tenantId'>) {
    await this.removeSlot(product, 'pending');
    await this.removeSlot(product, 'live');
  }

  // ───────────────────────── Admin ─────────────────────────

  /** A product's video file, for an admin reviewing it. */
  async openFor(productId: string, slot: VideoSlot, kind: VideoFileKind) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found.');
    return this.openFile(product, slot, kind);
  }

  /**
   * Makes the waiting upload the live video. `uploadedAt` is the upload the admin watched: if
   * the vendor has replaced it since, this refuses rather than approving something unseen.
   */
  async approve(tx: Prisma.TransactionClient, productId: string, uploadedAt: Date) {
    const product = await this.pendingProduct(tx, productId, uploadedAt);
    for (const kind of ['video', 'poster'] as const) {
      const data = await this.storage.readBuffer(fileKey(product, 'pending', kind));
      if (!data) throw new ConflictException('The video file is missing. Ask the vendor to upload it again.');
      await this.storage.save(fileKey(product, 'live', kind), data);
    }
    await this.removeSlot(product, 'pending');
    return tx.product.update({
      where: { id: product.id },
      data: {
        ...this.liveCleared(),
        videoApprovedAt: new Date(),
        liveVideoSeconds: product.pendingVideoSeconds,
        videoStatus: Status.NONE,
        videoUploadedAt: null,
        pendingVideoSeconds: null,
        pendingVideoTrimmed: false,
        videoMessage: null,
      },
    });
  }

  /** Turns the waiting upload down; the vendor sees `reason` until they upload again. */
  async reject(tx: Prisma.TransactionClient, productId: string, uploadedAt: Date, reason: string) {
    const product = await this.pendingProduct(tx, productId, uploadedAt);
    await this.removeSlot(product, 'pending');
    return tx.product.update({
      where: { id: product.id },
      data: { videoStatus: Status.REJECTED, videoMessage: reason, pendingVideoSeconds: null, pendingVideoTrimmed: false },
    });
  }

  /** An admin takes a live video down; the vendor sees `reason`. */
  async adminRemove(tx: Prisma.TransactionClient, productId: string, reason: string) {
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found.');
    if (!product.videoApprovedAt) throw new ConflictException('This product has no live video.');
    await this.removeSlot(product, 'live');
    // Keep any newer upload that's waiting; otherwise show the reason as a rejection.
    const keepsUpload = product.videoStatus === Status.PENDING || product.videoStatus === Status.PROCESSING;
    return tx.product.update({
      where: { id: product.id },
      data: { ...this.liveCleared(), ...(!keepsUpload && { videoStatus: Status.REJECTED, videoMessage: reason }) },
    });
  }

  // ───────────────────────── Buyers ─────────────────────────

  /**
   * Sends a product's approved video to a buyer on WhatsApp, from the shop's number. Reuses
   * Meta's copy for 25 days; if Meta has dropped it (or the shop changed numbers), uploads
   * again once. `too_soon`: the same buyer just got it. Never throws.
   */
  async sendToBuyer(tenant: Pick<Tenant, 'id' | 'name' | 'whatsappPhoneNumberId'>, productId: string, buyerPhone: string): Promise<'sent' | 'too_soon' | 'unavailable' | 'failed'> {
    const product = await this.prisma.product.findFirst({ where: { id: productId, tenantId: tenant.id, videoApprovedAt: { not: null } } });
    const from = tenant.whatsappPhoneNumberId;
    if (!product || !from || !buyerPhone) return 'unavailable';
    const key = `${product.id}:${buyerPhone}`;
    if (Date.now() - (this.lastSent.get(key) ?? 0) < RESEND_AFTER_MS) return 'too_soon';
    this.lastSent.set(key, Date.now());

    const caption = `🎥 ${product.name} from ${tenant.name}. Open the order form again to carry on; your basket is saved.`;
    try {
      const fresh = product.waVideoMediaId && product.waVideoUploadedAt && Date.now() - product.waVideoUploadedAt.getTime() < MEDIA_REUSE_MS;
      const mediaId = fresh ? product.waVideoMediaId! : await this.uploadToMeta(product, from);
      try {
        await this.waba.sendVideo(from, buyerPhone, mediaId, caption);
      } catch (err) {
        if (!fresh) throw err;
        // Meta may have dropped our copy early, or it was made for an old number: upload again once.
        this.logger.warn(`Sending stored video media for product ${product.id} failed; uploading it again.`);
        await this.waba.sendVideo(from, buyerPhone, await this.uploadToMeta(product, from), caption);
      }
      this.logger.log(`Sent the video for "${product.name}" to ${buyerPhone}.`);
      return 'sent';
    } catch (err: any) {
      this.lastSent.delete(key);
      this.logger.error(`Couldn't send the video for product ${product.id} to ${buyerPhone}: ${err?.message || err}`);
      return 'failed';
    }
  }

  /** Uploads the live video to Meta for the shop's number and remembers the media id. */
  private async uploadToMeta(product: Product, phoneNumberId: string): Promise<string> {
    const data = await this.storage.readBuffer(fileKey(product, 'live', 'video'));
    if (!data) throw new Error('the live video file is missing');
    const mediaId = await this.waba.uploadMedia(phoneNumberId, data, 'video/mp4', `${product.id}.mp4`);
    // Only if it's still the same live video (a newer one may have been approved meanwhile).
    await this.prisma.product.updateMany({
      where: { id: product.id, videoApprovedAt: product.videoApprovedAt },
      data: { waVideoMediaId: mediaId, waVideoUploadedAt: new Date() },
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
  private async process(product: Pick<Product, 'id' | 'tenantId'>, input: string, uploadedAt: Date) {
    const stillWanted = { id: product.id, videoUploadedAt: uploadedAt, videoStatus: Status.PROCESSING };
    const work = await mkdtemp(join(tmpdir(), 'video-'));
    try {
      if (!(await this.prisma.product.count({ where: stillWanted }))) return;
      const output = join(work, 'out.mp4');
      const poster = join(work, 'poster.jpg');
      const result = await convertVideo(input, output, poster);

      if (!(await this.prisma.product.count({ where: stillWanted }))) return;
      await this.storage.save(fileKey(product, 'pending', 'video'), await readFile(output));
      await this.storage.save(fileKey(product, 'pending', 'poster'), await readFile(poster));
      const { count } = await this.prisma.product.updateMany({
        where: stillWanted,
        data: { videoStatus: Status.PENDING, pendingVideoSeconds: result.seconds, pendingVideoTrimmed: result.trimmed },
      });
      if (count) this.logger.log(`Video for product ${product.id} converted: ${result.seconds}s, ${Math.round(result.bytes / 1024)} KB; waiting for approval.`);
    } catch (err: any) {
      const message = err instanceof VideoRejected ? err.message : 'We couldn’t process that video. Please try again.';
      if (!(err instanceof VideoRejected)) this.logger.error(`Video conversion for product ${product.id} failed: ${err?.message || err}`);
      await this.prisma.product.updateMany({ where: stillWanted, data: { videoStatus: Status.FAILED, videoMessage: message } }).catch(() => undefined);
    } finally {
      await rm(input, { force: true });
      await rm(work, { recursive: true, force: true });
    }
  }

  // ───────────────────────── Helpers ─────────────────────────

  private liveCleared() {
    return { videoApprovedAt: null, liveVideoSeconds: null, waVideoMediaId: null, waVideoUploadedAt: null };
  }

  private async pendingProduct(tx: Prisma.TransactionClient, productId: string, uploadedAt: Date) {
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found.');
    if (product.videoStatus !== Status.PENDING || product.videoUploadedAt?.getTime() !== uploadedAt.getTime()) {
      throw new ConflictException('The vendor has changed this video since you opened it.');
    }
    return product;
  }

  private async openFile(product: Pick<Product, 'id' | 'tenantId' | 'videoStatus' | 'videoApprovedAt'>, slot: VideoSlot, kind: VideoFileKind) {
    const exists = slot === 'live' ? Boolean(product.videoApprovedAt) : product.videoStatus === Status.PENDING;
    if (!exists) throw new NotFoundException(slot === 'live' ? 'This product has no live video.' : 'This product has no video waiting.');
    return { mimeType: kind === 'video' ? 'video/mp4' : 'image/jpeg', stream: await this.storage.read(fileKey(product, slot, kind)) };
  }

  private async removeSlot(product: Pick<Product, 'id' | 'tenantId'>, slot: VideoSlot) {
    await this.storage.remove(fileKey(product, slot, 'video'));
    await this.storage.remove(fileKey(product, slot, 'poster'));
  }

  private async ownProduct(userId: string, productId: string, { editable = false } = {}) {
    const tenant = await this.tenantService.findByUser(userId);
    if (editable) this.tenantService.assertEditable(tenant);
    const product = await this.prisma.product.findFirst({ where: { id: productId, tenantId: tenant.id } });
    if (!product) throw new NotFoundException('Product not found.');
    return product;
  }
}
