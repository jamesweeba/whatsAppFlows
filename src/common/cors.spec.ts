import { describe, expect, it } from 'vitest';
import { corsOptions } from './cors.js';

describe('corsOptions', () => {
  it('allows only local origins when CORS_ORIGINS is unset', () => {
    const origin = corsOptions('').origin as RegExp;
    expect(origin.test('http://localhost:5173')).toBe(true);
    expect(origin.test('http://127.0.0.1:3001')).toBe(true);
    expect(origin.test('https://evil.example')).toBe(false);
    expect(origin.test('http://localhost.evil.example')).toBe(false);
  });

  it('uses the configured list, ignoring spaces and trailing slashes', () => {
    expect(corsOptions(' https://vendor.marketix.app/ , https://admin.marketix.app ').origin).toEqual([
      'https://vendor.marketix.app',
      'https://admin.marketix.app',
    ]);
  });

  it('exposes the download file name header and keeps credentials off', () => {
    const options = corsOptions('');
    expect(options.exposedHeaders).toEqual(['Content-Disposition']);
    expect(options.credentials).toBeUndefined();
  });
});
