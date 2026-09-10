/**
 * Minimal tokenizer for the pipe-delimited markdown tables the "Truck and
 * trailer expenses" sheet is exported as. Several distinct tables (cost
 * lines, shop invoices, section markers) are interleaved in one file,
 * separated by `:-:` alignment rows and blank lines. This file only turns
 * lines into cell arrays with their source line number; deciding what a row
 * means is the caller's job (parse by header, never by position).
 */

export interface RawRow {
  /** 1-based line number in the source text, for traceability back to the
   *  document a reviewer can still open. */
  lineNumber: number;
  cells: string[];
  /** True for a `| :-: | :-: | ... |` markdown table-alignment row. Kept
   *  (rather than dropped) so callers can treat it as a table boundary: a
   *  new table starts here, and any previously-detected header must not be
   *  trusted past it without being re-matched. Real data has at least one
   *  section (an inter-company settlement table pasted into the expenses
   *  tab) whose header text was blanked out but whose alignment row still
   *  marks a genuinely new, differently-shaped table. */
  isAlignment: boolean;
}

const ALIGNMENT_CELL_RE = /^:?-+:?$/;

/** Undoes the backslash-escaping the markdown export applies to characters
 *  that are special in markdown (`\-$80.52` -> `-$80.52`, `M\&Y` -> `M&Y`,
 *  `Inv\#` -> `Inv#`). This is a formatting artifact of the export, not a
 *  business value, so unescaping it is not "guessing" at the data. */
export function unescapeMarkdown(cell: string): string {
  return cell.replace(/\\([#&\-!_*`.[\]()])/g, '$1');
}

export function splitPipeRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const inner = trimmed.slice(1, -1);
  return inner.split('|').map((c) => unescapeMarkdown(c.trim()));
}

export function isAlignmentRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => ALIGNMENT_CELL_RE.test(c.trim()));
}

export function isBlankRow(cells: string[]): boolean {
  return cells.every((c) => c.trim() === '');
}

export function tokenizeTable(text: string): RawRow[] {
  const rows: RawRow[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const cells = splitPipeRow(lines[i] ?? '');
    if (cells === null) continue;
    rows.push({ lineNumber: i + 1, cells, isAlignment: isAlignmentRow(cells) });
  }
  return rows;
}

export function normalizeHeaderCell(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function cellAt(cells: string[], idx: number): string {
  if (idx < 0 || idx >= cells.length) return '';
  return (cells[idx] ?? '').trim();
}
