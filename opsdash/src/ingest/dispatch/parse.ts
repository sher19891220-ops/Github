/**
 * Dispatch Sheet 2026 revenue parser.
 *
 * Turns the weekly per-truck dispatch table into one StagingRow per
 * truck-per-day-with-revenue. See docs/SOURCE-DISCOVERY.md §2 for the
 * defects this survives, and docs/DATA-CONTRACT.md §6 for the shape it
 * builds to.
 *
 * Layout (fixed by position, confirmed against the real 818-line export —
 * this is the one place in this parser where index-based reads are safe,
 * because the shape itself, not just the header wording, is what the task
 * guarantees): a leading empty cell from the boundary `|`, then
 * `Dispatcher, Truck #, Payment, Driver Names`, then seven repeats of
 * `(lane text, amount, miles)`, then `Gross, Miles, RPM`, then trailing
 * decoration cells that vary in count and are never read.
 */
import type { StagingRow } from '@/contract/types';
import { cleanCell, parseDateHeaderCell, parseNumericCell, splitRow, toMoneyDecimalString, toQuantityDecimalString } from './text';
import { extractEntityMarker, mapDriverClass } from './signals';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const DAY_GROUP_COUNT = 7;
const FIRST_DAY_GROUP_COL = 5; // index into the split-by-'|' cell array
const MIN_COLUMNS = FIRST_DAY_GROUP_COL + DAY_GROUP_COUNT * 3 + 3; // through the RPM column

export interface TruckWeekReconciliation {
  sourceLineNumber: number;
  dispatcher: string;
  truckNumber: string;
  driverNamesRaw: string;
  sumOfParsedAmounts: string;
  grossRaw: string;
  grossParsed: string | null;
  reconciles: boolean;
  note: string | null;
}

export type DispatchParseResult =
  | { status: 'parsed'; rows: StagingRow[]; truckWeeks: TruckWeekReconciliation[] }
  | { status: 'failed'; error: string };

function isSeparatorRow(cells: string[]): boolean {
  const c2 = cleanCell(cells[2] ?? '');
  return c2 === ':-:';
}

function isHeaderRow(cells: string[]): boolean {
  return cleanCell(cells[3] ?? '').toLowerCase() === 'payment';
}

function isMergedDecorationRow(cells: string[]): boolean {
  return cleanCell(cells[3] ?? '').toLowerCase().includes('merged');
}

function isBlankSpacerRow(cells: string[]): boolean {
  const truck = cleanCell(cells[2] ?? '');
  const payment = cleanCell(cells[3] ?? '');
  const driver = cleanCell(cells[4] ?? '');
  return truck === '' && payment === '' && driver === '';
}

/**
 * Parses the raw markdown-table text of the 2026 dispatch sheet.
 *
 * @param rawText   the full document text
 * @param documentId  the id of the source_document this staging output
 *                    will be attached to by the caller
 */
