-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('MOMO', 'CARD', 'COD');

-- CreateEnum
CREATE TYPE "Fulfillment" AS ENUM ('DELIVERY', 'PICKUP');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "deliveryFee" DOUBLE PRECISION NOT NULL DEFAULT 5,
ADD COLUMN     "pickupNote" TEXT;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "whatsappMessageId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "paymentMethod" "PaymentMethod",
ADD COLUMN     "paymentPhone" TEXT,
ADD COLUMN     "momoNetwork" TEXT,
ADD COLUMN     "fulfillment" "Fulfillment",
ADD COLUMN     "deliveryAddress" TEXT,
ADD COLUMN     "deliveryFee" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_whatsappMessageId_key" ON "ChatMessage"("whatsappMessageId");
