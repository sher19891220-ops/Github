/**
 * Shared types for the universal document-extraction layer.
 *
 * Nothing here ever posts to `ledger_entry` directly, and nothing here is a
 * `StagingRow` either — that shape belongs to `@/contract/types` and is
 * produced by the doc-family parsers (`src/ingest/dispatch`,
 * `src/ingest/fuel`, `src/ingest/expenses`) from *good* text. This layer's
 * job ends one step earlier: turn arbitrary bytes (PDF, scanned image,
 * XLSX, CSV/TSV/TXT) into text/rows those parsers — or a human reviewer —
 * can read, while being honest about how much to trust what it read.
 *
 * SOURCE-DISCOVERY.md §14 measured 79% exact VIN recovery from a real OCR
 * pass. That is why every extracted field below carries a `confidence` and
 * a `needsReview` flag instead of a bare value: a field that failed a
 * structural check is flagged, never silently dropped and never silently
 * accepted.
 */

/** What `extractDocument` decided the input actually is, from its bytes —
 *  never from the file extension, which SOURCE-DISCOVERY.md and the task
 *  brief both call out as unreliable. */
export type DocKind =
  | 'pdf_text' // every page had a real text layer
  | 'pdf_scanned' // no page had a usable text layer; every page was OCR'd
  | 'pdf_mixed' // some pages had a text layer, some needed OCR
  | 'xlsx'
  | 'csv'
  | 'image'
  | 'unsupported';

/** A single value pulled out of a document, honest about how sure the
 *  extractor is. `confidence` is a 0..1 heuristic, not a probability in any
 *  rigorous sense — its only job is to separate "read cleanly" from "read,
 *  but do not trust without a human looking at it" (`needsReview`). A field
 *  that fails a structural check (VIN check digit, a total that does not
 *  sum, a date outside the document's period) always has `needsReview: true`
 *  regardless of how "confident" the raw read looked. */
export interface ExtractedField<T> {
  value: T | null;
  confidence: number;
  needsReview: boolean;
  /** Why `needsReview` is set, or how a correction was derived. `null` only
   *  when `needsReview` is false. */
  reason: string | null;
}

export function cleanField<T>(value: T, confidence: number): ExtractedField<T> {
  return { value, confidence, needsReview: false, reason: null };
}

export function flaggedField<T>(value: T | null, confidence: number, reason: string): ExtractedField<T> {
  return { value, confidence, needsReview: true, reason };
}

export type PageTextSource = 'text_layer' | 'ocr';

export interface ExtractedPage {
  pageNumber: number;
  text: string;
  source: PageTextSource;
  /** Non-whitespace character count, the measurement behind the
   *  text-layer-vs-scanned decision — kept on the page so a caller can see
   *  *why* a given page was routed the way it was. */
  charCount: number;
}

export interface ExtractedSheet {
  name: string;
  /** Raw cell text, row-major, exactly as read — no header assumed here.
   *  Locating a header row and reading by name is the caller's job
   *  (CLAUDE.md §2: "parse sheets by header, never by column index"), same
   *  as every existing sheet parser in `src/ingest/**` already does. */
  rows: string[][];
}

export interface ExtractionResult {
  status: 'ok' | 'failed';
  error: string | null;
  kind: DocKind;
  /** Populated for pdf_text / pdf_scanned / pdf_mixed / image inputs. */
  pages: ExtractedPage[] | null;
  /** Populated only for XLSX/XLSM input. */
  sheets: ExtractedSheet[] | null;
  /** Populated only for CSV/TSV/TXT input. */
  delimiter: string | null;
  /** True when at least one page needed OCR — a signal the whole document
   *  deserves closer review even where individual fields look clean. */
  anyPageOcrd: boolean;
}

export function failedExtraction(kind: DocKind, error: string): ExtractionResult {
  return { status: 'failed', error, kind, pages: null, sheets: null, delimiter: null, anyPageOcrd: false };
}
