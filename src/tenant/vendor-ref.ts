/** A shop's refNumber as admins see it: 113 -> "MX-V-0113". */
export function formatVendorRef(refNumber: number): string {
  return `MX-V-${String(refNumber).padStart(4, '0')}`;
}

/** "MX-V-0113", "mxv113" or "0113" -> 113; anything else -> null. */
export function parseVendorRef(value: string): number | null {
  const match = /^(?:mx-?v-?)?0*(\d{1,9})$/i.exec(value.trim());
  return match ? Number(match[1]) : null;
}
