import { BadRequestException } from '@nestjs/common';

/**
 * Parse a comma-separated query parameter of enum values, case-insensitively,
 * e.g. `?status=stocked,UNDER_REVIEW`. Returns undefined when the parameter is absent.
 */
export function parseEnumList<T extends string>(raw: string | undefined, values: Record<string, T>, name = 'status'): T[] | undefined {
  if (!raw?.trim()) return undefined;
  const allowed = Object.values(values);
  const parsed = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const unknown = parsed.filter((s) => !allowed.includes(s as T));
  if (unknown.length) {
    throw new BadRequestException(`Unknown ${name} ${unknown.join(', ')}. Use: ${allowed.join(', ')}.`);
  }
  return parsed as T[];
}

/**
 * Parse a single-choice query parameter (`?tab=`, `?sort=`) case-insensitively, so a typo
 * is a 400 rather than an empty page. Returns undefined when the parameter is absent.
 */
export function parseChoice<T extends string>(raw: string | undefined, choices: readonly T[], name: string): T | undefined {
  if (!raw?.trim()) return undefined;
  const value = raw.trim().toLowerCase() as T;
  if (!choices.includes(value)) {
    throw new BadRequestException(`Unknown ${name} ${raw}. Use: ${choices.join(', ')}.`);
  }
  return value;
}
