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
      alignmentRowsSeen += 1;
      continue;
    }

    const headerMap = detectExpenseHeader(cells);
    if (headerMap) {
      currentSchema = headerMap;
      inCostTable = true;
      sectionsFound += 1;
      continue;
    }

    if (isInvoiceSummaryHeader(cells)) {
      inCostTable = false;
      currentSchema = null;
      nonCostHeaderRowsSeen += 1;
      continue;
    }

    if (!currentSchema || !inCostTable) {
      bump('outside_recognized_cost_table');
      continue;
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
