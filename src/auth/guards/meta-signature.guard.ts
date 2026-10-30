import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { hmacHex, safeEqual } from '../../common/crypto.util.js';

/**
 * Verifies the `X-Hub-Signature-256` header Meta attaches to every webhook and
 * Flow data-exchange request. The signature is an HMAC-SHA256 of the raw body
 * keyed with the Meta app secret (`META_APP_SECRET`).
 *
 * Requires the Nest app to be created with `rawBody: true`.
 * Fails closed when the secret is not configured.
 */
@Injectable()
export class MetaSignatureGuard implements CanActivate {
  private readonly logger = new Logger(MetaSignatureGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const appSecret = process.env.META_APP_SECRET;
    if (!appSecret) {
      this.logger.error('META_APP_SECRET is not configured. Rejecting Meta webhook request.');
      throw new ForbiddenException('Meta webhook signature verification is not configured.');
    }

    const request = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const header = request.headers['x-hub-signature-256'];
    const provided = Array.isArray(header) ? header[0] : header;

    if (!provided || !provided.startsWith('sha256=') || !request.rawBody) {
      this.logger.warn('Rejected Meta request: missing signature header or raw body.');
      throw new ForbiddenException('Invalid Meta signature.');
    }

    const expected = `sha256=${hmacHex('sha256', appSecret, request.rawBody)}`;
    if (!safeEqual(provided, expected)) {
      this.logger.warn('Rejected Meta request: signature mismatch.');
      throw new ForbiddenException('Invalid Meta signature.');
    }

    return true;
  }
}
