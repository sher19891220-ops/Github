import { randomUUID } from 'node:crypto';
import type { StagingRow, StagingStatus } from '@/contract/types';
import { cellAt, isBlankRow, normalizeHeaderCell, tokenizeTable } from './table';
import { parseExpenseDate } from './dates';
import { parseExpenseAmount } from './money';
import { extractIssuedToSignals } from './identity';
import { classifyCategoryGroup, extractEntityHint, normalizeChargedTo, normalizeUnitType } from './classify';
import type { ChargedTo, UnitType, CategoryGroupHint } from './classify';

/**
 * The "Truck and trailer expenses" tab, sniffed and parsed. Selection is by
 * document content, not a user-picked type: `sniffExpensesDocument` looks
 * for the cost-table header shape rather than trusting a file name.
 */

export type ExpenseTableVariant = 'A' | 'B';

interface ExpenseColumnMap {
  variant: ExpenseTableVariant;
  vendorIdx: number;
  transferCodeIdx: number;
  idIdx: number;
  amountIdx: number;
  unitIdx: number;
  issuedToIdx: number;
  unitTypeIdx: number;
  costTypeIdx: number;
  dateIdx: number;
  expenseSideIdx: number;
  detailsIdx: number;
}

function findIdx(norm: string[], name: string): number {
  return norm.indexOf(name);
}

/**
 * Two header variants exist on the live sheet (SOURCE-DISCOVERY §5 / §"Other
 * sheets discovered" corrected header). Detected by the presence of the
 * `$ used` and `Issued To` columns — never by column count or position,
 * since section-to-section column counts on this tab are 11, 9, 4 and 3.
 */
function detectExpenseHeader(cells: string[]): ExpenseColumnMap | null {
  const norm = cells.map(normalizeHeaderCell);
  if (!norm.includes('$ used') || !norm.includes('issued to')) return null;

  if (norm.includes('transfer code')) {
    return {
      variant: 'B',
      vendorIdx: 0,
      transferCodeIdx: findIdx(norm, 'transfer code'),
      idIdx: findIdx(norm, 'id'),
      amountIdx: findIdx(norm, '$ used'),
      unitIdx: findIdx(norm, 'unit'),
      issuedToIdx: findIdx(norm, 'issued to'),
      unitTypeIdx: findIdx(norm, 'unit type'),
      costTypeIdx: findIdx(norm, 'cost type'),
      dateIdx: findIdx(norm, 'issued date'),
      expenseSideIdx: findIdx(norm, 'expense side'),
      detailsIdx: findIdx(norm, 'details'),
    };
  }

  return {
    variant: 'A',
    vendorIdx: -1,
    transferCodeIdx: -1,
    idIdx: -1,
    amountIdx: findIdx(norm, '$ used'),
    unitIdx: findIdx(norm, 'unit'),
    issuedToIdx: findIdx(norm, 'issued to'),
    unitTypeIdx: findIdx(norm, 'unit type'),
    costTypeIdx: findIdx(norm, 'cost type'),
    dateIdx: findIdx(norm, 'date'),
    expenseSideIdx: findIdx(norm, 'expense side'),
    detailsIdx: findIdx(norm, 'details'),
  };
}

/**
 * A cost section whose header row was blanked out by the export.
 *
 * Real data has a 420-row block of variant-B cost rows — Penske and Ryder
 * tolls, parking violations, shop invoices, a Samsara subscription — whose
 * header survived only as a stray "Date" in one cell. Requiring a header match
 * discarded every one of them as `outside_recognized_cost_table`, which is
 * hundreds of real cost rows silently absent from the P&L.
 *
 * So a headerless section is adopted when a row carries variant B's
 * *signature*, not its column count (§5: column counts on this tab are 11, 9,
 * 4 and 3, and are never a safe key):
 *
 *   - index 3 parses as money,
 *   - index 6 is literally `truck` or `trailer`,
 *   - index 8 parses as a date.
 *
 * Index 6 is what makes this safe. The settlement table pasted into the same
 * tab also has money at index 3 and a date at index 8, but carries `paid`
 * there — so it is still refused, and its running-balance columns are still
 * never summed.
 *
 * Rows adopted this way are staged `under_review` regardless of how clean
 * they look: the column meanings were inferred from shape rather than read
 * from a header, and that inference is exactly the kind of thing a person
 * should confirm before it reaches the ledger.
 */
