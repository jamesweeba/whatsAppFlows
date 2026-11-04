-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('VENDOR', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "NumberStatus" AS ENUM ('FREE', 'ASSIGNED', 'COOLING');

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVED', 'MORE_INFO', 'REJECTED', 'SUSPENDED', 'RELEASED', 'REINSTATED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('GHANA_CARD_FRONT', 'GHANA_CARD_BACK', 'STALL_PHOTO', 'BUSINESS_REG');

-- AlterEnum
BEGIN;
CREATE TYPE "TenantStatus_new" AS ENUM ('PENDING', 'STOCKED', 'UNDER_REVIEW', 'MORE_INFO', 'REJECTED', 'ACTIVE', 'SUSPENDED');
ALTER TABLE "Tenant" ALTER COLUMN "status" DROP DEFAULT;
-- INACTIVE no longer exists; such shops become SUSPENDED.
ALTER TABLE "Tenant" ALTER COLUMN "status" TYPE "TenantStatus_new" USING (
  (CASE WHEN "status"::text = 'INACTIVE' THEN 'SUSPENDED' ELSE "status"::text END)::"TenantStatus_new"
);
ALTER TYPE "TenantStatus" RENAME TO "TenantStatus_old";
ALTER TYPE "TenantStatus_new" RENAME TO "TenantStatus";
DROP TYPE "TenantStatus_old";
ALTER TABLE "Tenant" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "market" TEXT,
ADD COLUMN     "momoName" TEXT,
ADD COLUMN     "momoNumber" TEXT,
ADD COLUMN     "ownerFullName" TEXT,
ADD COLUMN     "ownerPhone" TEXT,
ADD COLUMN     "stallLocation" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ALTER COLUMN "whatsappNumber" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'VENDOR';

-- CreateTable
CREATE TABLE "VendorDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorReview" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" "ReviewDecision" NOT NULL,
    "checks" JSONB,
    "notes" TEXT,
    "numberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappNumber" (
    "id" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "displayNumber" TEXT NOT NULL,
    "wabaId" TEXT,
    "status" "NumberStatus" NOT NULL DEFAULT 'FREE',
    "tenantId" TEXT,
    "displayName" TEXT,
    "qualityRating" TEXT,
    "messagingLimit" TEXT,
    "refreshedAt" TIMESTAMP(3),
    "assignedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modifiedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappNumber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VendorDocument_tenantId_type_key" ON "VendorDocument"("tenantId", "type");

-- CreateIndex
CREATE INDEX "VendorReview_tenantId_createdAt_idx" ON "VendorReview"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappNumber_phoneNumberId_key" ON "WhatsappNumber"("phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappNumber_displayNumber_key" ON "WhatsappNumber"("displayNumber");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappNumber_tenantId_key" ON "WhatsappNumber"("tenantId");

-- CreateIndex
CREATE INDEX "WhatsappNumber_status_idx" ON "WhatsappNumber"("status");

-- AddForeignKey
ALTER TABLE "VendorDocument" ADD CONSTRAINT "VendorDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorReview" ADD CONSTRAINT "VendorReview_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorReview" ADD CONSTRAINT "VendorReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappNumber" ADD CONSTRAINT "WhatsappNumber_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Data: carry existing shops into the onboarding model ──

-- Owner name defaults to the account holder's name.
UPDATE "Tenant" t SET "ownerFullName" = u."firstName" || ' ' || u."lastName"
FROM "User" u WHERE u."id" = t."userId" AND t."ownerFullName" IS NULL;

-- Shops that already have a working number keep it: it joins the pool as ASSIGNED
-- and the shop is ACTIVE, so buyers can keep ordering.
INSERT INTO "WhatsappNumber" ("id", "phoneNumberId", "displayNumber", "status", "tenantId", "displayName", "assignedAt", "modifiedAt")
SELECT gen_random_uuid()::text, t."whatsappPhoneNumberId", t."whatsappNumber", 'ASSIGNED', t."id", t."name", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Tenant" t
WHERE t."whatsappPhoneNumberId" IS NOT NULL AND t."whatsappNumber" IS NOT NULL;

UPDATE "Tenant" SET "status" = 'ACTIVE'
WHERE "whatsappPhoneNumberId" IS NOT NULL AND "status" = 'PENDING';

-- Shops without a number but with stock go straight into the review queue.
UPDATE "Tenant" t SET "status" = 'STOCKED', "submittedAt" = CURRENT_TIMESTAMP
WHERE t."status" = 'PENDING' AND t."whatsappPhoneNumberId" IS NULL
  AND EXISTS (SELECT 1 FROM "Product" p WHERE p."tenantId" = t."id" AND p."inStock");
