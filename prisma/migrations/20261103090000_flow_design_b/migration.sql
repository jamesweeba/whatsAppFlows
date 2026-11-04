-- AlterEnum
ALTER TYPE "MessageSource" ADD VALUE 'LOCATION';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "contactPhone" TEXT,
ADD COLUMN     "customerName" TEXT,
ADD COLUMN     "deliveryArea" TEXT,
ADD COLUMN     "deliverySlot" TEXT,
ADD COLUMN     "flowCartId" TEXT,
ADD COLUMN     "landmark" TEXT,
ADD COLUMN     "locationAddress" TEXT,
ADD COLUMN     "locationLatitude" DOUBLE PRECISION,
ADD COLUMN     "locationLongitude" DOUBLE PRECISION,
ADD COLUMN     "locationName" TEXT,
ADD COLUMN     "locationReceivedAt" TIMESTAMP(3),
ADD COLUMN     "locationRequestedAt" TIMESTAMP(3),
ADD COLUMN     "paymentRequestedAt" TIMESTAMP(3),
ADD COLUMN     "riderName" TEXT,
ADD COLUMN     "riderPhone" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "measureCode" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "deliveryAreas" JSONB,
ADD COLUMN     "deliverySlots" JSONB;

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modifiedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMeasure" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "price" DOUBLE PRECISION NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductMeasure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlowCart" (
    "id" TEXT NOT NULL,
    "flowToken" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "buyerPhone" TEXT NOT NULL,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "editing" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlowCart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_tenantId_slug_key" ON "Category"("tenantId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMeasure_productId_code_key" ON "ProductMeasure"("productId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "FlowCart_flowToken_key" ON "FlowCart"("flowToken");

-- CreateIndex
CREATE INDEX "FlowCart_updatedAt_idx" ON "FlowCart"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_flowCartId_key" ON "Order"("flowCartId");

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMeasure" ADD CONSTRAINT "ProductMeasure_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowCart" ADD CONSTRAINT "FlowCart_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_flowCartId_fkey" FOREIGN KEY ("flowCartId") REFERENCES "FlowCart"("id") ON DELETE SET NULL ON UPDATE CASCADE;

