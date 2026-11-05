import { describe, expect, it } from 'vitest';
import { nextAccraMidnight, startOfAccraDay } from './withdrawal-day.js';

const at = (iso: string) => new Date(iso);

describe('withdrawal day (Accra = UTC)', () => {
  it.each([
    ['just after midnight', '2026-11-05T00:00:01Z', '2026-11-05T00:00:00.000Z', '2026-11-06T00:00:00.000Z'],
    ['late evening', '2026-11-05T23:59:59Z', '2026-11-05T00:00:00.000Z', '2026-11-06T00:00:00.000Z'],
    ['end of month', '2026-11-30T12:00:00Z', '2026-11-30T00:00:00.000Z', '2026-12-01T00:00:00.000Z'],
    ['end of year', '2026-12-31T18:00:00Z', '2026-12-31T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
  ])('%s', (_label, now, start, next) => {
    expect(startOfAccraDay(at(now)).toISOString()).toBe(start);
    expect(nextAccraMidnight(at(now)).toISOString()).toBe(next);
  });
});
