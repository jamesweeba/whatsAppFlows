-- Vendors withdraw from their balance (once per Accra day) instead of the 7 am automatic run.
-- CreateEnum
CREATE TYPE "PayoutSource" AS ENUM ('VENDOR', 'ADMIN', 'AUTOMATIC');

-- AlterTable
ALTER TABLE "VendorPayout" ADD COLUMN "source" "PayoutSource" NOT NULL DEFAULT 'ADMIN';

-- Payouts made before this: an admin's when initiatedById is set, otherwise the 7 am run.
UPDATE "VendorPayout" SET "source" = 'AUTOMATIC' WHERE "initiatedById" IS NULL;

-- CreateIndex
CREATE INDEX "VendorPayout_tenantId_source_createdAt_idx" ON "VendorPayout"("tenantId", "source", "createdAt");
