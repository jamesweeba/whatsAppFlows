# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl

COPY package*.json tsconfig.json tsconfig.build.json nest-cli.json ./
RUN npm ci

COPY src/                    ./src/
COPY prisma/schema.prisma    ./prisma/schema.prisma
COPY prisma/migrations/      ./prisma/migrations/

RUN npx prisma generate && npm run build

# ── Stage 2: Production runner ───────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache openssl \
 && addgroup -g 1001 -S nodejs \
 && adduser  -S nestjs -u 1001

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist         ./dist
COPY package.json                     ./package.json
COPY prisma/schema.prisma             ./prisma/schema.prisma
COPY prisma/migrations/               ./prisma/migrations/
COPY docker-entrypoint.sh             ./docker-entrypoint.sh

RUN chmod +x docker-entrypoint.sh \
 && chown -R nestjs:nodejs /app

USER nestjs

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
