-- Orders a vendor entered in the dashboard (not placed by the buyer).
ALTER TABLE "Order" ADD COLUMN "vendorCreated" BOOLEAN NOT NULL DEFAULT false;
