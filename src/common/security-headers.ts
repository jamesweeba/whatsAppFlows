import type { NextFunction, Request, Response } from 'express';

/**
 * Headers every API response carries (what helmet would set, for a JSON and file API):
 * - nosniff: browsers use the Content-Type we send, never guess (no uploaded file runs as HTML).
 * - A CSP that allows nothing, and no framing: if a response is ever opened directly in a
 *   browser, it can't run script or be framed for clickjacking.
 * - HSTS: browsers that reached us over HTTPS keep using HTTPS.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.removeHeader('X-Powered-By');
  next();
}