export function parseDispatchSheet(rawText: string, documentId: string): DispatchParseResult {
  if (!rawText || !rawText.trim()) {
    return { status: 'failed', error: 'Dispatch sheet document is empty.' };
  }

  const lines = rawText.split('\n');
  let sawAnyHeader = false;
  let sawAnyDataRow = false;

  const currentWeekDates: Array<string | null> = new Array(DAY_GROUP_COUNT).fill(null);
  const rows: StagingRow[] = [];
  const truckWeeks: TruckWeekReconciliation[] = [];
  let rowIndex = 0;

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo] ?? '';
    if (!line.includes('|')) continue;

    const cells = splitRow(line);
    if (cells.length < MIN_COLUMNS) continue;
    if (isSeparatorRow(cells)) continue;

    if (isHeaderRow(cells)) {
      sawAnyHeader = true;
      for (let g = 0; g < DAY_GROUP_COUNT; g++) {
        const idx = FIRST_DAY_GROUP_COL + g * 3;
        const parsed = parseDateHeaderCell(cells[idx] ?? '');
        // Blank means "this dispatcher group didn't repeat the date row" —
        // carry the previous value forward rather than clearing it.
        if (parsed) currentWeekDates[g] = parsed;
      }
      continue;
    }

    if (isMergedDecorationRow(cells)) continue;
    if (isBlankSpacerRow(cells)) continue;

    // A genuine truck-week data row.
    sawAnyDataRow = true;
    const dispatcher = cleanCell(cells[1] ?? '');
    const truckNumber = cleanCell(cells[2] ?? '');
    const paymentRaw = cleanCell(cells[3] ?? '');
    const driverNamesRaw = cleanCell(cells[4] ?? '');
    const driverClass = mapDriverClass(paymentRaw);
    const entityMarker = extractEntityMarker(driverNamesRaw);

    const grossRawCell = cells[FIRST_DAY_GROUP_COL + DAY_GROUP_COUNT * 3] ?? '';
    const grossRaw = cleanCell(grossRawCell);
    const grossParsedCell = parseNumericCell(grossRawCell);
    const grossParsed = grossParsedCell ? toMoneyDecimalString(grossParsedCell) : null;

    let sumAmount = 0n; // cents, exact integer arithmetic — no floats in the money path
    let anyRowUnderReview = false;
    const reviewNotes: string[] = [];

    for (let g = 0; g < DAY_GROUP_COUNT; g++) {
      const laneIdx = FIRST_DAY_GROUP_COL + g * 3;
      const laneRaw = cleanCell(cells[laneIdx] ?? '');
      const amountRawCell = cells[laneIdx + 1] ?? '';
      const milesRawCell = cells[laneIdx + 2] ?? '';
      const amountRaw = cleanCell(amountRawCell);
      const milesRaw = cleanCell(milesRawCell);

      const amountParsed = parseNumericCell(amountRawCell);
      const isBlankAmount = amountRaw === '';

      if (isBlankAmount) {
        // No-load day (transit / OFF / HOME / stuck / TOWING / OOS / Sick /
        // "Truck is not ready" / truck change / ... or simply no revenue
        // that day). Per DATA-CONTRACT.md §5: post no entry, never a zero
        // one. The lane text is deliberately NOT used to decide this — the
        // real sheet has ~48 rows where a day's lane cell literally reads
        // "transit" or similar *and* still carries a genuine amount (see
        // report), so the presence of a parseable amount is the only
        // signal that reconciles against the sheet's own Gross column.
        continue;
      }

      if (!amountParsed) {
        // Non-blank but unparseable (e.g. a stray formula-error string).
        // Never seen in the real 2026 sheet, but "malformed input must
        // never silently disappear" applies per-cell too: surface it
        // instead of dropping the day.
        anyRowUnderReview = true;
        reviewNotes.push(`Day ${DAY_LABELS[g]}: amount cell not parseable ("${amountRaw}").`);
        continue;
      }

      const amountDecimal = toMoneyDecimalString(amountParsed);
      sumAmount += decimalToCents(amountDecimal);

      const milesParsed = parseNumericCell(milesRawCell);
      // The miles column sometimes carries a "$" (e.g. "$775.00" meaning
      // 775 miles, not $775) — parseNumericCell already strips it, so
      // this is read as a quantity unconditionally, never as money.
      const quantity = milesParsed ? toQuantityDecimalString(milesParsed) : null;

      let accrualDate = currentWeekDates[g] ?? null;
      if (!accrualDate) {
        anyRowUnderReview = true;
        reviewNotes.push(`Day ${DAY_LABELS[g]}: no date header was ever established for this column.`);
      }

      if (driverClass === 'unassigned') {
        anyRowUnderReview = true;
        if (!reviewNotes.some((n) => n.includes('Payment'))) {
          reviewNotes.push(`Payment column value "${paymentRaw}" is not CPM/LO/OO; driver class left unassigned.`);
        }
      }

      const parsedPayload: Record<string, unknown> = {
        sourceLineNumber: lineNo + 1,
        dispatcher,
        truckNumber: truckNumber || null,
        paymentRaw,
        driverNamesRaw,
        dayIndex: g,
        dayLabel: DAY_LABELS[g],
        laneTextRaw: laneRaw,
        amountRaw,
        milesRaw,
        grossRaw,
        driverClass,
        entityMarkerRaw: entityMarker,
      };

      const row: StagingRow = {
        stagingRowId: crypto.randomUUID(),
        documentId,
        rowIndex: rowIndex++,
        sourcePage: null,
        parsedPayload,
        reviewedPayload: null,
        // Entity is the raw marker code (XTRACK/AFG/ZONE), not a resolved
        // canonical UUID — resolving through source_key_map is the
        // review/commit layer's job, not this parser's (DATA-CONTRACT §3).
        entityId: entityMarker,
        // Identity resolution for truck/driver must go through
        // source_key_map, never a string match here; the raw values are
        // preserved in parsedPayload for that resolution step.
        truckId: null,
        driverId: null,
        accrualDate,
        categoryId: 'revenue.linehaul',
        amount: amountDecimal,
        quantity,
        jurisdiction: null, // Dispatch Sheet carries no purchase/travel state.
        status: anyRowUnderReview ? 'under_review' : 'parsed',
        reviewNotes: reviewNotes.length ? reviewNotes.join(' ') : null,
      };
      rows.push(row);
    }

    const sumDecimal = centsToDecimalString(sumAmount);
    let reconciles: boolean;
    let note: string | null = null;
    if (grossParsed === null) {
      reconciles = false;
      note = `Sheet Gross cell is not a number ("${grossRaw}") — likely a spreadsheet formula error; cannot reconcile.`;
    } else {
      reconciles = decimalToCents(sumDecimal) === decimalToCents(grossParsed);
      if (!reconciles) note = `Parsed sum ${sumDecimal} does not match sheet Gross ${grossParsed}.`;
    }

    truckWeeks.push({
      sourceLineNumber: lineNo + 1,
      dispatcher,
      truckNumber,
      driverNamesRaw,
      sumOfParsedAmounts: sumDecimal,
      grossRaw,
      grossParsed,
      reconciles,
      note,
    });
  }

  if (!sawAnyHeader || !sawAnyDataRow) {
    return {
      status: 'failed',
      error: 'No recognizable Dispatcher/Truck #/Payment/Driver Names table found in this document.',
    };
  }

  return { status: 'parsed', rows, truckWeeks };
}

function decimalToCents(decimal: string): bigint {
  const negative = decimal.startsWith('-');
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [intPart, fracPart = ''] = unsigned.split('.');
  const frac = (fracPart + '00').slice(0, 2);
  const cents = BigInt(intPart || '0') * 100n + BigInt(frac || '0');
  return negative ? -cents : cents;
}

function centsToDecimalString(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const intPart = abs / 100n;
  const fracPart = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${intPart.toString()}.${fracPart}`;
}
