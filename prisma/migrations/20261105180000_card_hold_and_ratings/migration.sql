-- Card earnings are held before they can be withdrawn.
ALTER TABLE "VendorLedgerEntry" ADD COLUMN "availableAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "paystackChannel" TEXT;

-- Buyer ratings after delivery.
ALTER TABLE "Order" ADD COLUMN "ratingRequestedAt" TIMESTAMP(3),
                    ADD COLUMN "buyerRating" INTEGER,
                    ADD COLUMN "ratedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD CONSTRAINT "Order_buyerRating_range" CHECK ("buyerRating" IS NULL OR "buyerRating" BETWEEN 1 AND 5);
CREATE INDEX "Order_tenantId_ratedAt_idx" ON "Order"("tenantId", "ratedAt");
