-- Admin decisions on product videos.
ALTER TYPE "AuditAction" ADD VALUE 'VIDEO_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'VIDEO_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'VIDEO_REMOVED';
