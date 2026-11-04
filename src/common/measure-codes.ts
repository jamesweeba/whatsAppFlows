/**
 * Measure codes with a special meaning in the WhatsApp Flow. Products are validated
 * against RESERVED_MEASURE_CODES, so a vendor's measure can never collide with them.
 */
export const MEASURE_CODES = {
  /** The single measure of a product sold without measures. */
  EACH: 'each',
  /** The "Remove from basket" option on PRODUCT. */
  REMOVE: 'remove',
  /** Placeholder for an empty sku / measure in Flow payloads. */
  NONE: 'none',
} as const;

/** Codes a vendor cannot use for a measure. */
export const RESERVED_MEASURE_CODES: readonly string[] = [MEASURE_CODES.REMOVE, MEASURE_CODES.NONE];
