-- Vendor payouts: a per-shop ledger (pesewas) and Paystack MoMo transfers.
-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('ORDER_EARNING', 'CASH_COMMISSION', 'PAYOUT', 'PAYOUT_REVERSAL');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'PAYOUT_RETRIED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYOUT_SENT';
ALTER TYPE "AuditAction" ADD VALUE 'PAYOUTS_PAUSED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYOUTS_RESUMED';
ALTER TYPE "AuditAction" ADD VALUE 'ORDER_RELEASED';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "paystackAmount" INTEGER,
ADD COLUMN     "paystackPaidAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "payoutsPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "payoutsPausedReason" TEXT,
ADD COLUMN     "paystackRecipientCode" TEXT,
ADD COLUMN     "paystackRecipientFor" TEXT;

-- CreateTable
CREATE TABLE "VendorLedgerEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "orderId" TEXT,
    "orderNumber" TEXT,
    "payoutId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorPayout" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "reference" TEXT NOT NULL,
    "transferCode" TEXT,
    "momoNumber" TEXT NOT NULL,
    "momoName" TEXT,
    "initiatedById" TEXT,
    "failureReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorLedgerEntry_tenantId_createdAt_idx" ON "VendorLedgerEntry"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VendorLedgerEntry_orderId_type_key" ON "VendorLedgerEntry"("orderId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "VendorPayout_reference_key" ON "VendorPayout"("reference");

-- CreateIndex
CREATE INDEX "VendorPayout_tenantId_createdAt_idx" ON "VendorPayout"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "VendorPayout_status_createdAt_idx" ON "VendorPayout"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "VendorLedgerEntry" ADD CONSTRAINT "VendorLedgerEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorLedgerEntry" ADD CONSTRAINT "VendorLedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorLedgerEntry" ADD CONSTRAINT "VendorLedgerEntry_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "VendorPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPayout" ADD CONSTRAINT "VendorPayout_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

