/**
 * Gallons and price parsing for the Fuel sheet. Every numeric conversion
 * here is exact integer/BigInt arithmetic — never a float — because the
 * result feeds `StagingRow.quantity`/`amount`, which cross the wire as
 * decimal strings.
 */

export interface ParsedGallons {
  /** Decimal string, or null when the sheet recorded no number at all
   *  (most commonly the literal string "full tank"/"full"). Never 0 —
   *  0 would silently claim "no fuel purchased", which is a different
   *  fact than "we don't know how much". */
  quantity: string | null;
  raw: string;
  isNumeric: boolean;
}

export function parseGallons(raw: string): ParsedGallons {
  const cleaned = raw.trim().replace(/,/g, '');
  if (!cleaned) return { quantity: null, raw, isNumeric: false };
  const m = /^(\d{1,10})(?:\.(\d{1,4}))?$/.exec(cleaned);
  if (!m) return { quantity: null, raw, isNumeric: false };
  const intPart = m[1] as string;
  const fracPart = (m[2] ?? '').padEnd(2, '0');
  return { quantity: `${intPart}.${fracPart}`, raw, isNumeric: true };
}

/** `Price` is written with a *suffix* dollar sign (`3.56$`) in most
 *  sections, but a handful use the ordinary prefix (`$6.10`). Handle both,
 *  never assume the sign's position. */
export function parsePricePerGallon(raw: string): string | null {
  const cleaned = raw.trim().replace(/\$/g, '').replace(/,/g, '');
  if (!cleaned) return null;
  const m = /^(\d{1,6})(?:\.(\d{1,5}))?$/.exec(cleaned);
  if (!m) return null;
  const intPart = m[1] as string;
  const fracPart = (m[2] ?? '').padEnd(2, '0');
  return `${intPart}.${fracPart}`;
}

function toBigIntScaled(value: string, scale: number): bigint {
  const negative = value.startsWith('-');
  const abs = negative ? value.slice(1) : value;
  const [intPart = '0', fracPart = ''] = abs.split('.');
  const fracPadded = (fracPart + '0'.repeat(scale)).slice(0, scale);
  const n = BigInt(`${intPart}${fracPadded}`);
  return negative ? -n : n;
}

/**
 * Exact `quantity * pricePerGallon`, rounded half-up to cents, as a decimal
 * string. Implemented with BigInt fixed-point arithmetic specifically so no
 * float ever touches a dollar figure.
 */
export function computeFuelCost(quantityDecimal: string, pricePerGallonDecimal: string): string {
  const scale = 4;
  const qInt = toBigIntScaled(quantityDecimal, scale);
  const pInt = toBigIntScaled(pricePerGallonDecimal, scale);
  const productInt = qInt * pInt; // scaled by 10^(2*scale)
  const divisor = 10n ** BigInt(2 * scale - 2); // reduce to cents (10^2)
  const half = divisor / 2n;
  const roundedCents = productInt >= 0n ? (productInt + half) / divisor : -((-productInt + half) / divisor);
  const negative = roundedCents < 0n;
  const abs = negative ? -roundedCents : roundedCents;
  const digits = abs.toString().padStart(3, '0');
  const intPart = digits.slice(0, -2);
  const fracPart = digits.slice(-2);
  return `${negative && abs !== 0n ? '-' : ''}${intPart}.${fracPart}`;
}
