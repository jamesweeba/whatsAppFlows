import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';

/**
 * Guard that validates incoming requests against a shared webhook secret.
 * The caller must supply the secret in the `x-webhook-secret` header.
 *
 * Configure the expected secret via the `WEBHOOK_SECRET` environment variable.
 * If the env var is not set the guard rejects all requests with a clear error.
 */
@Injectable()
export class WebhookSecretGuard implements CanActivate {
  private readonly logger = new Logger(WebhookSecretGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const secret = process.env.WEBHOOK_SECRET;

    if (!secret) {
      this.logger.error(
        'WEBHOOK_SECRET is not configured. Rejecting all requests to the guarded endpoint.',
      );
      throw new ForbiddenException(
        'This endpoint is not available — webhook secret is not configured on this server.',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers['x-webhook-secret'];

    if (!provided || provided !== secret) {
      this.logger.warn(
        `Rejected request to guarded endpoint: invalid or missing x-webhook-secret header.`,
      );
      throw new ForbiddenException('Invalid or missing webhook secret.');
    }

    return true;
  }
}
