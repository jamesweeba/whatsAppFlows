import * as crypto from 'crypto';

/** Constant-time string comparison that also tolerates differing lengths. */
export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** HMAC hex digest helper used for webhook signature checks. */
export function hmacHex(algorithm: 'sha256' | 'sha512', secret: string, payload: string | Buffer): string {
  return crypto.createHmac(algorithm, secret).update(payload).digest('hex');
}
