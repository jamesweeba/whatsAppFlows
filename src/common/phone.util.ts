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

const GHANA_MOMO_PREFIXES: Record<string, 'mtn' | 'telecel' | 'airteltigo'> = {
  '024': 'mtn', '025': 'mtn', '053': 'mtn', '054': 'mtn', '055': 'mtn', '059': 'mtn',
  '020': 'telecel', '050': 'telecel',
  '026': 'airteltigo', '027': 'airteltigo', '056': 'airteltigo', '057': 'airteltigo',
};

/** Infer the mobile-money network from a Ghana number's prefix, or null when unknown. */
export function ghanaMomoNetwork(phone: string): 'mtn' | 'telecel' | 'airteltigo' | null {
  return GHANA_MOMO_PREFIXES[toGhanaLocal(phone).slice(0, 3)] ?? null;
}

/** True for a dialable 10-digit Ghana number such as `0244111222`. */
export function isGhanaMobile(phone: string): boolean {
  return /^0\d{9}$/.test(toGhanaLocal(phone));
}

/** Human-friendly Ghana local format, e.g. `024 411 1222`. */
export function formatGhanaLocal(phone: string): string {
  const local = toGhanaLocal(phone);
  return local.length === 10 ? `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}` : local;
}

/** International Ghana format for admin screens and logs, e.g. `+233 59 200 1176`. */
export function formatGhanaInternational(phone: string): string {
  const local = toGhanaLocal(phone);
  return local.length === 10 ? `+233 ${local.slice(1, 3)} ${local.slice(3, 6)} ${local.slice(6)}` : phone;
}
