-- Sequential vendor ref (MX-V-0001). Existing shops are numbered in the order they joined.
CREATE SEQUENCE "Tenant_refNumber_seq";
ALTER TABLE "Tenant" ADD COLUMN "refNumber" INTEGER;

UPDATE "Tenant" t
SET "refNumber" = s.n
FROM (SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt", "id") AS n FROM "Tenant") s
WHERE t."id" = s."id";

SELECT setval('"Tenant_refNumber_seq"', COALESCE((SELECT MAX("refNumber") FROM "Tenant"), 0) + 1, false);

ALTER TABLE "Tenant" ALTER COLUMN "refNumber" SET NOT NULL;
ALTER TABLE "Tenant" ALTER COLUMN "refNumber" SET DEFAULT nextval('"Tenant_refNumber_seq"');
ALTER SEQUENCE "Tenant_refNumber_seq" OWNED BY "Tenant"."refNumber";

CREATE UNIQUE INDEX "Tenant_refNumber_key" ON "Tenant"("refNumber");
