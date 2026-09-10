/**
 * VIN structural validation — the concrete recovery mechanism behind
 * SOURCE-DISCOVERY.md §14 and §11b.
 *
 * Two independent facts make a VIN self-checking:
 *
 *  1. `I`, `O` and `Q` never appear in a real VIN (they are excluded
 *     precisely because they are easily confused with `1`, `0`, `Q`/`0`).
 *     Their presence anywhere in a 17-character candidate is proof of a
 *     misread, not a suspicion.
 *  2. Position 9 (index 8) is a check digit computed from the other sixteen
 *     characters via the standard ISO 3779 transliteration/weighting
 *     scheme. Every real VIN validates against it, so a mismatch always
 *     means *something* in the 17 characters is wrong.
 *
 * Those two facts combine into three outcomes, not two:
 *  - clean: check digit matches, nothing illegal — trust it.
 *  - recoverable: position 9 itself is provably corrupted (illegal char, or
 *    not even in the check-digit alphabet {0-9,X}) *and* the other sixteen
 *    characters contain no illegal character, so recomputing position 9
 *    from them is safe and exact — not a guess.
 *  - merely detected: the check digit doesn't match, but the corruption
 *    could be anywhere in the 17 characters (including position 9 itself,
 *    ambiguously). Correcting a single character here would be a guess
 *    dressed up as a fact, so this is flagged and left alone. That is the
 *    whole design point of §14: a field that is *known* doubtful gets human
 *    attention; a field that is quietly wrong does not.
 */

const VIN_TRANSLITERATION: Readonly<Record<string, number>> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};

// Position weights 1..17 (index 0..16). Position 9 (index 8) carries weight
// 0 because it IS the check digit — it contributes nothing to its own sum.
const VIN_WEIGHTS: readonly number[] = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

const CHECK_DIGIT_POSITION = 8; // 0-indexed position 9
const VIN_LENGTH = 17;
const ILLEGAL_VIN_LETTERS = new Set(['I', 'O', 'Q']);
const CHECK_DIGIT_ALPHABET = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'X']);

/** `I`, `O`, `Q` at any position — the unconditional tell. */
export function findIllegalVinChars(vin: string): Array<{ index: number; char: string }> {
  const found: Array<{ index: number; char: string }> = [];
  for (let i = 0; i < vin.length; i++) {
    const ch = vin[i];
    if (ch !== undefined && ILLEGAL_VIN_LETTERS.has(ch)) found.push({ index: i, char: ch });
  }
  return found;
}

/**
 * Computes the ISO 3779 check digit for a 17-character VIN, ignoring
 * whatever currently sits at position 9. Returns `null` if any of the other
 * sixteen characters cannot be transliterated (not alphanumeric, or one of
 * the illegal letters) — in that case the check digit cannot be trusted to
 * mean anything, because the sum it would be computed from is already
 * corrupted.
 */
export function computeVinCheckDigit(vin: string): string | null {
  if (vin.length !== VIN_LENGTH) return null;
  let sum = 0;
  for (let i = 0; i < VIN_LENGTH; i++) {
    if (i === CHECK_DIGIT_POSITION) continue;
    const ch = vin[i];
    if (ch === undefined) return null;
    let value: number;
    if (ch >= '0' && ch <= '9') {
      value = ch.charCodeAt(0) - 48;
    } else {
      const t = VIN_TRANSLITERATION[ch];
      if (t === undefined) return null; // I/O/Q or non-alphanumeric
      value = t;
    }
    sum += value * (VIN_WEIGHTS[i] ?? 0);
  }
  const remainder = sum % 11;
  return remainder === 10 ? 'X' : String(remainder);
}

export interface VinValidation {
  /** The value to use going forward: identical to input unless `corrected`. */
  value: string;
  original: string;
  /** True only when the check digit matches (after any correction). A VIN
   *  that fails structural validation is never "valid" even if it looks
   *  plausible otherwise. */
  valid: boolean;
  /** True when position 9 was recomputed and replaced. */
  corrected: boolean;
  illegalChars: Array<{ index: number; char: string }>;
  confidence: number;
  needsReview: boolean;
  reason: string | null;
}

