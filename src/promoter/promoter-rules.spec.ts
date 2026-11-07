import { describe, expect, it } from 'vitest';
import { cleanFullName, CODE_LENGTH, newCode, parsePromoterCommand, PROMOTER_IDS, referralMessage, shareText } from './promoter-rules.js';

describe('parsePromoterCommand', () => {
  it.each([
    ['I want to promote', { kind: 'promote' }],
    [PROMOTER_IDS.START, { kind: 'promote' }],
    ['join k7q2mx', { kind: 'join', code: 'K7Q2MX' }],
    ['JOIN K7Q2MX', { kind: 'join', code: 'K7Q2MX' }],
    ['shops', { kind: 'shops', page: 0 }],
    [`${PROMOTER_IDS.SHOPS_PAGE}2`, { kind: 'shops', page: 2 }],
    [`${PROMOTER_IDS.SHOPS_PAGE}x`, { kind: 'shops', page: 0 }],
    [`${PROMOTER_IDS.REQUEST}tenant-1`, { kind: 'request', tenantId: 'tenant-1' }],
    ['My links', { kind: 'links' }],
    [' help ', { kind: 'help' }],
    ['I agree', { kind: 'agree' }],
    [PROMOTER_IDS.MOMO_YES, { kind: 'yes' }],
    ['no', { kind: 'no' }],
    ['Ama Mensah', { kind: 'text' }],
    ['0244111222', { kind: 'text' }],
  ])('%s', (text, expected) => {
    expect(parsePromoterCommand(text)).toEqual(expected);
  });

  it('does not read a longer word as a join code', () => {
    expect(parsePromoterCommand('JOIN K7Q2MXZ')).toEqual({ kind: 'text' });
  });
});

describe('cleanFullName', () => {
  it('tidies spaces and accepts names with hyphens and apostrophes', () => {
    expect(cleanFullName('  Ama   Owusu-Mensah ')).toBe('Ama Owusu-Mensah');
    expect(cleanFullName("Kofi O'Neil")).toBe("Kofi O'Neil");
  });

  it('rejects numbers, symbols and very short text', () => {
    expect(cleanFullName('0244111222')).toBeNull();
    expect(cleanFullName('Al')).toBeNull();
    expect(cleanFullName('👍')).toBeNull();
  });
});

describe('codes and share text', () => {
  it('makes codes without look-alike characters', () => {
    for (let i = 0; i < 200; i++) expect(newCode()).toMatch(new RegExp(`^[A-HJKMNP-Z2-9]{${CODE_LENGTH}}$`));
  });

  it('links to the shop with the code in the first message', () => {
    const text = shareText({ code: 'K7Q2MX', shopName: "Auntie Esi's", market: 'Madina', shopNumber: '+233 20 000 0001' });
    expect(text).toContain("*Auntie Esi's* in Madina");
    expect(text).toContain(`https://wa.me/233200000001?text=${encodeURIComponent(referralMessage('K7Q2MX'))}`);
  });

  it('names the product on a product link', () => {
    const text = shareText({ code: 'K7Q2MX', shopName: "Auntie Esi's", shopNumber: '0200000001', productName: 'Rice' });
    expect(text).toContain("*Rice* from *Auntie Esi's*");
    expect(decodeURIComponent(text)).toContain("I'd like to order Rice (ref K7Q2MX)");
  });
});
