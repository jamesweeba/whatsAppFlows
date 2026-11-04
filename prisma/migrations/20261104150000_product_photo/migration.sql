-- Product photos uploaded by the vendor (the file itself lives in storage).
ALTER TABLE "Product" ADD COLUMN "photoMimeType" TEXT;
ALTER TABLE "Product" ADD COLUMN "photoUpdatedAt" TIMESTAMP(3);
