import parsePhoneNumber from 'libphonenumber-js';

/**
 * Extract numerical international calling country code from a phone number string.
 * Examples:
 * - "+233240000000" -> "233"
 * - "233240000000"  -> "233"
 * - "+14155552671"  -> "1"
 * - "+2348012345678" -> "234"
 */
export function extractCountryCode(phoneNumber: string): string {
  if (!phoneNumber) {
    return '233'; // Default fallback
  }

  const cleaned = phoneNumber.trim();
  const formattedNumber = cleaned.startsWith('+') ? cleaned : `+${cleaned}`;

  try {
    const parsed = parsePhoneNumber(formattedNumber);
    if (parsed && parsed.countryCallingCode) {
      return parsed.countryCallingCode;
    }
  } catch {
    // libphonenumber-js failed to parse
  }

  // Fallback regex matcher for leading 1-4 digits after optional '+'
  const match = cleaned.replace(/^\+/, '').match(/^(\d{1,4})/);
  return match ? match[1] : '233';
}
