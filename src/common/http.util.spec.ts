import { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { contentDisposition } from './http.util.js';

describe('contentDisposition', () => {
  it('keeps plain names as they are', () => {
    expect(contentDisposition('card.jpg')).toBe(`inline; filename="card.jpg"; filename*=UTF-8''card.jpg`);
  });

  it.each(['Ghana card ɛ.jpg', 'IMG_📷.jpg', 'my "card" (1).jpg', 'back\\slash.pdf'])(
    'produces a header Node accepts for %s, with the real name in filename*',
    (name) => {
      const header = contentDisposition(name, 'attachment');
      expect(() => new ServerResponse({ method: 'GET' } as any).setHeader('Content-Disposition', header)).not.toThrow();
      const encoded = header.split("filename*=UTF-8''")[1];
      expect(decodeURIComponent(encoded)).toBe(name);
      expect(header).toMatch(/^attachment; filename="[\x20-\x7e]+"; /);
    },
  );
});
