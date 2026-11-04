-- When the buyer confirmed receipt from WhatsApp.
ALTER TABLE "Order" ADD COLUMN "deliveryConfirmedAt" TIMESTAMP(3);
