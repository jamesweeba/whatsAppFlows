-- Videos per measure: product videos move from columns on "Product" to their own table,
-- one row per product and measure ('' = the whole product). Existing videos become
-- whole-product rows; their files keep their paths (videos/<shop>/<product>/...).

-- CreateTable
CREATE TABLE "ProductVideo" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "measureCode" TEXT NOT NULL DEFAULT '',
    "status" "ProductVideoStatus" NOT NULL DEFAULT 'NONE',
    "uploadedAt" TIMESTAMP(3),
    "pendingSeconds" INTEGER,
    "pendingTrimmed" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT,
    "approvedAt" TIMESTAMP(3),
    "liveSeconds" INTEGER,
    "waMediaId" TEXT,
    "waMediaUploadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVideo_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductVideo_status_idx" ON "ProductVideo"("status");
CREATE UNIQUE INDEX "ProductVideo_productId_measureCode_key" ON "ProductVideo"("productId", "measureCode");
ALTER TABLE "ProductVideo" ADD CONSTRAINT "ProductVideo_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Keep every existing video (live or waiting) as the product's whole-product video.
INSERT INTO "ProductVideo" ("id", "productId", "measureCode", "status", "uploadedAt", "pendingSeconds", "pendingTrimmed", "message",
                            "approvedAt", "liveSeconds", "waMediaId", "waMediaUploadedAt", "updatedAt")
SELECT gen_random_uuid()::text, "id", '', "videoStatus", "videoUploadedAt", "pendingVideoSeconds", "pendingVideoTrimmed", "videoMessage",
       "videoApprovedAt", "liveVideoSeconds", "waVideoMediaId", "waVideoUploadedAt", CURRENT_TIMESTAMP
FROM "Product"
WHERE "videoStatus" <> 'NONE' OR "videoApprovedAt" IS NOT NULL;

-- The old columns (and the partial index on videoStatus, which goes with its column).
ALTER TABLE "Product" DROP COLUMN "liveVideoSeconds",
DROP COLUMN "pendingVideoSeconds",
DROP COLUMN "pendingVideoTrimmed",
DROP COLUMN "videoApprovedAt",
DROP COLUMN "videoMessage",
DROP COLUMN "videoStatus",
DROP COLUMN "videoUploadedAt",
DROP COLUMN "waVideoMediaId",
DROP COLUMN "waVideoUploadedAt";
