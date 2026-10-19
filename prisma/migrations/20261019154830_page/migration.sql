-- DropIndex
DROP INDEX "ChatSession_tenantId_buyerPhone_key";

-- AlterTable
ALTER TABLE "ChatSession" ADD COLUMN     "orderCompleted" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ChatSession_tenantId_buyerPhone_idx" ON "ChatSession"("tenantId", "buyerPhone");

-- CreateIndex
CREATE INDEX "ChatSession_tenantId_buyerPhone_orderCompleted_idx" ON "ChatSession"("tenantId", "buyerPhone", "orderCompleted");
