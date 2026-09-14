import { randomUUID } from 'node:crypto';
import type { StagingRow, StagingStatus } from '@/contract/types';
import { cellAt, isBlankRow, normalizeHeaderCell, tokenizeTable } from './table';
import { parseGallons, parsePricePerGallon, computeFuelCost } from './money';
import { extractPurchaseState } from './location';

/**
 * The Fuel sheet, sniffed and parsed. Column order is NOT stable across
 * sections of the same tab (some insert `Speed` and `Fault Code`, one late
 * section swaps `Driver`/`Percentage` and the trailing `Notes`/`Agent`
 * pair) — every column is located by name inside each newly-detected
 * header, never assumed to sit at a fixed index.
 *
 * Each row can carry TWO real purchases (`Location 1`/`Gallon`/`Price` and
 * `Location 2`/`Gallon`/`Price`) — both are emitted as separate rows when
 * present.
 */

interface FuelColumnMap {
  unitIdx: number;
  driverIdx: number;
  location1Idx: number;
  gallon1Idx: number;
  price1Idx: number;
  agent1Idx: number;
  location2Idx: number;
  gallon2Idx: number;
  price2Idx: number;
  agent2Idx: number;
  notesIdx: number;
}

function findAfter(norm: string[], name: string, from: number, before: number): number {
  const end = before === -1 ? norm.length : before;
  for (let i = from + 1; i < end; i++) {
    if (norm[i] === name) return i;
  }
  return -1;
}

/** A row is treated as a fuel-purchase header when it names `Unit`,
 *  `Driver`, `Gallon` and `Price` columns — regardless of what else is
 *  mixed in (`Speed`, `Fault Code`, `Discount`, ...) or what order they
 *  come in. Anything that doesn't clear this bar is some other report
 *  sharing the tab (a diagnostics/fault-code dump, a différently-shaped
 *  weekly summary) and is never read as fuel-purchase data. */
function detectFuelHeader(cells: string[]): FuelColumnMap | null {
  const norm = cells.map(normalizeHeaderCell);
  const hasGallon = norm.includes('gallon');
  const hasPrice = norm.includes('price');
  const hasDriver = norm.includes('driver');
  const hasUnit = norm.includes('unit');
  if (!hasGallon || !hasPrice || !hasDriver || !hasUnit) return null;

  const unitIdx = norm.indexOf('unit');
  const driverIdx = norm.indexOf('driver');
  const location2Idx = norm.findIndex((c) => c === 'location 2');
  const location1Idx = norm.findIndex((c) => c === 'location 1' || c === 'location');

  const gallon1Idx = location1Idx >= 0 ? findAfter(norm, 'gallon', location1Idx, location2Idx) : norm.indexOf('gallon');
  const price1Idx = gallon1Idx >= 0 ? findAfter(norm, 'price', gallon1Idx, location2Idx) : -1;
  const agent1Idx = price1Idx >= 0 ? findAfter(norm, 'agent', price1Idx, location2Idx) : -1;

  const gallon2Idx = location2Idx >= 0 ? findAfter(norm, 'gallon', location2Idx, -1) : -1;
  const price2Idx = gallon2Idx >= 0 ? findAfter(norm, 'price', gallon2Idx, -1) : -1;
  const agent2Idx = price2Idx >= 0 ? findAfter(norm, 'agent', price2Idx, -1) : -1;

  const notesIdx = norm.lastIndexOf('notes');

  return {
    unitIdx,
    driverIdx,
    location1Idx,
    gallon1Idx,
    price1Idx,
    agent1Idx,
    location2Idx,
    gallon2Idx,
    price2Idx,
    agent2Idx,
    notesIdx,
  };
}

/** Some rows are a spreadsheet-formula artifact, not data (`| name |
 *  #VALUE! | #VALUE! | ... |`, immediately following certain headers inside
 *  an otherwise-real fuel section). Matched on the `#VALUE!` marker alone —
 *  NOT on the first cell reading "name", which is also the first cell of a
 *  genuine (non-fuel) diagnostic table header a few lines away, and must
 *  still reach `looksLikeOtherHeader` below. */
function isFormulaArtifactRow(cells: string[]): boolean {
  return cells.some((c) => c.includes('#VALUE!'));
}

/** A row counts as "some other header" (diagnostics, a differently-shaped
 *  report) when it isn't a fuel header but still reads like a header —
 *  recognized by exact-cell vocabulary matches, never a substring, so a
 *  real address or note cannot false-positive. */
const OTHER_HEADER_VOCAB = new Set([
  'name', 'fuel_percent', 'speed_mph', 'spn_description', 'unit number', 'average without discount',
  'average with discount', 'actual amount', 'discount amount', 'mpg', 'milage', 'fuel used',
  'fuel purchuased', 'idle time (%) ▲', 'retail price ($)', 'disc price ($ )', 'avg ppu ($)',
  'retail amt ($)', 'disc amt ($)',
]);

