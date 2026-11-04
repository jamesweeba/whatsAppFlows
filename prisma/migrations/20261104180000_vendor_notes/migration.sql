-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'NOTE_ADDED';
ALTER TYPE "AuditAction" ADD VALUE 'NOTE_EDITED';
ALTER TYPE "AuditAction" ADD VALUE 'NOTE_DELETED';

-- CreateTable
CREATE TABLE "VendorNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorNote_tenantId_createdAt_idx" ON "VendorNote"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "VendorNote" ADD CONSTRAINT "VendorNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorNote" ADD CONSTRAINT "VendorNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
