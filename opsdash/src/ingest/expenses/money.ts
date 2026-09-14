/**
 * Money parsing for the "$ used" column. Values are `$693.44`, `$1,647.50`,
 * or (an EFS reversal/refund) `\-$80.52` with a markdown-escaped minus.
 * Everything here is string/integer manipulation — never a float — because
 * this feeds `StagingRow.amount`, which the wire contract requires as a
 * decimal string.
 */

interface NormalizedMoneyLiteral {
  negative: boolean;
  intPart: string;
  fracPart: string;
}

function normalizeMoneyLiteral(raw: string): NormalizedMoneyLiteral | null {
  // `unescapeMarkdown` (table.ts) already turned `\-` into `-` by the time
  // this runs, but strip any stray backslash defensively.
  const cleaned = raw.replace(/\\/g, '').replace(/\$/g, '').replace(/,/g, '').trim();
  const m = /^(-)?(\d{1,12})(?:\.(\d{1,4}))?$/.exec(cleaned);
  if (!m) return null;
  const intPart = m[2] as string;
  const fracPart = (m[3] ?? '').padEnd(2, '0');
  return { negative: m[1] === '-', intPart, fracPart };
}

export interface ParsedCostAmount {
  /**
   * Signed decimal string, ledger convention (positive = inflow, negative =
   * outflow): the literal source value negated, since "$ used" records a
   * cost. A source row already written as negative (an EFS reversal) comes
   * back out positive, i.e. it reduces the cost rather than adding to it.
   */
  amount: string | null;
  raw: string;
  hasDollarSign: boolean;
}

export function parseExpenseAmount(raw: string): ParsedCostAmount {
  const hasDollarSign = raw.includes('$');
  const parsed = normalizeMoneyLiteral(raw);
  if (!parsed) return { amount: null, raw, hasDollarSign };
  const sign = parsed.negative ? '' : '-';
  return { amount: `${sign}${parsed.intPart}.${parsed.fracPart}`, raw, hasDollarSign };
}