function looksLikeOtherHeader(cells: string[]): boolean {
  const norm = cells.map(normalizeHeaderCell);
  const hits = norm.filter((c) => OTHER_HEADER_VOCAB.has(c)).length;
  return hits >= 2;
}

type SectionKind = 'fuel' | 'other' | null;

export interface FuelParseStats {
  sourceRowsTotal: number;
  fuelSectionsFound: number;
  otherSectionsFound: number;
  alignmentRowsSeen: number;
  purchaseGroupsConsidered: number;
  rowsEmitted: number;
  rowsSkipped: number;
  skippedByReason: Record<string, number>;
  /** How many emitted rows could not resolve a numeric gallon quantity
   *  (almost always the literal "full tank"). This is the number that
   *  determines whether this sheet can feed IFTA gallons-by-state at all —
   *  SOURCE-DISCOVERY §3 says it can't, and this is the measurement. */
  nonNumericGallonCount: number;
  nonNumericGallonShare: number;
  jurisdictionMissingCount: number;
  underReviewCount: number;
}

export interface FuelParseResult {
  status: 'parsed' | 'failed';
  parseError: string | null;
  rows: StagingRow[];
  stats: FuelParseStats;
}

export function sniffFuelDocument(text: string): boolean {
  return tokenizeTable(text).some((row) => detectFuelHeader(row.cells) !== null);
}

function emptyStats(sourceRowsTotal: number): FuelParseStats {
  return {
    sourceRowsTotal,
    fuelSectionsFound: 0,
    otherSectionsFound: 0,
    alignmentRowsSeen: 0,
    purchaseGroupsConsidered: 0,
    rowsEmitted: 0,
    rowsSkipped: 0,
    skippedByReason: {},
    nonNumericGallonCount: 0,
    nonNumericGallonShare: 0,
    jurisdictionMissingCount: 0,
    underReviewCount: 0,
  };
}

interface PurchaseGroup {
  group: 1 | 2;
  locationRaw: string;
  gallonRaw: string;
  priceRaw: string;
  agentRaw: string;
}

function extractGroup(
  cells: string[],
  group: 1 | 2,
  locIdx: number,
  galIdx: number,
  priceIdx: number,
  agentIdx: number,
): PurchaseGroup | null {
  if (galIdx < 0 && priceIdx < 0) return null; // header didn't define this group at all
  const locationRaw = locIdx >= 0 ? cellAt(cells, locIdx) : '';
  const gallonRaw = galIdx >= 0 ? cellAt(cells, galIdx) : '';
  const priceRaw = priceIdx >= 0 ? cellAt(cells, priceIdx) : '';
  const agentRaw = agentIdx >= 0 ? cellAt(cells, agentIdx) : '';
  const hasPurchase = gallonRaw.trim() !== '' || priceRaw.trim() !== '';
  if (!hasPurchase) return null; // no financial event on this row for this group
  return { group, locationRaw, gallonRaw, priceRaw, agentRaw };
}

