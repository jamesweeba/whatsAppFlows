-- CreateEnum
CREATE TYPE "MessageSender" AS ENUM ('BUYER', 'VENDOR', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageSource" AS ENUM ('TEXT', 'FLOW_SELECTION', 'MEDIA');

-- CreateEnum
CREATE TYPE "BuyerIntent" AS ENUM ('GREETING', 'VIEW_CATALOG', 'PRODUCT_INQUIRY', 'STOCK_CHECK', 'ORDER_INTENT', 'HUMAN_SUPPORT', 'OUT_OF_BOUNDS');

-- CreateTable
CREATE TABLE "ChatSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "buyerPhone" TEXT NOT NULL,
    "lastIntent" "BuyerIntent",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sender" "MessageSender" NOT NULL,
    "source" "MessageSource" NOT NULL DEFAULT 'TEXT',
    "text" TEXT NOT NULL,
    "flowData" JSONB,
    "detectedIntent" "BuyerIntent",
    "confidenceScore" DOUBLE PRECISION,
    "rawAiResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatSession_tenantId_buyerPhone_key" ON "ChatSession"("tenantId", "buyerPhone");

-- AddForeignKey
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
