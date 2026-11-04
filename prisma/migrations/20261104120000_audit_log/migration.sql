-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('REVIEW_STARTED', 'CHECKLIST_UPDATED', 'APPROVED', 'MORE_INFO_REQUESTED', 'REJECTED', 'SUSPENDED', 'NUMBER_RELEASED', 'REINSTATED', 'NUMBER_ADDED', 'NUMBER_FREED', 'NUMBER_REFRESHED', 'DOCUMENT_VIEWED');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "reviewChecks" JSONB;

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "tenantId" TEXT,
    "tenantName" TEXT,
    "numberId" TEXT,
    "displayNumber" TEXT,
    "details" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");


-- Entries can't be edited or deleted, even by a bug or a stray SQL statement.
CREATE FUNCTION "audit_log_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog entries cannot be changed or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_immutable"
BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION "audit_log_immutable"();

-- Backfill: every review decision recorded so far.
INSERT INTO "AuditLog" ("id", "actorId", "actorName", "action", "tenantId", "tenantName", "numberId", "displayNumber", "details", "metadata", "createdAt")
SELECT
  gen_random_uuid()::text,
  r."reviewerId",
  TRIM(u."firstName" || ' ' || u."lastName"),
  (CASE r."decision"
    WHEN 'APPROVED' THEN 'APPROVED'
    WHEN 'MORE_INFO' THEN 'MORE_INFO_REQUESTED'
    WHEN 'REJECTED' THEN 'REJECTED'
    WHEN 'SUSPENDED' THEN 'SUSPENDED'
    WHEN 'RELEASED' THEN 'NUMBER_RELEASED'
    WHEN 'REINSTATED' THEN 'REINSTATED'
  END)::"AuditAction",
  r."tenantId",
  t."name",
  r."numberId",
  n."displayNumber",
  CASE r."decision"
    WHEN 'APPROVED' THEN CONCAT_WS(' ', 'Assigned ' || n."displayNumber" || '.', r."notes")
    WHEN 'RELEASED' THEN CONCAT_WS(' ', n."displayNumber" || ' released.', r."notes")
    ELSE r."notes"
  END,
  CASE WHEN r."checks" IS NOT NULL THEN jsonb_build_object('checks', r."checks") END,
  r."createdAt"
FROM "VendorReview" r
JOIN "User" u ON u."id" = r."reviewerId"
JOIN "Tenant" t ON t."id" = r."tenantId"
LEFT JOIN "WhatsappNumber" n ON n."id" = r."numberId";
