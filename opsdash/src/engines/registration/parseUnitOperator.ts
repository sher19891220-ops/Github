/**
 * Parser for the VIN -> operating-entity crosswalk CSV (`irp_unit, vin,
 * operating_entity, as_of, source`). Parsed by header name, not column
 * position — same discipline as `parseUnitStatus.ts` and CLAUDE.md §2: a
 * header that adds or reorders a column must fail loudly here, not read
 * `source` into the `operating_entity` slot.
 *
 * This crosswalk answers docs/SOURCE-DISCOVERY.md §11e: the entity that
 * registers and pays (Zone) is not always the entity that operates the
 * truck. `operatingEntityKey` is recorded verbatim; it is NOT an
 * `entity_id` and this parser makes no attempt to resolve one — that
 * mapping (and the VIN -> truck mapping) happens externally, exactly like
 * `truckByVin`.
 */

import type { IsoDate } from '@/contract/types';
import type { UnitOperatorRow } from './types';

const EXPECTED_COLUMNS = ['irp_unit', 'vin', 'operating_entity', 'as_of', 'source'];

function splitCsvLine(line: string): string[] {
  // The one quoted-comma value in this fixture ("operator stated - paid
  // off, title Iron Lease") only appears in the trailing `source` column,
  // so a naive split followed by re-joining any overflow into the last
  // expected column is exact for this data. A quoted comma appearing
  // earlier would need a real CSV parser — that would show up as more
  // cells than expected columns before the last one, which we don't
  // special-case here because it hasn't happened in the real data.
  const cells = line.split(',');
  if (cells.length > EXPECTED_COLUMNS.length) {
    const head = cells.slice(0, EXPECTED_COLUMNS.length - 1);
    const tail = cells.slice(EXPECTED_COLUMNS.length - 1).join(',');
    return [...head, tail].map((c) => c.trim().replace(/^"|"$/g, ''));
  }
  return cells.map((c) => c.trim().replace(/^"|"$/g, ''));
}

/** `as_of` is `MM.DD.YY` (real data: `08.30.26`) or blank (operator-stated
 *  assignments with no dated snapshot, e.g. sher_imam/iron_lease/UNRESOLVED
 *  rows). Blank means null, never a guessed date. */
function parseAsOf(raw: string, lineNumber: number): IsoDate | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const m = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(trimmed);
  if (!m) {
    throw new Error(`Unit operator CSV line ${lineNumber}: as_of "${raw}" is not MM.DD.YY or blank`);
  }
  const [, mm, dd, yy] = m as unknown as [string, string, string, string];
  return `20${yy}-${mm}-${dd}`;
}

export function parseUnitOperatorCsv(text: string): UnitOperatorRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error('Unit operator CSV is empty');

  const header = splitCsvLine(lines[0] as string);
  const colIndex = new Map<string, number>();
  for (const col of EXPECTED_COLUMNS) {
    const idx = header.indexOf(col);
    if (idx < 0) throw new Error(`Unit operator CSV is missing expected column "${col}". Header: ${JSON.stringify(header)}`);
    colIndex.set(col, idx);
  }

  const rows: UnitOperatorRow[] = [];
  const seenVins = new Map<string, number>();

  for (let i = 1; i < lines.length; i++) {
    const lineNumber = i + 1;
    const cells = splitCsvLine(lines[i] as string);
    const irpUnit = cells[colIndex.get('irp_unit') as number] ?? '';
    const vin = cells[colIndex.get('vin') as number] ?? '';
    const operatingEntityKey = cells[colIndex.get('operating_entity') as number] ?? '';
    const asOfRaw = cells[colIndex.get('as_of') as number] ?? '';
    const source = cells[colIndex.get('source') as number] ?? '';

    if (!vin) throw new Error(`Unit operator CSV line ${lineNumber}: missing VIN for unit "${irpUnit}"`);
    if (!operatingEntityKey) throw new Error(`Unit operator CSV line ${lineNumber}: missing operating_entity for unit "${irpUnit}" (VIN ${vin})`);
    const priorLine = seenVins.get(vin);
    if (priorLine !== undefined) {
      throw new Error(`Unit operator CSV has duplicate VIN ${vin} on lines ${priorLine} and ${lineNumber}`);
    }
    seenVins.set(vin, lineNumber);

    rows.push({
      irpUnit,
      vin,
      operatingEntityKey,
      asOf: parseAsOf(asOfRaw, lineNumber),
      source,
    });
  }

  return rows;
}