function result(partial: Omit<VinValidation, 'original'>, original: string): VinValidation {
  return { ...partial, original };
}

export function validateVin(raw: string): VinValidation {
  const original = raw;
  const vin = raw.trim().toUpperCase();

  if (vin.length !== VIN_LENGTH) {
    return result(
      {
        value: vin,
        valid: false,
        corrected: false,
        illegalChars: findIllegalVinChars(vin),
        confidence: 0,
        needsReview: true,
        reason: `"${raw}" is ${vin.length} characters, not 17 — not a VIN candidate.`,
      },
      original,
    );
  }

  const illegalChars = findIllegalVinChars(vin);
  const illegalElsewhere = illegalChars.filter((c) => c.index !== CHECK_DIGIT_POSITION);

  if (illegalElsewhere.length > 0) {
    // An I/O/Q outside position 9 corrupts the transliteration sum itself —
    // the check digit cannot be trusted to point at any single character,
    // so this is detected but not corrected.
    const where = illegalElsewhere.map((c) => `'${c.char}' at position ${c.index + 1}`).join(', ');
    return result(
      {
        value: vin,
        valid: false,
        corrected: false,
        illegalChars,
        confidence: 0.05,
        needsReview: true,
        reason: `contains illegal VIN character(s) ${where} (I/O/Q never appear in a real VIN); cannot verify or correct.`,
      },
      original,
    );
  }

  const expected = computeVinCheckDigit(vin);
  if (expected === null) {
    // Should not happen once illegalElsewhere is empty, but stay honest if
    // it somehow does (e.g. a non-alphanumeric character).
    return result(
      {
        value: vin,
        valid: false,
        corrected: false,
        illegalChars,
        confidence: 0.05,
        needsReview: true,
        reason: 'contains a character outside the VIN alphabet; cannot compute a check digit.',
      },
      original,
    );
  }

  const actual = vin[CHECK_DIGIT_POSITION] ?? '';
  if (actual === expected) {
    return result(
      { value: vin, valid: true, corrected: false, illegalChars: [], confidence: 0.98, needsReview: false, reason: null },
      original,
    );
  }

  const positionNineIsUnrecoverable = !CHECK_DIGIT_ALPHABET.has(actual);
  if (positionNineIsUnrecoverable) {
    // Position 9 provably cannot be right (it isn't even a digit or 'X'),
    // and every other character passed the illegal-char and transliteration
    // checks above — so position 9 is exactly where the corruption is, and
    // recomputing it is exact, not a guess (SOURCE-DISCOVERY.md §14).
    const corrected = vin.slice(0, CHECK_DIGIT_POSITION) + expected + vin.slice(CHECK_DIGIT_POSITION + 1);
    return result(
      {
        value: corrected,
        valid: true,
        corrected: true,
        illegalChars,
        confidence: 0.85,
        needsReview: true,
        reason: `position 9 read as '${actual}', which is not a valid check digit; recomputed from the other 16 characters as '${expected}' and replaced.`,
      },
      original,
    );
  }

  // Position 9 IS a plausible check-digit character, just not the one the
  // other 16 characters predict. The error could genuinely be at position 9
  // (a mistyped check digit) or could be a misread anywhere else in the
  // VIN that happens to still produce a legal-looking position 9 — those
  // are indistinguishable from here, so this is flagged, not corrected.
  return result(
    {
      value: vin,
      valid: false,
      corrected: false,
      illegalChars,
      confidence: 0.2,
      needsReview: true,
      reason: `check digit mismatch: position 9 is '${actual}', expected '${expected}' from the other 16 characters. The error's location is ambiguous, so nothing was changed.`,
    },
    original,
  );
}
