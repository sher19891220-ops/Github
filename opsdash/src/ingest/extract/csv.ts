/**
 * CSV/TSV/TXT decoding — direct decode plus delimiter sniffing, per the
 * task brief. Handles basic RFC 4180 quoting (quoted fields, commas and
 * newlines inside quotes, doubled `""` as an escaped quote) since operator
 * exports commonly quote fields that contain the delimiter.
 */

const CANDIDATE_DELIMITERS = [',', '\t', ';', '|'] as const;

/** Strips a UTF-8 BOM if present and decodes as UTF-8. */
export function decodeText(bytes: Buffer): string {
  let buf = bytes;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.subarray(3);
  }
  return buf.toString('utf8');
}

/** Picks the delimiter that appears most consistently across the first
 *  handful of non-blank lines — not just the most frequent character
 *  overall, which a stray comma in a free-text field could win. */
export function sniffDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 10);
  if (lines.length === 0) return ',';

  let best: string = ',';
  let bestScore = -1;
  for (const delim of CANDIDATE_DELIMITERS) {
    const counts = lines.map((l) => l.split(delim).length - 1);
    const nonZero = counts.filter((c) => c > 0);
    if (nonZero.length === 0) continue;
    // Score: how many lines agree on the same count (consistency), then
    // the count itself as a tiebreaker (more columns is a stronger signal
    // than "found one stray character").
    const first = counts[0] ?? 0;
    const agreement = counts.filter((c) => c === first).length;
    const score = agreement * 1000 + first;
    if (score > bestScore) {
      bestScore = score;
      best = delim;
    }
  }
  return best;
}

/** Splits delimited text into rows of raw string cells, honoring
 *  double-quoted fields (RFC 4180: `""` inside a quoted field is a literal
 *  quote, delimiters and newlines inside quotes are literal). */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Trailing field/row (file may or may not end with a newline).
  if (field !== '' || row.length > 0) pushRow();

  return rows;
}
