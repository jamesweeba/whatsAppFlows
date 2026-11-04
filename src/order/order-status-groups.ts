import { OrderStatus } from '@prisma/client';

/** The vendor still has to fulfil these: paid (or COD confirmed) but not yet delivered. */
export const OPEN_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.CONFIRMED,
  OrderStatus.PROCESSING,
  OrderStatus.OUT_FOR_DELIVERY,
];

export const DELIVERED_ORDER_STATUSES: OrderStatus[] = [OrderStatus.DELIVERED, OrderStatus.COMPLETED];

export const CANCELLED_ORDER_STATUSES: OrderStatus[] = [OrderStatus.CANCELLED, OrderStatus.REFUNDED];

/** Waiting on the buyer: never paid, so not counted as placed. */
export const UNPAID_ORDER_STATUSES: OrderStatus[] = [OrderStatus.PENDING, OrderStatus.AWAITING_PAYMENT];

/** Paid, or past payment, and not cancelled: what counts as business done. */
export const PAID_ORDER_STATUSES: OrderStatus[] = [...OPEN_ORDER_STATUSES, ...DELIVERED_ORDER_STATUSES];

/** Orders a buyer actually placed: paid or confirmed, including ones later cancelled. */
export const PLACED_ORDER_STATUSES: OrderStatus[] = [...PAID_ORDER_STATUSES, ...CANCELLED_ORDER_STATUSES];