function inferHeaderlessVariantB(cells: string[]): ExpenseColumnMap | null {
  if (cells.length < 10) return null;
  const at = (i: number) => (cells[i] ?? '').trim();
  const MONEY = /^\$?-?[\d,]+\.\d{2}$/;
  const DATE = /^\d{1,2}\.{1,2}\d{1,2}\.{1,2}(\d{2}|\d{4})$/;
  if (!MONEY.test(at(3))) return null;
  if (!/^(truck|trailer)$/i.test(at(6))) return null;
  if (!DATE.test(at(8))) return null;
  return {
    variant: 'B',
    vendorIdx: 0,
    transferCodeIdx: 1,
    idIdx: 2,
    amountIdx: 3,
    unitIdx: 4,
    issuedToIdx: 5,
    unitTypeIdx: 6,
    costTypeIdx: 7,
    dateIdx: 8,
    expenseSideIdx: 9,
    detailsIdx: 10,
  };
}

/** Shop-invoice summary tables (`Invoice number | Amount`, `Inv# | Inv date
 *  | Amount | Total`) share this tab. They are bulk totals, not itemised
 *  per-truck costs — SOURCE-DISCOVERY §11 flags ingesting both as a
 *  double-count risk — so they are recognized and explicitly skipped rather
 *  than misread through the cost-table column map. */
function isInvoiceSummaryHeader(cells: string[]): boolean {
  const norm = cells.map(normalizeHeaderCell);
  return norm.includes('invoice number') || (norm.includes('inv#') && norm.includes('amount'));
}

export interface ExpenseParseStats {
  sourceRowsTotal: number;
  tableSectionsFound: number;
  alignmentRowsSeen: number;
  nonCostHeaderRowsSeen: number;
  rowsEmitted: number;
  rowsSkipped: number;
  skippedByReason: Record<string, number>;
  chargedToCounts: Record<ChargedTo, number>;
  unitTypeCounts: Record<UnitType, number>;
  categoryGroupCounts: Record<CategoryGroupHint, number>;
  underReviewCount: number;
  flaggedDateCount: number;
  /** Sections parsed without a header, by matching a known variant's shape. */
  headerlessSectionsAdopted: number;
}

export interface ExpenseParseResult {
  status: 'parsed' | 'failed';
  parseError: string | null;
  rows: StagingRow[];
  stats: ExpenseParseStats;
}

export function sniffExpensesDocument(text: string): boolean {
  return tokenizeTable(text).some((row) => detectExpenseHeader(row.cells) !== null);
}

function emptyStats(sourceRowsTotal: number): ExpenseParseStats {
  return {
    sourceRowsTotal,
    tableSectionsFound: 0,
    alignmentRowsSeen: 0,
    nonCostHeaderRowsSeen: 0,
    rowsEmitted: 0,
    rowsSkipped: 0,
    skippedByReason: {},
    chargedToCounts: { company: 0, driver: 0, unknown: 0 },
    unitTypeCounts: { truck: 0, trailer: 0, unknown: 0 },
    categoryGroupCounts: { toll: 0, maintenance: 0 },
    underReviewCount: 0,
    flaggedDateCount: 0,
    headerlessSectionsAdopted: 0,
  };
}

