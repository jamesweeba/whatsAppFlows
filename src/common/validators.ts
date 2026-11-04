import { Matches } from 'class-validator';

/** Ghana-style numbers as people type them: 0244111222, +233244111222, 024 411 1222. */
const PHONE_PATTERN = /^\+?[0-9][0-9 ]{8,15}$/;

/** Validates a phone number field; the error names the field. */
export function IsPhone(): PropertyDecorator {
  return Matches(PHONE_PATTERN, {
    message: ({ property }) => `${property} must be a phone number, e.g. 0244111222 or +233244111222`,
  });
}
