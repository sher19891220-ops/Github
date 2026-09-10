/**
 * IRP "Vehicle Status" registration report — a real document family
 * (SOURCE-DISCOVERY.md §11b-§11g) and the one used to prove the whole
 * extraction pipeline end to end: text-layer round trip recovers all VINs
 * exactly, and the scanned/OCR path plus VIN structural validation recovers
 * as many as the check digit allows.
 *
 * Each data row (after `pdftotext -layout`, or after OCR) looks like:
 *
 *   1365        003456354 3AKJHHDRXNSMY1365       A        80    TT   2022  FRHT   PXF8697
 *
 * i.e. `UNIT USDOT VIN STATUS WEIGHT-GROUP TYPE YEAR MAKE PLATE`, spacing
 * only roughly preserved (worse after OCR — including one real case where a
 * stray space split the VIN's own digits across two tokens). Rather than
 * trust column offsets (unreliable once OCR is involved) or naive
 * whitespace-splitting (breaks on that stray-space case), every row is
 * matched against a fixed-field-width regex applied to the *whitespace-
 * stripped* line: the field lengths themselves (9-digit USDOT, 17-char VIN,
 * 4-digit year, ...) are the structure, not the spacing.
 */
import { cleanField, type ExtractedField } from './types';
import { validateVin, type VinValidation } from './vin';

const HEADER_OR_FOOTER_RE = /^(UNIT\b|GROUP$|Page\s+\d+\s+of\s+\d+|OHIO\b|BUREAU\b|IRP\b|Account No|Legal Name|Supplement No|Total Units)/i;

// unit(3-6 digits, non-greedy) usdot(9 digits) vin(17 chars, VIN alphabet
// incl. OCR noise) status(1 letter) weight(2-3 digits) type(2 letters)
// year(4 digits) make(3-4 letters) plate(5-9 alnum).
const ROW_RE = /^(\d{3,6}?)(\d{9})([A-Z0-9]{17})([A-Z])(\d{2,3})([A-Z]{2})(\d{4})([A-Z]{3,4})([A-Z0-9]{5,9})$/;

export interface RegistrationVehicleRow {
  unit: ExtractedField<string>;
  usdot: ExtractedField<string>;
  vin: ExtractedField<string> & { illegalChars: VinValidation['illegalChars']; corrected: boolean; original: string };
  status: ExtractedField<string>;
  weightGroup: ExtractedField<string>;
  vehicleType: ExtractedField<string>;
  year: ExtractedField<string>;
  make: ExtractedField<string>;
  plate: ExtractedField<string>;
  /** The line as read, pre-normalization — kept for provenance/debugging. */
  sourceLine: string;
}

/** Parses every vehicle row out of one page (or the whole document) of
 *  extracted text. Lines that aren't a data row (headers, the repeated
 *  "GROUP" continuation line, page footers) are silently skipped — that is
 *  expected structure, not a parse failure. A line that *looks* like it
 *  should be a data row (right general shape) but doesn't fit the fixed
 *  field widths is also skipped rather than guessed at; nothing here
 *  fabricates a row. */
export function parseRegistrationVehicleRows(text: string): RegistrationVehicleRow[] {
  const rows: RegistrationVehicleRow[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (HEADER_OR_FOOTER_RE.test(line)) continue;

    const compact = line.replace(/\s+/g, '');
    const m = ROW_RE.exec(compact);
    if (!m) continue;

    const [, unit, usdot, vinRaw, status, weight, type, year, make, plate] = m as unknown as [
      string, string, string, string, string, string, string, string, string, string,
    ];

    const vv = validateVin(vinRaw);

    rows.push({
      unit: cleanField(unit, 0.9),
      usdot: cleanField(usdot, 0.9),
      vin: {
        value: vv.value,
        confidence: vv.confidence,
        needsReview: vv.needsReview,
        reason: vv.reason,
        illegalChars: vv.illegalChars,
        corrected: vv.corrected,
        original: vv.original,
      },
      status: cleanField(status, 0.85),
      weightGroup: cleanField(weight, 0.85),
      vehicleType: cleanField(type, 0.85),
      year: cleanField(year, 0.85),
      make: cleanField(make, 0.85),
      plate: cleanField(plate, 0.85),
      sourceLine: line,
    });
  }

  return rows;
}

/** Convenience for the common "just show me the VINs and whether each is
 *  trustworthy" view used by the readiness tests and, eventually, the
 *  review queue for this document family. */
export function extractVins(text: string): Array<RegistrationVehicleRow['vin']> {
  return parseRegistrationVehicleRows(text).map((r) => r.vin);
}
