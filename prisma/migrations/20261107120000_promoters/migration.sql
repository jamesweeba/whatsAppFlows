-- Promoters: people who share shops' links and earn commission (see PROMOTERS_SPEC.md).

-- CreateEnum
CREATE TYPE "PromoterStatus" AS ENUM ('SIGNING_UP', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "PromoterSignupStep" AS ENUM ('ASK_NAME', 'ASK_MOMO', 'CONFIRM_MOMO_NAME', 'ASK_TERMS');

-- CreateEnum
CREATE TYPE "PromoterMembershipStatus" AS ENUM ('REQUESTED', 'INVITED', 'APPROVED', 'DECLINED', 'REMOVED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "promoterRate" INTEGER;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "acceptPromoterRequests" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "promoterRate" INTEGER,
ADD COLUMN     "promotionsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Promoter" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "fullName" TEXT,
    "momoNumber" TEXT,
    "momoNetwork" TEXT,
    "momoName" TEXT,
    "momoVerifiedAt" TIMESTAMP(3),
    "termsAcceptedAt" TIMESTAMP(3),
    "status" "PromoterStatus" NOT NULL DEFAULT 'SIGNING_UP',
    "signupStep" "PromoterSignupStep" DEFAULT 'ASK_NAME',
    "pendingInviteCode" TEXT,
    "lastInboundMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modifiedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promoter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoterMembership" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "promoterId" TEXT,
    "status" "PromoterMembershipStatus" NOT NULL,
    "invitedPhone" TEXT,
    "inviteCode" TEXT,
    "inviteProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modifiedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoterMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoLink" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "promoterId" TEXT NOT NULL,
    "productId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modifiedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Promoter_phone_key" ON "Promoter"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "PromoterMembership_inviteCode_key" ON "PromoterMembership"("inviteCode");

-- CreateIndex
CREATE INDEX "PromoterMembership_tenantId_status_idx" ON "PromoterMembership"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PromoterMembership_tenantId_promoterId_key" ON "PromoterMembership"("tenantId", "promoterId");

-- CreateIndex
CREATE UNIQUE INDEX "PromoLink_code_key" ON "PromoLink"("code");

-- CreateIndex
CREATE INDEX "PromoLink_promoterId_active_idx" ON "PromoLink"("promoterId", "active");

-- AddForeignKey
ALTER TABLE "PromoterMembership" ADD CONSTRAINT "PromoterMembership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoterMembership" ADD CONSTRAINT "PromoterMembership_promoterId_fkey" FOREIGN KEY ("promoterId") REFERENCES "Promoter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoLink" ADD CONSTRAINT "PromoLink_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "PromoterMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoLink" ADD CONSTRAINT "PromoLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoLink" ADD CONSTRAINT "PromoLink_promoterId_fkey" FOREIGN KEY ("promoterId") REFERENCES "Promoter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoLink" ADD CONSTRAINT "PromoLink_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Commission rates are whole percent, 1-20.
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_promoterRate_range" CHECK ("promoterRate" IS NULL OR "promoterRate" BETWEEN 1 AND 20);
ALTER TABLE "Product" ADD CONSTRAINT "Product_promoterRate_range" CHECK ("promoterRate" IS NULL OR "promoterRate" BETWEEN 1 AND 20);

-- At most one active shop link, and one active link per product, per membership.
CREATE UNIQUE INDEX "PromoLink_one_active_shop_link" ON "PromoLink"("membershipId") WHERE "active" AND "productId" IS NULL;
CREATE UNIQUE INDEX "PromoLink_one_active_product_link" ON "PromoLink"("membershipId", "productId") WHERE "active" AND "productId" IS NOT NULL;
