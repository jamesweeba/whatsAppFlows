import { randomInt } from 'node:crypto';
import { toInternationalDigits } from '../common/phone.util.js';

/** Commission rates vendors can set, whole percent. */
export const PROMOTER_RATE_MIN = 1;
export const PROMOTER_RATE_MAX = 20;
/** A buyer's first order counts for the promoter if placed within this many days of tapping the link. */
export const REFERRAL_DAYS = 14;
/** Commission is withdrawable this many days after delivery. */
export const COMMISSION_HOLD_DAYS = 7;

/** No 0/O, 1/I/L: codes are read and typed by people. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

/**
 * A random link or invite code, e.g. K7Q2MX. 31^6 ≈ 887 million codes, so a clash is
 * left to the unique index rather than retried.
 */
export function newCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Reply-button and list-row ids the bot sends; WhatsApp echoes them back as the message text. */
export const PROMOTER_IDS = {
  START: 'promoter:start',
  MOMO_YES: 'promoter:momo_yes',
  MOMO_NO: 'promoter:momo_no',
  AGREE: 'promoter:agree',
  SHOPS: 'promoter:shops',
  LINKS: 'promoter:links',
  /** + page number, e.g. promoter:shops:1 */
  SHOPS_PAGE: 'promoter:shops:',
  /** + tenant id */
  REQUEST: 'promoter:request:',
} as const;

export type PromoterCommand =
  | { kind: 'promote' }
  | { kind: 'join'; code: string }
  | { kind: 'shops'; page: number }
  | { kind: 'request'; tenantId: string }
  | { kind: 'links' }
  | { kind: 'help' }
  | { kind: 'yes' }
  | { kind: 'no' }
  | { kind: 'agree' }
  /** Anything else: a name or MoMo number during sign-up, otherwise unknown. */
  | { kind: 'text' };

/** What a message to the platform number asks for. Buttons arrive as their ids. */
export function parsePromoterCommand(raw: string): PromoterCommand {
  const text = (raw ?? '').trim();
  switch (text) {
    case PROMOTER_IDS.START:
      return { kind: 'promote' };
    case PROMOTER_IDS.MOMO_YES:
      return { kind: 'yes' };
    case PROMOTER_IDS.MOMO_NO:
      return { kind: 'no' };
    case PROMOTER_IDS.AGREE:
      return { kind: 'agree' };
    case PROMOTER_IDS.SHOPS:
      return { kind: 'shops', page: 0 };
    case PROMOTER_IDS.LINKS:
      return { kind: 'links' };
  }
  if (text.startsWith(PROMOTER_IDS.REQUEST)) return { kind: 'request', tenantId: text.slice(PROMOTER_IDS.REQUEST.length) };
  if (text.startsWith(PROMOTER_IDS.SHOPS_PAGE)) {
    const page = Number.parseInt(text.slice(PROMOTER_IDS.SHOPS_PAGE.length), 10);
    return { kind: 'shops', page: Number.isFinite(page) && page > 0 ? page : 0 };
  }

  const upper = text.toUpperCase().replace(/\s+/g, ' ');
  const join = new RegExp(`^JOIN ?([A-Z0-9]{${CODE_LENGTH}})$`).exec(upper);
  if (join) return { kind: 'join', code: join[1] };
  if (/^(FIND )?SHOPS?$/.test(upper)) return { kind: 'shops', page: 0 };
  if (/^(MY )?LINKS?$/.test(upper)) return { kind: 'links' };
  if (/^(HELP|MENU)$/.test(upper)) return { kind: 'help' };
  if (/^(I )?AGREE$/.test(upper)) return { kind: 'agree' };
  if (/^(YES|Y|YEAH|OK)$/.test(upper)) return { kind: 'yes' };
  if (/^(NO|N)$/.test(upper)) return { kind: 'no' };
  if (/\bPROMOT(E|ER|ING)\b/.test(upper)) return { kind: 'promote' };
  return { kind: 'text' };
}

/** A full name as typed, tidied, or null if it doesn't look like one. */
export function cleanFullName(raw: string): string | null {
  const name = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 3 || name.length > 60) return null;
  return /^\p{L}[\p{L} .'-]*$/u.test(name) ? name : null;
}

/** The first message a buyer sends from a promoter's link. ChatService reads the code back out of it. */
export function referralMessage(code: string, productName?: string | null): string {
  return productName ? `Hi! I'd like to order ${productName} (ref ${code})` : `Hi! I'd like to order (ref ${code})`;
}

/** The ready-to-forward message for one link. */
export function shareText(link: { code: string; shopName: string; market?: string | null; shopNumber: string; productName?: string | null }): string {
  const url = `https://wa.me/${toInternationalDigits(link.shopNumber)}?text=${encodeURIComponent(referralMessage(link.code, link.productName))}`;
  const where = link.market ? ` in ${link.market}` : '';
  const headline = link.productName
    ? `🛒 *${link.productName}* from *${link.shopName}*${where}`
    : `🛒 *${link.shopName}*${where}\nFresh from the market, delivered to you.`;
  return `${headline}\nOrder on WhatsApp and pay with MoMo 👇\n${url}`;
}
