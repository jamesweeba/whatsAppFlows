import { Prisma } from '@prisma/client';
import { parseVendorRef } from '../tenant/vendor-ref.js';
import { DateRange } from './period.util.js';

/** Searches with fewer digits than this do not match phone columns (too many false hits). */
const MIN_PHONE_SEARCH_DIGITS = 3;

/** `%term%` for ILIKE, with the user's own % and _ matched literally. */
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Digits of a typed phone with any leading 233 or 0 removed: 0244…, +233 24… and 244… compare equal. */
function phoneDigits(value: string): string {
  return value.replace(/\D/g, '').replace(/^(233|0)/, '');
}

/** The same normalisation in SQL, for a phone column stored however it was typed. */
function phoneDigitsSql(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`regexp_replace(regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g'), '^(233|0)', '')`;
}

/**
 * One search box over several columns: `text` columns match anywhere (any case), `phones`
 * match in any format, and `ref` matches an MX-V shop ref exactly. Null when there is no term.
 */
export function searchSql(
  search: string | undefined,
  columns: { text: Prisma.Sql[]; phones?: Prisma.Sql[]; ref?: Prisma.Sql },
): Prisma.Sql | null {
  const term = search?.trim();
  if (!term) return null;

  const like = likeContains(term);
  const matches = columns.text.map((column) => Prisma.sql`${column} ILIKE ${like}`);
  const digits = phoneDigits(term);
  if (digits.length >= MIN_PHONE_SEARCH_DIGITS) {
    for (const column of columns.phones ?? []) {
      matches.push(Prisma.sql`${phoneDigitsSql(column)} LIKE ${`%${digits}%`}`);
    }
  }
  const ref = parseVendorRef(term);
  if (columns.ref && ref !== null) {
    matches.push(Prisma.sql`${columns.ref} = ${ref}`);
  }
  return Prisma.sql`(${Prisma.join(matches, ' OR ')})`;
}

/** `column` within the range: `from` inclusive, `to` exclusive. */
export function rangeSql(column: Prisma.Sql, range: DateRange): Prisma.Sql[] {
  return [
    ...(range.from ? [Prisma.sql`${column} >= ${range.from}`] : []),
    ...(range.to ? [Prisma.sql`${column} < ${range.to}`] : []),
  ];
}

/** AND the conditions together; TRUE when there are none. */
export function whereSql(conditions: (Prisma.Sql | null)[]): Prisma.Sql {
  const present = conditions.filter((c): c is Prisma.Sql => c !== null);
  return present.length ? Prisma.join(present, ' AND ') : Prisma.sql`TRUE`;
}
