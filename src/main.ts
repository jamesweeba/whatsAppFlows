import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { corsOptions } from './common/cors.js';

async function bootstrap() {
  // rawBody is required so webhook guards can verify HMAC signatures over the exact payload.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors(corsOptions());

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
