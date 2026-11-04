-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'BANNER_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'BANNER_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'BANNER_REMOVED';

-- Shop banner: the approved one, one waiting for approval, and the last rejection reason.
ALTER TABLE "Tenant" ADD COLUMN "bannerUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "bannerPendingAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "bannerRejectedReason" TEXT;
