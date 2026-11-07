-- Referrals: which buyer came from which promoter link, and the order it was credited to.

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "buyerPhone" TEXT NOT NULL,
    "promoterId" TEXT NOT NULL,
    "linkId" TEXT,
    "linkCode" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT,
    "ratePercent" INTEGER NOT NULL,
    "tappedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "orderId" TEXT,
    "attachedAt" TIMESTAMP(3),
    "baseAmount" INTEGER,
    "commissionAmount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modifiedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Referral_orderId_key" ON "Referral"("orderId");

-- CreateIndex
CREATE INDEX "Referral_tenantId_buyerPhone_tappedAt_idx" ON "Referral"("tenantId", "buyerPhone", "tappedAt");

-- CreateIndex
CREATE INDEX "Referral_promoterId_tappedAt_idx" ON "Referral"("promoterId", "tappedAt");

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_promoterId_fkey" FOREIGN KEY ("promoterId") REFERENCES "Promoter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "PromoLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
