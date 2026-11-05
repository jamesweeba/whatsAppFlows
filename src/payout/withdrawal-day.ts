/**
 * Vendors may withdraw once per calendar day in Accra. Ghana is on GMT all year (no
 * daylight saving), so an Accra day runs from midnight to midnight UTC.
 */

/** Midnight at the start of `now`'s day in Accra. */
export function startOfAccraDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The next midnight in Accra: when a vendor who withdrew today can withdraw again. */
export function nextAccraMidnight(now: Date = new Date()): Date {
  const next = startOfAccraDay(now);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
