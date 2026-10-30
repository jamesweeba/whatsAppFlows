/**
 * Phone-number helpers shared by the WhatsApp, payment and chat layers.
 *
 * Three representations are used across the system:
 *  - international digits, no plus:  233245655799  (what Meta's Cloud API wants in `to`)
 *  - E.164 with plus:                +233245655799 (what we persist as buyerPhone)
 *  - Ghana local:                     0245655799   (what Paystack mobile money wants)
 *
 * Meta can also deliver a "business-scoped user id" (BSUID) such as `GH.989894404158856`
 * for buyers who hide their number. Those identifiers are passed through untouched.
 */

export const DEFAULT_COUNTRY_CODE = '233';

const BSUID_PATTERN = /^[A-Za-z]{2}\./;

/** True for Meta business-scoped user ids like `GH.989894404158856`. */
export function isBsuid(value: string): boolean {
  return BSUID_PATTERN.test((value || '').trim());
}

/** True when the identifier is not a dialable phone number (BSUID or contains letters). */
export function isHiddenNumber(value: string): boolean {
  const trimmed = (value || '').trim();
  return trimmed === '' || isBsuid(trimmed) || /[A-Za-z]/.test(trimmed);
}

/**
 * Normalise to international digits without the leading plus, e.g. `233245655799`.
 * Local Ghanaian numbers (`0245655799` / `245655799`) are prefixed with the default country code.
 * BSUIDs are returned unchanged.
 */
export function toInternationalDigits(phone: string, countryCode = DEFAULT_COUNTRY_CODE): string {
  const trimmed = (phone || '').trim();
  if (!trimmed) return '';
  if (isBsuid(trimmed)) return trimmed;

  let digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);

  if (digits.startsWith('0') && digits.length === 10) {
    return countryCode + digits.slice(1);
  }
  if (!digits.startsWith('0') && digits.length === 9) {
    return countryCode + digits;
  }
  return digits;
}

/** Normalise to E.164 with a leading plus (`+233245655799`). BSUIDs are returned unchanged. */
export function toE164(phone: string, countryCode = DEFAULT_COUNTRY_CODE): string {
  const digits = toInternationalDigits(phone, countryCode);
  if (!digits || isBsuid(digits)) return digits;
  return `+${digits}`;
}

/** Normalise to the 10-digit Ghana local format Paystack expects (`0241234567`). */
export function toGhanaLocal(phone: string): string {
  let digits = (phone || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+233')) {
    digits = '0' + digits.slice(4);
  } else if (digits.startsWith('233') && digits.length === 12) {
    digits = '0' + digits.slice(3);
  } else if (!digits.startsWith('0') && digits.length === 9) {
    digits = '0' + digits;
  }
  return digits;
}
