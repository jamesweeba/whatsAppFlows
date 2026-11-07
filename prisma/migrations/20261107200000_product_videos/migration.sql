-- Product videos: a vendor's upload (converted, then approved by an admin) and the live video.

-- CreateEnum
CREATE TYPE "ProductVideoStatus" AS ENUM ('NONE', 'PROCESSING', 'PENDING', 'REJECTED', 'FAILED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "liveVideoSeconds" INTEGER,
ADD COLUMN     "pendingVideoSeconds" INTEGER,
ADD COLUMN     "pendingVideoTrimmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "videoApprovedAt" TIMESTAMP(3),
ADD COLUMN     "videoMessage" TEXT,
ADD COLUMN     "videoStatus" "ProductVideoStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "videoUploadedAt" TIMESTAMP(3),
ADD COLUMN     "waVideoMediaId" TEXT,
ADD COLUMN     "waVideoUploadedAt" TIMESTAMP(3);


-- Pending uploads, for the admin's "videos to approve" list.
CREATE INDEX "Product_videoStatus_idx" ON "Product"("videoStatus") WHERE "videoStatus" = 'PENDING';
