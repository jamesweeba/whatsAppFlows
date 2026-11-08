import 'dotenv/config';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { corsOptions } from './common/cors.js';
import { securityHeaders } from './common/security-headers.js';

// Node tries each of a host's addresses (IPv6, then IPv4) for only 250 ms. On a network
// without IPv6 and a slow link, the IPv4 attempt is cut off too and every call to Meta or
// Paystack fails with ETIMEDOUT. 2 s per address costs nothing on a fast server.
setDefaultAutoSelectFamilyAttemptTimeout(2000);

async function bootstrap() {
  // rawBody is required so webhook guards can verify HMAC signatures over the exact payload.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // Behind a reverse proxy (nginx, a load balancer), set TRUST_PROXY to the number of
  // proxies (usually 1) so req.ip is the real client and per-IP login limits work.
  // Without it every request appears to come from the proxy.
  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy) {
    app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
  }
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.enableCors(corsOptions());

  // A short secret can be guessed offline from any token, and then tokens can be forged.
  if ((process.env.JWT_SECRET ?? '').length < 32) {
    console.warn('JWT_SECRET is shorter than 32 characters. Use a long random value, e.g. `openssl rand -hex 32`.');
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
