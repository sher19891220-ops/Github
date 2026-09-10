/**
 * Parser for the VIN -> HVUT-payer crosswalk CSV (`irp_unit, vin, status,
 * hvut_payer_CONFIRM`). Parsed by header name, not column position, even
 * though this particular file is small and internally produced — a header
 * that adds or reorders a column must fail loudly here too, not read
 * `status` into the `hvutPayer` slot.
 */

import type { ChargedTo, UnitStatusRow } from './types';

const EXPECTED_COLUMNS = ['irp_unit', 'vin', 'status', 'hvut_payer_CONFIRM'];

function splitCsvLine(line: string): string[] {
  // No quoted commas appear in this fixture's values; a naive split is exact
  // for the real data. A quoted-comma value would need a real CSV parser —
  // flagged here rather than silently mis-split if that ever changes.
  return line.split(',').map((c) => c.trim());
}

function normalizeHvutPayer(raw: string, lineNumber: number): ChargedTo {
  const v = raw.trim().toLowerCase();
  if (v === 'company') return 'company';
  if (v === 'driver') return 'driver';
  if (v === 'unresolved') return 'unknown';
  throw new Error(
    `Unit status CSV line ${lineNumber}: unrecognized hvut_payer_CONFIRM value ${JSON.stringify(raw)} — ` +
      `expected "company", "driver" or "UNRESOLVED". Refusing to guess.`,
  );
}

export function parseUnitStatusCsv(text: string): UnitStatusRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error('Unit status CSV is empty');

  const header = splitCsvLine(lines[0] as string);
  const colIndex = new Map<string, number>();
  for (const col of EXPECTED_COLUMNS) {
    const idx = header.indexOf(col);
    if (idx < 0) throw new Error(`Unit status CSV is missing expected column "${col}". Header: ${JSON.stringify(header)}`);
    colIndex.set(col, idx);
  }

  const rows: UnitStatusRow[] = [];
  const seenVins = new Map<string, number>();

  for (let i = 1; i < lines.length; i++) {
    const lineNumber = i + 1;
    const cells = splitCsvLine(lines[i] as string);
    const irpUnit = cells[colIndex.get('irp_unit') as number] ?? '';
    const vin = cells[colIndex.get('vin') as number] ?? '';
    const status = cells[colIndex.get('status') as number] ?? '';
    const hvutPayerRaw = cells[colIndex.get('hvut_payer_CONFIRM') as number] ?? '';

    if (!vin) throw new Error(`Unit status CSV line ${lineNumber}: missing VIN for unit "${irpUnit}"`);
    const priorLine = seenVins.get(vin);
    if (priorLine !== undefined) {
      throw new Error(`Unit status CSV has duplicate VIN ${vin} on lines ${priorLine} and ${lineNumber}`);
    }
    seenVins.set(vin, lineNumber);

    rows.push({
      irpUnit,
      vin,
      status,
      hvutPayer: normalizeHvutPayer(hvutPayerRaw, lineNumber),
    });
  }

  return rows;
}
