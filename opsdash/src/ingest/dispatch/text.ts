/**
 * Low-level text helpers for the dispatch-sheet parser.
 *
 * The source document is a markdown-table dump of the live Google Sheet
 * (see /home/user/opsdash-fixtures/dispatch2026.txt). Markdown escapes
 * `#`, `[`, `]` and `!` with a leading backslash; every cell also carries
 * incidental whitespace from the spreadsheet export. Nothing here mutates
 * *values* — it only strips the markdown/whitespace noise so the real
 * content underneath can be read.
 */

/** Reverses markdown's backslash-escaping of `# [ ] !`. */
export function unescapeMarkdown(raw: string): string {
  return raw.replace(/\\([#[\]!])/g, '$1');
}

/** Trim + unescape. The baseline cleaning step for every cell. */
export function cleanCell(raw: string): string {
  return unescapeMarkdown(raw).trim();
}

/** Splits one markdown table row into its raw (uncleaned) cells. */
export function splitRow(line: string): string[] {
  return line.replace(/\r?\n$/, '').split('|');
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DATE_HEADER_RE = /^[A-Za-z]+,\s*([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})$/;

/**
 * Parses a day-group header cell like "Mon, May 4, 2026" into an ISO date.
 * Returns null for blank cells or anything that doesn't match — callers
 * carry the previous value forward rather than treating null as "no date
 * ever", because the header repeats per dispatcher group and only the
 * first occurrence in a week carries the date text (§ SOURCE-DISCOVERY.md).
 */
export function parseDateHeaderCell(raw: string): string | null {
  const s = cleanCell(raw);
  if (!s) return null;
  const m = DATE_HEADER_RE.exec(s);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const monthKey = m[1].slice(0, 3).toLowerCase();
  const month = MONTHS[monthKey];
  if (!month) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const DECIMAL_BODY_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parses a money/quantity cell that may carry `$`, thousands commas, a
 * stray leading space inside the `$` (`"$ 2,346"`), or — for the miles
 * column specifically — a `$` that doesn't belong there at all
 * (`"$775.00"` meaning 775 miles, not $775). The caller decides how many
 * decimal places the destination field wants; this function only reads
 * the numeric value, exactly as written, and never touches sign.
 *
 * Returns null for blank cells and for anything that isn't a plain
 * (optionally signed, optionally decimal) number once `$`/`,`/whitespace
 * are stripped — e.g. `#DIV/0!`, `#VALUE!`, free text like "transit".
 */
export function parseNumericCell(raw: string): { intPart: string; fracPart: string; negative: boolean } | null {
  const cleaned = cleanCell(raw).replace(/\$/g, '').replace(/,/g, '').trim();
  if (cleaned === '') return null;
  const m = DECIMAL_BODY_RE.exec(cleaned);
  if (!m || !m[2]) return null;
  return { negative: m[1] === '-', intPart: m[2], fracPart: m[3] ?? '' };
}

/** Formats a parsed numeric cell as a money decimal string, e.g. "2400.00". */
export function toMoneyDecimalString(parsed: { intPart: string; fracPart: string; negative: boolean }): string {
  const frac = (parsed.fracPart + '00').slice(0, 2);
  const sign = parsed.negative && !/^0+$/.test(parsed.intPart + parsed.fracPart) ? '-' : '';
  return `${sign}${parsed.intPart}.${frac}`;
}

/**
 * Formats a parsed numeric cell as a quantity decimal string. Miles in
 * this sheet are always whole numbers; an all-zero fraction is dropped
 * so "775.00" becomes "775" rather than manufacturing false precision.
 */
export function toQuantityDecimalString(parsed: { intPart: string; fracPart: string; negative: boolean }): string {
  const sign = parsed.negative && !/^0+$/.test(parsed.intPart + parsed.fracPart) ? '-' : '';
  const frac = parsed.fracPart.slice(0, 4).replace(/0+$/, '');
  return frac ? `${sign}${parsed.intPart}.${frac}` : `${sign}${parsed.intPart}`;
}
