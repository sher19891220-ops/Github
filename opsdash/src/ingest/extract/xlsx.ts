/**
 * XLSX/XLSM reading via `exceljs`.
 *
 * Cells come back as raw strings, row-major, per sheet — no header assumed
 * here (CLAUDE.md §2: parse sheets by header, never by column index; that
 * happens one layer up, in a doc-family parser, exactly as the existing
 * `src/ingest/dispatch|fuel|expenses` parsers already do for text tables).
 *
 * A note on precision: exceljs represents a numeric cell as a JS `number`
 * internally — there is no way around that for a library reading the OOXML
 * number encoding, and rewriting an XLSX parser from scratch is out of
 * scope here. The mitigation is that this module converts every numeric
 * cell to a string exactly once, immediately, and never performs arithmetic
 * on the number itself; nothing downstream of this file ever sees a
 * `number` for a money value. Amounts a caller reads out of the resulting
 * strings still go through `extractMoney`/`isDecimal`, so a cell whose
 * string form isn't wire-legal is flagged, not silently trusted.
 */
import ExcelJS from 'exceljs';
import type { ExtractedSheet } from './types';

function cellToText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    // Number.prototype.toString() on a double produces the shortest decimal
    // string that round-trips to the same float — exact for any value that
    // was authored as a literal decimal in the sheet (which every real
    // money/quantity cell is), and the only thing achievable without a
    // ground-up OOXML byte parser.
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    // Formula cell: { formula, result } (or richText, hyperlink, error...).
    if ('result' in value && value.result !== undefined && value.result !== null) {
      return cellToText(value.result as ExcelJS.CellValue);
    }
    if ('text' in value && typeof (value as { text?: unknown }).text === 'string') {
      return (value as { text: string }).text;
    }
    if ('richText' in value && Array.isArray((value as { richText?: unknown }).richText)) {
      return (value as { richText: Array<{ text: string }> }).richText.map((r) => r.text).join('');
    }
    if ('error' in value) return `#ERROR:${String((value as { error: unknown }).error)}`;
    return '';
  }
  return String(value);
}

export interface XlsxReadResult {
  status: 'ok' | 'failed';
  error: string | null;
  sheets: ExtractedSheet[] | null;
}

/** Reads every worksheet in an XLSX/XLSM buffer. Fails loudly (never a
 *  half-populated result) if the bytes are not a readable workbook at all —
 *  the case where the zip signature matched but the content wasn't really a
 *  spreadsheet (sniff.ts can only tell "zip", not "valid workbook"). */
export async function extractXlsx(bytes: Buffer): Promise<XlsxReadResult> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'failed', error: `not a readable XLSX/XLSM workbook: ${message}`, sheets: null };
  }

  if (workbook.worksheets.length === 0) {
    return { status: 'failed', error: 'workbook has no worksheets.', sheets: null };
  }

  const sheets: ExtractedSheet[] = workbook.worksheets.map((ws) => {
    const rows: string[][] = [];
    // eachRow skips fully-empty trailing rows by default in exceljs, and
    // rowNumber can have gaps (blank rows) — walk by rowNumber so a blank
    // row in the middle doesn't shift every following row up by one.
    let maxRow = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (row.number > maxRow) maxRow = row.number;
    });
    for (let r = 1; r <= maxRow; r++) {
      const row = ws.getRow(r);
      const rowCells: string[] = [];
      let maxCol = 0;
      row.eachCell({ includeEmpty: false }, (_cell, colNumber) => {
        if (colNumber > maxCol) maxCol = colNumber;
      });
      for (let c = 1; c <= maxCol; c++) {
        rowCells.push(cellToText(row.getCell(c).value));
      }
      rows.push(rowCells);
    }
    return { name: ws.name, rows };
  });

  return { status: 'ok', error: null, sheets };
}
