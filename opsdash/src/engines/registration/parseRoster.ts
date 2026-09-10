/**
 * Parser for the Ohio BMV "IRP - VEHICLE STATUS" report — a fixed-width text
 * export, paginated, with the column header repeating on every page.
 *
 * This is not a Google Sheet, but the same discipline applies: parse by the
 * header's own column positions, never by a hardcoded index, so a layout
 * change (a column added, a label re-worded) fails loudly on the next real
 * invoice instead of silently reading the wrong field as a VIN.
 */

import type { IrpInvoiceHeader, IrpInvoiceRoster, IrpInvoiceUnit } from './types';

const ROSTER_COLUMNS = ['UNIT', 'USDOT', 'VIN', 'STATUS', 'WEIGHT', 'TYPE', 'YEAR', 'MAKE', 'PLATE'] as const;

interface ColumnOffset {
  label: (typeof ROSTER_COLUMNS)[number];
  start: number;
}

function isRosterHeaderLine(line: string): boolean {
  return ROSTER_COLUMNS.every((label) => new RegExp(`\\b${label}\\b`).test(line));
}

function columnOffsets(headerLine: string): ColumnOffset[] {
  const offsets = ROSTER_COLUMNS.map((label) => {
    const start = headerLine.search(new RegExp(`\\b${label}\\b`));
    if (start < 0) {
      throw new Error(`IRP roster header is missing expected column "${label}": ${JSON.stringify(headerLine)}`);
    }
    return { label, start };
  });
  return offsets.sort((a, b) => a.start - b.start);
}

function sliceColumns(dataLine: string, offsets: ColumnOffset[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < offsets.length; i++) {
    const offset = offsets[i] as ColumnOffset;
    const next = offsets[i + 1];
    const end = next ? next.start : dataLine.length;
    out[offset.label] = dataLine.slice(offset.start, end).trim();
  }
  return out;
}

const UNIT_TOKEN_RE = /^\d+[A-Za-z]*$/; // real data is bare digits; tolerate a trailing letter defensively

function parseUnitLine(fields: Record<string, string>, lineNumber: number): IrpInvoiceUnit {
  const unitNumber = fields.UNIT ?? '';
  const vin = fields.VIN ?? '';
  const weightGroupRaw = fields.WEIGHT ?? '';
  const yearRaw = fields.YEAR ?? '';

  if (!vin) {
    throw new Error(`IRP roster line ${lineNumber}: unit "${unitNumber}" has no VIN — refusing to book a unit that cannot be crosswalked`);
  }
  const weightGroup = Number(weightGroupRaw);
  if (!Number.isInteger(weightGroup)) {
    throw new Error(`IRP roster line ${lineNumber}: unit "${unitNumber}" has a non-numeric weight group "${weightGroupRaw}"`);
  }
  const year = Number(yearRaw);
  if (!Number.isInteger(year)) {
    throw new Error(`IRP roster line ${lineNumber}: unit "${unitNumber}" has a non-numeric year "${yearRaw}"`);
  }

  return {
    unitNumber,
    usdot: fields.USDOT ?? '',
    vin,
    status: fields.STATUS ?? '',
    weightGroup,
    vehicleType: fields.TYPE ?? '',
    year,
    make: fields.MAKE ?? '',
    plate: fields.PLATE ?? '',
  };
}

function extractHeaderField(text: string, label: RegExp): string[] {
  const matches: string[] = [];
  for (const m of text.matchAll(label)) {
    if (m[1] !== undefined) matches.push(m[1].trim());
  }
  return matches;
}

/** All occurrences of a header field (it repeats once per page) must agree,
 *  or the document is internally inconsistent and must not be trusted. */
function uniqueOrThrow(field: string, values: string[]): string {
  if (values.length === 0) {
    throw new Error(`IRP invoice header is missing required field "${field}"`);
  }
  const distinct = new Set(values);
  if (distinct.size > 1) {
    throw new Error(`IRP invoice header field "${field}" disagrees across pages: ${JSON.stringify([...distinct])}`);
  }
  return values[0] as string;
}

function runDateToIso(mmddyyyy: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(mmddyyyy);
  if (!m) throw new Error(`IRP invoice run date is not MM/DD/YYYY: ${JSON.stringify(mmddyyyy)}`);
  return `${m[3]}-${m[1]}-${m[2]}`;
}

function parseHeader(text: string): IrpInvoiceHeader {
  const runDates = extractHeaderField(text, /Run Date:\s*(\d{2}\/\d{2}\/\d{4})/g);
  const accountNos = extractHeaderField(text, /Account No\.\s*:\s*(\S+)/g);
  const legalNames = extractHeaderField(text, /Legal Name\s*:\s*(.+?)\s{2,}/g);
  const fleetNos = extractHeaderField(text, /Fleet No\.\s*:\s*(\S+)/g);
  const expYears = extractHeaderField(text, /Fleet Expiration Year\s*:\s*(\d+)/g);
  const expMonths = extractHeaderField(text, /Fleet Expiration Month\s*:\s*(\d+)/g);
  const totalUnitsField = extractHeaderField(text, /Total Units\s*:\s*(\d+)/g);

  return {
    runDate: runDateToIso(uniqueOrThrow('Run Date', runDates)),
    accountNo: uniqueOrThrow('Account No.', accountNos),
    legalName: uniqueOrThrow('Legal Name', legalNames),
    fleetNo: uniqueOrThrow('Fleet No.', fleetNos),
    fleetExpirationYear: Number(uniqueOrThrow('Fleet Expiration Year', expYears)),
    fleetExpirationMonth: Number(uniqueOrThrow('Fleet Expiration Month', expMonths)),
    totalUnits: Number(uniqueOrThrow('Total Units', totalUnitsField)),
  };
}

/**
 * Parses the full report: header metadata plus the per-unit roster. Throws
 * (rather than silently skipping) on a header missing an expected column, a
 * unit row missing a VIN, or header fields that disagree between the two
 * report pages — all real ways this document could be subtly wrong that
 * must surface to a human, not get quietly worked around.
 */
export function parseIrpVehicleStatusReport(text: string): IrpInvoiceRoster {
  const header = parseHeader(text);
  const lines = text.split(/\r?\n/);

  const units: IrpInvoiceUnit[] = [];
  let offsets: ColumnOffset[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isRosterHeaderLine(line)) {
      offsets = columnOffsets(line);
      continue;
    }
    if (!offsets) continue; // haven't seen a header yet — title/blank lines before it

    const unitOffset = offsets.find((o) => o.label === 'UNIT');
    const candidateUnitField = unitOffset
      ? line.slice(unitOffset.start, (offsets[offsets.indexOf(unitOffset) + 1]?.start) ?? line.length).trim()
      : '';
    if (!UNIT_TOKEN_RE.test(candidateUnitField)) continue; // blank line, "GROUP" continuation, page footer, etc.

    const fields = sliceColumns(line, offsets);
    units.push(parseUnitLine(fields, i + 1));
  }

  if (units.length !== header.totalUnits) {
    throw new Error(
      `IRP roster header states Total Units: ${header.totalUnits} but ${units.length} unit rows were parsed`,
    );
  }

  const vinCounts = new Map<string, number>();
  for (const u of units) vinCounts.set(u.vin, (vinCounts.get(u.vin) ?? 0) + 1);
  const duplicateVins = [...vinCounts.entries()].filter(([, n]) => n > 1).map(([vin]) => vin);
  if (duplicateVins.length > 0) {
    throw new Error(`IRP roster has duplicate VINs, which breaks the VIN crosswalk: ${duplicateVins.join(', ')}`);
  }

  return { header, units };
}