export function parseFuelDocument(text: string, documentId: string): FuelParseResult {
  const allRows = tokenizeTable(text);
  if (allRows.length === 0) {
    return {
      status: 'failed',
      parseError: 'No pipe-delimited table rows found; this does not look like the Fuel sheet export.',
      rows: [],
      stats: emptyStats(0),
    };
  }

  let currentSchema: FuelColumnMap | null = null;
  let sectionKind: SectionKind = null;
  let fuelSectionsFound = 0;
  let otherSectionsFound = 0;
  let alignmentRowsSeen = 0;
  let purchaseGroupsConsidered = 0;
  const rows: StagingRow[] = [];
  const skippedByReason: Record<string, number> = {};
  const bump = (reason: string): void => {
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
  };

  for (const { cells, lineNumber, isAlignment } of allRows) {
    if (isAlignment) {
      currentSchema = null;
      sectionKind = null;
      alignmentRowsSeen += 1;
      continue;
    }

    if (isFormulaArtifactRow(cells)) {
      bump('formula_artifact_row');
      continue;
    }

    const fuelHeader = detectFuelHeader(cells);
    if (fuelHeader) {
      currentSchema = fuelHeader;
      sectionKind = 'fuel';
      fuelSectionsFound += 1;
      continue;
    }

    if (looksLikeOtherHeader(cells)) {
      currentSchema = null;
      sectionKind = 'other';
      otherSectionsFound += 1;
      continue;
    }

    if (sectionKind !== 'fuel' || !currentSchema) {
      // `outside_recognized_table` also catches a real defect measured in
      // the live sheet: at least one section's alignment row is followed
      // directly by data with no header row at all (its header text was
      // deleted but the table structure — and a genuinely different column
      // count, an inserted `Speed` reading) was left behind). Reusing the
      // last-seen header across that boundary would silently misread a
      // diagnostic speed value as a price or a location; per "parse by
      // header, never by index", we decline instead of guessing, at the
      // cost of losing those rows until the next real header appears.
      bump(sectionKind === 'other' ? 'non_fuel_section' : 'outside_recognized_table');
      continue;
    }

    if (isBlankRow(cells)) {
      bump('blank_row');
      continue;
    }

    const unitRaw = cellAt(cells, currentSchema.unitIdx);
    const driverRaw = cellAt(cells, currentSchema.driverIdx);

    const groups = [
      extractGroup(cells, 1, currentSchema.location1Idx, currentSchema.gallon1Idx, currentSchema.price1Idx, currentSchema.agent1Idx),
      extractGroup(cells, 2, currentSchema.location2Idx, currentSchema.gallon2Idx, currentSchema.price2Idx, currentSchema.agent2Idx),
    ].filter((g): g is PurchaseGroup => g !== null);

    purchaseGroupsConsidered += groups.length;

    if (groups.length === 0) {
      bump('no_purchase_this_row');
      continue;
    }

    const notesRaw = currentSchema.notesIdx >= 0 ? cellAt(cells, currentSchema.notesIdx) : '';

    for (const group of groups) {
      const gallons = parseGallons(group.gallonRaw);
      const pricePerGallon = parsePricePerGallon(group.priceRaw);
      const jurisdiction = extractPurchaseState(group.locationRaw);

      let amount: string | null = null;
      if (gallons.isNumeric && gallons.quantity !== null && pricePerGallon !== null) {
        amount = `-${computeFuelCost(gallons.quantity, pricePerGallon)}`;
      }

      const reviewReasons: string[] = [];
      if (!gallons.isNumeric) {
        reviewReasons.push(`quantity:non_numeric_gallon("${group.gallonRaw}")`);
      }
      if (jurisdiction === null) {
        reviewReasons.push(`jurisdiction:no_state_extracted_from_location("${group.locationRaw}")`);
      }
      if (gallons.isNumeric && pricePerGallon === null) {
        reviewReasons.push(`amount:unparseable_price("${group.priceRaw}")`);
      }

      const status: StagingStatus = reviewReasons.length > 0 ? 'under_review' : 'parsed';

      const stagingRow: StagingRow = {
        stagingRowId: randomUUID(),
        documentId,
        rowIndex: rows.length,
        sourcePage: null,
        parsedPayload: {
          sourceLine: lineNumber,
          purchaseGroup: group.group,
          unitRaw: unitRaw || null,
          driverRaw: driverRaw || null,
          locationRaw: group.locationRaw || null,
          gallonRaw: group.gallonRaw || null,
          priceRaw: group.priceRaw || null,
          pricePerGallon,
          agentRaw: group.agentRaw || null,
          notesRaw: notesRaw || null,
          isNumericGallon: gallons.isNumeric,
        },
        reviewedPayload: null,
        entityId: null,
        truckId: null,
        driverId: null,
        accrualDate: null, // this sheet carries no per-purchase date column
        categoryId: null,
        amount,
        quantity: gallons.quantity,
        jurisdiction,
        status,
        reviewNotes: reviewReasons.length > 0 ? reviewReasons.join('; ') : null,
      };

      rows.push(stagingRow);
    }
  }

  if (fuelSectionsFound === 0) {
    return {
      status: 'failed',
      parseError: 'No fuel-purchase header (Unit + Driver + Gallon + Price) found anywhere in the document.',
      rows: [],
      stats: emptyStats(allRows.length),
    };
  }

  const stats = emptyStats(allRows.length);
  stats.fuelSectionsFound = fuelSectionsFound;
  stats.otherSectionsFound = otherSectionsFound;
  stats.alignmentRowsSeen = alignmentRowsSeen;
  stats.purchaseGroupsConsidered = purchaseGroupsConsidered;
  stats.rowsEmitted = rows.length;
  stats.skippedByReason = skippedByReason;
  stats.rowsSkipped = Object.values(skippedByReason).reduce((a, b) => a + b, 0);
  for (const row of rows) {
    const payload = row.parsedPayload as { isNumericGallon: boolean };
    if (!payload.isNumericGallon) stats.nonNumericGallonCount += 1;
    if (row.jurisdiction === null) stats.jurisdictionMissingCount += 1;
    if (row.status === 'under_review') stats.underReviewCount += 1;
  }
  stats.nonNumericGallonShare = rows.length > 0 ? stats.nonNumericGallonCount / rows.length : 0;

  return { status: 'parsed', parseError: null, rows, stats };
}
