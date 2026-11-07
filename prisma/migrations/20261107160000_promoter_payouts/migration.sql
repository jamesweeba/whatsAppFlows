-- Promoter money: commission taken off the vendor's earning, a promoter ledger, and MoMo payouts.

-- CreateEnum
CREATE TYPE "PromoterLedgerEntryType" AS ENUM ('COMMISSION', 'PAYOUT', 'PAYOUT_REVERSAL');

-- AlterEnum
ALTER TYPE "LedgerEntryType" ADD VALUE 'PROMOTER_COMMISSION';

-- AlterTable
ALTER TABLE "Promoter" ADD COLUMN     "paystackRecipientCode" TEXT,
ADD COLUMN     "paystackRecipientFor" TEXT;

-- CreateTable
CREATE TABLE "PromoterLedgerEntry" (
    "id" TEXT NOT NULL,
    "promoterId" TEXT NOT NULL,
    "type" "PromoterLedgerEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "orderId" TEXT,
    "orderNumber" TEXT,
    "tenantId" TEXT,
    "shopName" TEXT,
    "payoutId" TEXT,
    "availableAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoterLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoterPayout" (
    "id" TEXT NOT NULL,
    "promoterId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "reference" TEXT NOT NULL,
    "transferCode" TEXT,
    "momoNumber" TEXT NOT NULL,
    "momoName" TEXT,
    "failureReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoterPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromoterLedgerEntry_promoterId_createdAt_idx" ON "PromoterLedgerEntry"("promoterId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromoterLedgerEntry_orderId_type_key" ON "PromoterLedgerEntry"("orderId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "PromoterPayout_reference_key" ON "PromoterPayout"("reference");

-- CreateIndex
CREATE INDEX "PromoterPayout_promoterId_createdAt_idx" ON "PromoterPayout"("promoterId", "createdAt");

-- CreateIndex
CREATE INDEX "PromoterPayout_status_createdAt_idx" ON "PromoterPayout"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "PromoterLedgerEntry" ADD CONSTRAINT "PromoterLedgerEntry_promoterId_fkey" FOREIGN KEY ("promoterId") REFERENCES "Promoter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoterLedgerEntry" ADD CONSTRAINT "PromoterLedgerEntry_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "PromoterPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoterPayout" ADD CONSTRAINT "PromoterPayout_promoterId_fkey" FOREIGN KEY ("promoterId") REFERENCES "Promoter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
