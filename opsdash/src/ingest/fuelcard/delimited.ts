/**
 * Reads the tabular body out of a fuel-card statement, whatever shape it
 * arrived in.
 *
 * Card vendors export the same data as CSV, as tab-separated text, as a
 * fixed-width report, and — once it has been through this project's
 * PDF/XLSX extraction — as the pipe-delimited markdown the rest of the
 * ingest packages already speak. Rather than one parser per shape, the
 * delimiter is *sniffed* from the file: the separator that yields the most
 * consistent column count across the most lines wins.
 *
 * Quoted CSV fields are handled properly (a comma inside `"Columbus, OH"`
 * is not a column break) because a statement's location column contains
 * commas almost by definition, and splitting on them would shift every
 * column to the right of it — silently, on some rows and not others.
 */

export type Delimiter = ',' | '\t' | '|' | ';';

export interface SniffResult {
  delimiter: Delimiter;
  /** How many columns the winning delimiter produces on the body rows. */
  columnCount: number;
  /** How many lines agreed on that count. */
  agreeingLines: number;
}

const CANDIDATES: readonly Delimiter[] = [',', '\t', '|', ';'];

/** Splits one line, honouring double-quoted fields and `""` escapes. */
export function splitDelimited(line: string, delimiter: Delimiter): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      out.push(field);
      field = '';
      continue;
    }
    field += ch;
  }
  out.push(field);

  // A markdown pipe row is `| a | b |`, which splits to an empty leading
  // and trailing cell. Drop them, but only when both are empty — a real
  // CSV can legitimately have an empty first or last field.
  if (delimiter === '|' && out.length > 2 && out[0]!.trim() === '' && out[out.length - 1]!.trim() === '') {
    return out.slice(1, -1).map((c) => c.trim());
  }
  return out.map((c) => c.trim());
}

const ALIGNMENT_CELL_RE = /^:?-{2,}:?$/;

/** True for a markdown `| :-: | --- |` rule, which is layout, not data. */
export function isAlignmentRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((c) => ALIGNMENT_CELL_RE.test(c.trim()));
}

/**
 * Picks the delimiter.
 *
 * Scored on *agreement*, not on raw count: prose lines contain commas too,
 * so "most commas" picks comma for a tab-separated file with an address in
 * it. What distinguishes a real table is that many lines split into the
 * same number of fields.
 */
export function sniffDelimiter(text: string): SniffResult | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return null;

  let best: SniffResult | null = null;

  for (const delimiter of CANDIDATES) {
    const counts = new Map<number, number>();
    for (const line of lines) {
      const n = splitDelimited(line, delimiter).length;
      if (n < 2) continue;
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    for (const [columnCount, agreeingLines] of counts) {
      if (agreeingLines < 2) continue;
      const candidate = { delimiter, columnCount, agreeingLines };
      if (
        best === null ||
        agreeingLines > best.agreeingLines ||
        // Tie on agreement: prefer the shape with more columns. A
        // statement mis-split into 2 columns "agrees" as often as the
        // correct 11-column split and carries far less.
        (agreeingLines === best.agreeingLines && columnCount > best.columnCount)
      ) {
        best = candidate;
      }
    }
  }

  return best;
}

export interface DelimitedRow {
  /** 1-based line number in the source, for traceability back to the file. */
  lineNumber: number;
  cells: string[];
}

export interface DelimitedTable {
  delimiter: Delimiter;
  headerLineNumber: number;
  header: string[];
  rows: DelimitedRow[];
  /** Lines that split to a different width than the header. Kept, not
   *  dropped: a statement whose rows do not match its own header is a fact
   *  worth reporting, and one of them is usually the totals line. */
  offWidthLines: DelimitedRow[];
}

/**
 * Finds the header row and returns the table under it.
 *
 * The header is not assumed to be line 1. Every real statement opens with a
 * letterhead, an account number, a billing period and a remit-to address
 * before the transaction table starts. `scoreHeader` picks the first line
 * that both splits to the table's width and looks like column names rather
 * than data — mostly non-numeric cells, and at least a couple of them
 * recognisable as fuel-statement column names.
 */
export function readTable(text: string, scoreHeader: (cells: readonly string[]) => number): DelimitedTable | null {
  const sniff = sniffDelimiter(text);
  if (sniff === null) return null;

  const rawLines = text.split(/\r?\n/);
  let headerIndex = -1;
  let headerScore = 0;
  let header: string[] = [];

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i]!;
    if (line.trim() === '') continue;
    const cells = splitDelimited(line, sniff.delimiter);
    if (cells.length !== sniff.columnCount) continue;
    if (isAlignmentRow(cells)) continue;
    const score = scoreHeader(cells);
    if (score > headerScore) {
      headerScore = score;
      headerIndex = i;
      header = cells;
    }
  }

  if (headerIndex === -1) return null;

  const rows: DelimitedRow[] = [];
  const offWidthLines: DelimitedRow[] = [];
  for (let i = headerIndex + 1; i < rawLines.length; i += 1) {
    const line = rawLines[i]!;
    if (line.trim() === '') continue;
    const cells = splitDelimited(line, sniff.delimiter);
    if (isAlignmentRow(cells)) continue;
    const row: DelimitedRow = { lineNumber: i + 1, cells };
    if (cells.length === sniff.columnCount) rows.push(row);
    else offWidthLines.push(row);
  }

  return {
    delimiter: sniff.delimiter,
    headerLineNumber: headerIndex + 1,
    header,
    rows,
    offWidthLines,
  };
}
