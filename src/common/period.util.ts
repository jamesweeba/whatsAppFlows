import { BadRequestException } from '@nestjs/common';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Preset periods. Ghana is on UTC all year, so "today" starts at UTC midnight. */
export const PERIODS = ['today', '7d', '30d', '90d', 'all'] as const;
export type Period = (typeof PERIODS)[number];

/** A time window: `from` inclusive, `to` exclusive. Either end may be open. */
export interface DateRange {
  from?: Date;
  to?: Date;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value: string, name: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  // The round trip rejects dates JavaScript would roll over, e.g. 2026-02-30 -> 2 March.
  if (!DATE_PATTERN.test(value) || isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${name} must be a date like 2026-11-04.`);
  }
  return date;
}

/**
 * `?period=7d`, or a custom `?from=2026-10-01&to=2026-10-31` (whole days, both inclusive),
 * which wins over `period`. Defaults to the last 30 days.
 */
export function parsePeriod(period?: string, from?: string, to?: string, now = new Date()): DateRange {
  if (from?.trim() || to?.trim()) {
    const range: DateRange = {
      ...(from?.trim() && { from: parseDay(from.trim(), 'from') }),
      ...(to?.trim() && { to: new Date(parseDay(to.trim(), 'to').getTime() + DAY_MS) }),
    };
    if (range.from && range.to && range.from >= range.to) {
      throw new BadRequestException('from must be on or before to.');
    }
    return range;
  }

  const preset = (period?.trim().toLowerCase() || '30d') as Period;
  switch (preset) {
    case 'today':
      return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) };
    case '7d':
    case '30d':
    case '90d':
      return { from: new Date(now.getTime() - parseInt(preset, 10) * DAY_MS) };
    case 'all':
      return {};
    default:
      throw new BadRequestException(`Unknown period ${period}. Use: ${PERIODS.join(', ')}, or from/to dates.`);
  }
}
