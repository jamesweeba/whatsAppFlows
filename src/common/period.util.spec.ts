import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { parsePeriod } from './period.util.js';

const now = new Date('2026-11-04T07:30:00.000Z');

describe('parsePeriod', () => {
  it('defaults to the last 30 days and understands the presets', () => {
    expect(parsePeriod(undefined, undefined, undefined, now)).toEqual({ from: new Date('2026-10-05T07:30:00.000Z') });
    expect(parsePeriod('today', undefined, undefined, now)).toEqual({ from: new Date('2026-11-04T00:00:00.000Z') });
    expect(parsePeriod('7D', undefined, undefined, now)).toEqual({ from: new Date('2026-10-28T07:30:00.000Z') });
    expect(parsePeriod('all', undefined, undefined, now)).toEqual({});
  });

  it('takes a custom range of whole days, both inclusive, over the preset', () => {
    expect(parsePeriod('7d', '2026-10-01', '2026-10-31', now)).toEqual({
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(parsePeriod(undefined, undefined, '2026-10-31', now)).toEqual({ to: new Date('2026-11-01T00:00:00.000Z') });
    expect(parsePeriod(undefined, '2026-10-31', '2026-10-31', now).from).toEqual(new Date('2026-10-31T00:00:00.000Z'));
  });

  it('rejects unknown presets, bad dates and reversed ranges', () => {
    expect(() => parsePeriod('week')).toThrow('Unknown period week');
    expect(() => parsePeriod(undefined, '31/10/2026')).toThrow('from must be a date like 2026-11-04');
    expect(() => parsePeriod(undefined, '2026-02-30')).toThrow(BadRequestException);
    expect(() => parsePeriod(undefined, '2026-11-02', '2026-11-01')).toThrow('from must be on or before to');
  });
});
