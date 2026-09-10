/**
 * Minimal tokenizer for the pipe-delimited markdown tables the Fuel sheet
 * and Fuel Avrg Company Report are exported as. Deliberately independent of
 * `src/ingest/expenses/table.ts` (same shape, different family — see the
 * task's worktree-isolation note) rather than sharing a module across the
 * two ingest packages.
 */

export interface RawRow {
  /** 1-based line number in the source text, for traceability. */
  lineNumber: number;
  cells: string[];
  /** True for a `| :-: | :-: | ... |` alignment row — a table boundary. */
  isAlignment: boolean;
}

const ALIGNMENT_CELL_RE = /^:?-+:?$/;

/** Undoes the backslash-escaping the markdown export applies
 *  (`M\&Y` -> `M&Y`, `\#` -> `#`, `\!` -> `!`). */
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
