import { describe, expect, it } from 'vitest';
import { computeVinCheckDigit, findIllegalVinChars, validateVin } from '@/ingest/extract/vin';

// Two well-known public example VINs (Wikipedia / NHTSA VIN check-digit
// worked examples), used only to pin the check-digit algorithm itself —
// deliberately NOT drawn from the real fleet document, so the real VINs stay
// only in the round-trip/OCR tests that need them.
const HONDA_EXAMPLE = '1HGCM82633A004352'; // check digit '3'
const CHECK_DIGIT_X_EXAMPLE = '1M8GDM9AXKP042788'; // check digit 'X'

describe('computeVinCheckDigit', () => {
  it('matches the known check digit for a public worked example', () => {
    expect(computeVinCheckDigit(HONDA_EXAMPLE)).toBe('3');
  });

  it('produces X for the worked example whose check digit is X', () => {
    expect(computeVinCheckDigit(CHECK_DIGIT_X_EXAMPLE)).toBe('X');
  });

  it('returns null when a non-position-9 character is illegal (I/O/Q)', () => {
    const corrupted = 'IHGCM82633A004352'; // position 1 corrupted to 'I'
    expect(computeVinCheckDigit(corrupted)).toBeNull();
  });

  it('returns null for the wrong length', () => {
    expect(computeVinCheckDigit('TOOSHORT')).toBeNull();
  });
});

describe('findIllegalVinChars', () => {
  it('flags I, O and Q wherever they appear', () => {
    const found = findIllegalVinChars('1O8GDMQAXKP04I788');
    const chars = found.map((f) => f.char).sort();
    expect(chars).toEqual(['I', 'O', 'Q']);
  });

  it('finds nothing in a clean VIN', () => {
    expect(findIllegalVinChars(HONDA_EXAMPLE)).toEqual([]);
  });
});

describe('validateVin', () => {
  it('accepts a clean VIN with high confidence and no review flag', () => {
    const v = validateVin(HONDA_EXAMPLE);
    expect(v.valid).toBe(true);
    expect(v.corrected).toBe(false);
    expect(v.needsReview).toBe(false);
    expect(v.value).toBe(HONDA_EXAMPLE);
    expect(v.confidence).toBeGreaterThan(0.9);
  });

  it('recovers the true VIN when only position 9 was misread to an illegal letter — the exact §14 OCR case', () => {
    // Real, documented OCR failure: SOURCE-DISCOVERY.md §14 — OCR read
    // "3AKJHHDRINSMY1471" where the truth is "3AKJHHDR9NSMY1471".
    const ocrGarbled = '3AKJHHDRINSMY1471';
    const truth = '3AKJHHDR9NSMY1471';
    const v = validateVin(ocrGarbled);
    expect(v.corrected).toBe(true);
    expect(v.valid).toBe(true);
    expect(v.value).toBe(truth);
    expect(v.needsReview).toBe(true); // recovered, but still surfaced for a human glance
  });

  it('recovers position 9 when OCR read "O" instead of "0"', () => {
    const ocrGarbled = '3AKJHHDRONSMY1682';
    const truth = '3AKJHHDR0NSMY1682';
    const v = validateVin(ocrGarbled);
    expect(v.corrected).toBe(true);
    expect(v.value).toBe(truth);
  });

  it('flags — but does NOT correct — a check-digit mismatch when position 9 looks legal but is simply wrong', () => {
    // Position 9 replaced with a plausible-but-wrong digit. The corruption
    // could genuinely be at position 9, or could be a misread anywhere else
    // in the other 16 characters that happens to leave a legal-looking
    // position 9 — those are indistinguishable, so this must never be
    // silently "corrected" into a guess.
    const wrongDigit = HONDA_EXAMPLE.slice(0, 8) + '7' + HONDA_EXAMPLE.slice(9); // true check digit is '3'
    const v = validateVin(wrongDigit);
    expect(v.valid).toBe(false);
    expect(v.corrected).toBe(false);
    expect(v.needsReview).toBe(true);
    expect(v.value).toBe(wrongDigit); // untouched — not silently dropped, not guessed at
    expect(v.reason).toMatch(/ambiguous/i);
  });

  it('flags an illegal character elsewhere in the VIN as unverifiable, not silently accepted', () => {
    const corrupted = HONDA_EXAMPLE.slice(0, 2) + 'O' + HONDA_EXAMPLE.slice(3); // position 3 -> 'O'
    const v = validateVin(corrupted);
    expect(v.valid).toBe(false);
    expect(v.needsReview).toBe(true);
    expect(v.illegalChars.length).toBeGreaterThan(0);
    expect(v.corrected).toBe(false);
  });

  it('flags the wrong length rather than truncating or padding', () => {
    const v = validateVin('3AKJHHDR9NSMY147'); // 16 chars
    expect(v.valid).toBe(false);
    expect(v.needsReview).toBe(true);
    expect(v.reason).toMatch(/17/);
  });

  it('normalizes case and trims whitespace before validating', () => {
    const v = validateVin(`  ${HONDA_EXAMPLE.toLowerCase()}  `);
    expect(v.value).toBe(HONDA_EXAMPLE);
    expect(v.valid).toBe(true);
  });
});