export function parseExpensesDocument(text: string, documentId: string): ExpenseParseResult {
  const allRows = tokenizeTable(text);
  if (allRows.length === 0) {
    return {
      status: 'failed',
      parseError: 'No pipe-delimited table rows found; this does not look like the expenses sheet export.',
      rows: [],
      stats: emptyStats(0),
    };
  }

  let currentSchema: ExpenseColumnMap | null = null;
  let inCostTable = false;
  let schemaWasInferred = false;
  let headerlessSectionsAdopted = 0;
  let sectionsFound = 0;
  let alignmentRowsSeen = 0;
  let nonCostHeaderRowsSeen = 0;
  const rows: StagingRow[] = [];
  const skippedByReason: Record<string, number> = {};
  const bump = (reason: string): void => {
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
  };

  for (const { cells, lineNumber, isAlignment } of allRows) {
    if (isAlignment) {
      // A new table starts here. Do not keep trusting a header seen before
      // this line — real data has a section (an inter-company settlement
      // table pasted into this tab) whose header text was blanked out but
      // whose column count changed anyway. Require a fresh header match.
      currentSchema = null;
      inCostTable = false;
      schemaWasInferred = false;
      alignmentRowsSeen += 1;
      continue;
    }

    const headerMap = detectExpenseHeader(cells);
    if (headerMap) {
      currentSchema = headerMap;
      inCostTable = true;
      schemaWasInferred = false;
      sectionsFound += 1;
      continue;
    }

    if (isInvoiceSummaryHeader(cells)) {
      inCostTable = false;
      currentSchema = null;
      schemaWasInferred = false;
      nonCostHeaderRowsSeen += 1;
      continue;
    }

    if (!currentSchema || !inCostTable) {
      // The section's header may simply be missing from the export. Adopt it
      // from the row's own shape if it unmistakably matches a known variant,
      // and remember that it was inferred so every row it produces is held
      // for review.
      const inferred = inferHeaderlessVariantB(cells);
      if (inferred) {
        currentSchema = inferred;
        inCostTable = true;
        schemaWasInferred = true;
        sectionsFound += 1;
        headerlessSectionsAdopted += 1;
      } else {
        bump('outside_recognized_cost_table');
        continue;
      }
    }

    if (isBlankRow(cells)) {
      bump('blank_row');
      continue;
    }

    // Section/date/year marker rows interleaved with data (`| 01.04.26 | | |
    // ... |`, `| 2023 | | | ... |`): every cell but the first is blank. A
    // genuine line item always has at least an amount elsewhere too, so
    // checking this before the amount lets the stats say *why* a row with no
    // amount was skipped, instead of lumping it in with `blank_amount`.
    if (cells.slice(1).every((c) => c.trim() === '')) {
      bump('section_marker');
      continue;
    }

    const amountRaw = cellAt(cells, currentSchema.amountIdx);
    if (!amountRaw) {
      bump('blank_amount');
      continue;
    }

    const vendorRaw = currentSchema.vendorIdx >= 0 ? cellAt(cells, currentSchema.vendorIdx) : '';
    if (vendorRaw.trim().toLowerCase().startsWith('total')) {
      bump('total_row');
      continue;
    }

    const { amount, hasDollarSign } = parseExpenseAmount(amountRaw);
    if (!hasDollarSign) {
      // Stray total-fragment rows carry bare numbers with no `$`
      // (`| 33,387.15 | $33,387.15 | ... |`) in the amount slot.
      bump('amount_missing_dollar_sign');
      continue;
    }
    if (amount === null) {
      bump('unparseable_amount');
      continue;
    }

    const unitRaw = cellAt(cells, currentSchema.unitIdx);
    const issuedToRaw = cellAt(cells, currentSchema.issuedToIdx);
    const unitTypeRawCell = cellAt(cells, currentSchema.unitTypeIdx);
    const costTypeRaw = cellAt(cells, currentSchema.costTypeIdx);
    const dateRawCell = cellAt(cells, currentSchema.dateIdx);
    const expenseSideRawCell = cellAt(cells, currentSchema.expenseSideIdx);
    const detailsRaw = cellAt(cells, currentSchema.detailsIdx);
    const transferCodeRaw = currentSchema.transferCodeIdx >= 0 ? cellAt(cells, currentSchema.transferCodeIdx) : '';
    const idRaw = currentSchema.idIdx >= 0 ? cellAt(cells, currentSchema.idIdx) : '';

    const unitType = normalizeUnitType(unitTypeRawCell);
    const chargedTo = normalizeChargedTo(expenseSideRawCell);
    const date = parseExpenseDate(dateRawCell);
    const issuedTo = extractIssuedToSignals(issuedToRaw);
    const categoryText = costTypeRaw || detailsRaw || null;
    const categoryGroup = classifyCategoryGroup([vendorRaw, costTypeRaw, detailsRaw]);
    const entityHint = extractEntityHint(detailsRaw || null);

    const reviewReasons: string[] = [];
    if (schemaWasInferred) {
      // The column meanings came from the row's shape, not from a header this
      // section actually carried. Every such row waits for a person, however
      // clean it looks.
      reviewReasons.push('schema:inferred_from_row_shape(section header missing from the export)');
    }
    if (date.flagged) reviewReasons.push(`date:${date.reason ?? 'unknown'}("${dateRawCell}")`);
    if (chargedTo.value === 'unknown') {
      reviewReasons.push(`chargedTo:unrecognized_value("${expenseSideRawCell}")`);
    }
    if (unitType.value === 'unknown') {
      reviewReasons.push(`unitType:unrecognized_value("${unitTypeRawCell}")`);
    }

    const status: StagingStatus = reviewReasons.length > 0 ? 'under_review' : 'parsed';

    const stagingRow: StagingRow = {
      stagingRowId: randomUUID(),
      documentId,
      rowIndex: rows.length,
      sourcePage: null,
      parsedPayload: {
        sourceLine: lineNumber,
        tableVariant: currentSchema.variant,
        vendorRaw: vendorRaw || null,
        transferCodeRaw: transferCodeRaw || null,
        idRaw: idRaw || null,
        amountRaw,
        unitRaw: unitRaw || null,
        issuedToRaw: issuedToRaw || null,
        extractedTruckNumber: issuedTo.truckNumberCandidate,
        extractedDriverNameText: issuedTo.nameCandidate,
        unitTypeRaw: unitTypeRawCell || null,
        unitType: unitType.value,
        costTypeRaw: costTypeRaw || null,
        dateRaw: dateRawCell,
        expenseSideRaw: expenseSideRawCell || null,
        chargedTo: chargedTo.value,
        detailsRaw: detailsRaw || null,
        categoryGroupHint: categoryGroup,
        categoryText,
        entityHint,
      },
      reviewedPayload: null,
      entityId: null,
      truckId: null,
      driverId: null,
      accrualDate: date.iso,
      categoryId: null,
      amount,
      quantity: null,
      jurisdiction: null,
      status,
      reviewNotes: reviewReasons.length > 0 ? reviewReasons.join('; ') : null,
    };

    rows.push(stagingRow);
  }

  if (sectionsFound === 0) {
    return {
      status: 'failed',
      parseError:
        'No expense cost-table header ("$ used" + "Issued To") found anywhere in the document.',
      rows: [],
      stats: emptyStats(allRows.length),
    };
  }

  const stats = emptyStats(allRows.length);
  stats.tableSectionsFound = sectionsFound;
  stats.alignmentRowsSeen = alignmentRowsSeen;
  stats.nonCostHeaderRowsSeen = nonCostHeaderRowsSeen;
  stats.headerlessSectionsAdopted = headerlessSectionsAdopted;
  stats.rowsEmitted = rows.length;
  stats.skippedByReason = skippedByReason;
  stats.rowsSkipped = Object.values(skippedByReason).reduce((a, b) => a + b, 0);
  for (const row of rows) {
    const payload = row.parsedPayload as { chargedTo: ChargedTo; unitType: UnitType; categoryGroupHint: CategoryGroupHint };
    stats.chargedToCounts[payload.chargedTo] += 1;
    stats.unitTypeCounts[payload.unitType] += 1;
    stats.categoryGroupCounts[payload.categoryGroupHint] += 1;
    if (row.status === 'under_review') stats.underReviewCount += 1;
    if (row.accrualDate === null) stats.flaggedDateCount += 1;
  }

  return { status: 'parsed', parseError: null, rows, stats };
}
