import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface.js';
import { optionalEnv } from './config.js';

/** Any port on localhost / 127.0.0.1, for running the vendor and admin UIs locally. */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * CORS for the vendor and admin web apps. Allowed origins come from CORS_ORIGINS
 * (comma-separated, e.g. "https://vendor.marketix.app,https://admin.marketix.app");
 * when it is unset only local origins are allowed. Auth is a Bearer token, not cookies,
 * so credentials stay off. Webhooks from Meta and Paystack are server-to-server and
 * unaffected.
 */
export function corsOptions(configured = optionalEnv('CORS_ORIGINS')): CorsOptions {
  const allowed = configured
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  return {
    origin: allowed.length ? allowed : LOCAL_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    // Lets the UI read the file name of document and template downloads.
    exposedHeaders: ['Content-Disposition'],
    maxAge: 600,
  };
}
