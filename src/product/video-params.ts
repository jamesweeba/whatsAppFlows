import { BadRequestException } from '@nestjs/common';
import type { VideoSlot } from './product-video.service.js';

/** A measure code from `?measure=` ('' or missing: the whole product). Codes are lowercase letters, digits and _. */
export function measureParam(value: string | undefined): string {
  const code = (value ?? '').trim();
  if (code && !/^[a-z0-9_]{1,40}$/.test(code)) throw new BadRequestException('Unknown measure.');
  return code;
}

/** `pending` or `live`, from the URL. */
export function videoSlot(value: string): VideoSlot {
  if (value !== 'pending' && value !== 'live') throw new BadRequestException('Use pending or live.');
  return value;
}
