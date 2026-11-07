-- Admin tools for promoters: suspension reason, admin-sent payouts, audit actions.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'PROMOTER_SUSPENDED';
ALTER TYPE "AuditAction" ADD VALUE 'PROMOTER_REINSTATED';
ALTER TYPE "AuditAction" ADD VALUE 'PROMOTER_PAYOUT_RETRIED';

-- AlterTable
ALTER TABLE "Promoter" ADD COLUMN     "suspendedReason" TEXT;

-- AlterTable
ALTER TABLE "PromoterPayout" ADD COLUMN     "initiatedById" TEXT;
