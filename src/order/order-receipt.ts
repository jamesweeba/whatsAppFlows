import { Fulfillment, PaymentMethod } from '@prisma/client';
import { ghCedis } from '../common/money.util.js';
import { lineTotal } from './order-totals.util.js';

export interface ReceiptOrder {
  orderNumber: string;
  totalAmount: number;
  deliveryFee?: number | null;
  fulfillment?: Fulfillment | null;
  deliveryAddress?: string | null;
  deliverySlot?: string | null;
  customerName?: string | null;
  paymentMethod?: PaymentMethod | null;
  paymentPhone?: string | null;
  items?: Array<{
    productName: string;
    quantity: number;
    unitPrice: number;
    totalPrice?: number | null;
  }>;
}

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  MOMO: 'Mobile Money',
  CARD: 'Card Payment',
  COD: 'Cash on Delivery',
};

/**
 * Build the WhatsApp receipt sent to a buyer once an order has been placed.
 * Works from the order's own columns, so the output is the same regardless of
 * which channel (Flow or interactive chat) created the order.
 */
export function formatOrderReceipt(order: ReceiptOrder): string {
  const lines: string[] = [`🧾 *Order ${order.orderNumber} placed successfully!*\n`];

  if (order.items && order.items.length > 0) {
    lines.push('📦 *Items Ordered:*');
    let subtotal = 0;
    for (const item of order.items) {
      const amount = item.totalPrice ?? lineTotal(item);
      subtotal += amount;
      lines.push(`• ${item.quantity}x ${item.productName} — ${ghCedis(amount)}`);
    }
    lines.push('');

    const deliveryFee = Number(order.deliveryFee || 0);
    if (order.fulfillment === Fulfillment.DELIVERY) {
      lines.push(`🛒 *Items Subtotal:* ${ghCedis(subtotal)}`);
      lines.push(`🛵 *Delivery Fee:* ${ghCedis(deliveryFee)}`);
      lines.push(`💰 *Total Amount:* ${ghCedis(order.totalAmount)}`);
      if (order.customerName) {
        lines.push(`👤 *Name:* ${order.customerName}`);
      }
      if (order.deliveryAddress) {
        lines.push(`📍 *Delivery Address:* ${order.deliveryAddress}`);
      }
      if (order.deliverySlot) {
        lines.push(`🕒 *Delivery Time:* ${order.deliverySlot}`);
      }
    } else if (order.fulfillment === Fulfillment.PICKUP) {
      lines.push(`💰 *Total Amount:* ${ghCedis(order.totalAmount)}`);
      lines.push('🛍️ *Fulfillment:* Store Pickup (Free)');
    } else {
      lines.push(`💰 *Total Amount:* ${ghCedis(order.totalAmount)}`);
    }
    lines.push('');
  }

  switch (order.paymentMethod) {
    case PaymentMethod.MOMO: {
      const phone = order.paymentPhone ? ` (${order.paymentPhone})` : '';
      lines.push(`💳 *Payment Method:* ${PAYMENT_LABELS.MOMO}${phone}`);
      lines.push(`\nPlease approve the MoMo prompt sent to ${order.paymentPhone || 'your phone'}. We'll confirm as soon as payment is received.`);
      break;
    }
    case PaymentMethod.COD:
      lines.push(`💳 *Payment Method:* ${PAYMENT_LABELS.COD}`);
      lines.push('\nYour order has been confirmed for Cash on Delivery. Please have the exact amount ready. We will contact you on WhatsApp with updates.');
      break;
    case PaymentMethod.CARD:
      lines.push(`💳 *Payment Method:* ${PAYMENT_LABELS.CARD}`);
      lines.push('\nUse the secure payment link we sent you on WhatsApp to complete your order.');
      break;
    default:
      lines.push('\nYour order has been received. We will contact you on WhatsApp with updates.');
  }

  return lines.join('\n');
}
