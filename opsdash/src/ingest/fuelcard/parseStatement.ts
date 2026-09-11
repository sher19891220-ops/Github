/**
 * The fuel-card statement parser — EFS, Relay, and whatever else the
 * operator's cards produce.
 *
 * `docs/SOURCE-DISCOVERY.md` §3 is blunt about why this exists: the Fuel
 * Google Sheet records `"full tank"` instead of a quantity on 97.5% of its
 * rows, so it knows *where* fuel was bought and not *how much*. Card
 * statements are not a preferred source of IFTA gallons, they are the only
 * source.
 *
 * Built without a sample of the operator's own statement, and that shapes
 * the design rather than being an excuse: columns are matched by meaning
 * (`columns.ts`), the delimiter is sniffed (`delimited.ts`), and when a
 * required column is missing the parser reports **the header it actually
 * read and which roles it could not fill**. An operator who drops a
 * statement gets a diagnosis, not "parse failed".
 *
 * Three refusals, each of which a plausible parser gets wrong:
 *
 *  - **Gallons only count as IFTA diesel when the product says diesel.**
 *    DEF, reefer, and gasoline all arrive priced per gallon on the same
 *    invoice. See `product.ts` — this is the rule with the most money
 *    behind it.
 *  - **An unreadable quantity is null, never zero.** Zero gallons claims no
 *    fuel was bought. Null says nobody knows.
 *  - **A statement's own total is a checksum.** If the document states one,
 *    the parsed lines must add to it, and a disagreement is reported rather
 *    than being resolved in the parser's favour.
 */
import { randomUUID } from 'node:crypto';
import type { StagingRow } from '@/contract/types';
import { headerScore, mapColumns, missingRequiredRoles, type ColumnMap } from './columns';
import { readTable, splitDelimited, type DelimitedRow } from './delimited';
import { classifyProduct, type FuelProductKind } from './product';
import {
  centsOf,
  moneyOf,
  parseJurisdiction,
  parseMoney,
  parseQuantity,
  parseStatementDate,
  parseUnitPrice,
} from './values';

export type CardVendor = 'efs' | 'relay' | 'wex' | 'comdata' | 'unknown';

/** What `parsedPayload` carries on every statement row. Named rather than
 *  implied, because the review screen and the IFTA read both read it. */
export interface FuelCardPayload {
  kind: 'fuel_card';
  vendor: CardVendor;
  sourceLine: number;
  invoice: string | null;
  unitRaw: string | null;
  driverRaw: string | null;
  cardRaw: string | null;
  locationRaw: string | null;
  productRaw: string | null;
  productKind: FuelProductKind;
  /** The one question the IFTA engine asks of a fuel row. */
  countsAsIftaDiesel: boolean;
  productReason: string;
  unitPrice: string | null;
  /** Set when the statement showed a gross amount and a discount, so the
   *  saving stays visible rather than vanishing into the net. */
  amountGross: string | null;
  discount: string | null;
  /** True when the transaction date column was absent and the post date
   *  was used instead — a different date, and near a quarter boundary a
   *  different quarter. */
  usedPostDate: boolean;
}

export interface FuelCardStats {
  totalRows: number;
  /** Rows whose gallons will reach the IFTA engine. */
  iftaDieselRows: number;
  iftaDieselGallons: string;
  byProduct: Record<FuelProductKind, number>;
  /** Diesel rows with gallons but no jurisdiction — real fuel that can
   *  earn no tax-paid credit. */
  dieselMissingJurisdiction: number;
  /** Diesel rows with a jurisdiction but no readable quantity. */
  dieselMissingQuantity: number;
  netAmountTotal: string;
}

export type FuelCardParseResult =
  | {
      status: 'parsed';
      vendor: CardVendor;
      header: string[];
      columnMap: ColumnMap;
      unmappedColumns: string[];
      rows: StagingRow[];
      stats: FuelCardStats;
      problems: string[];
    }
  | { status: 'failed'; error: string; header?: string[]; unmappedColumns?: string[] };

/* --------------------------------------------------------------------- */

const VENDOR_MARKERS: ReadonlyArray<{ vendor: CardVendor; re: RegExp }> = [
  { vendor: 'efs', re: /\befs\b|electronic\s+funds\s+source|\befs\s*llc\b/i },
  { vendor: 'relay', re: /\brelay\b|relay\s*payments|pilot\s*flying\s*j/i },
  { vendor: 'wex', re: /\bwex\b|wright\s*express/i },
  { vendor: 'comdata', re: /\bcomdata\b|\bfleetcor\b/i },
];

export function detectVendor(text: string): CardVendor {
  // Only the masthead: "EFS" appears as a payment-method word deep inside
  // the operator's own expense sheets, and matching it there would label a
  // Relay statement as EFS.
  const head = text.split(/\r?\n/).slice(0, 25).join('\n');
  for (const m of VENDOR_MARKERS) if (m.re.test(head)) return m.vendor;
  return 'unknown';
}

/**
 * True for a subtotal, grand-total or carried-forward line.
 *
 * These sit *inside* the table and split to the same width as the header,
 * so width alone does not exclude them — and a totals line read as a
 * transaction adds the whole statement to itself a second time. Detected
 * by the words vendors print in them, and by the absence of a date: a real
 * transaction always has one.
 */
function isTotalsRow(cells: readonly string[], hasDate: boolean): boolean {
  if (hasDate) return false;
  const joined = cells.join(' ');
  return /\b(grand\s+total|sub\s*-?\s*total|total|balance\s+(due|forward)|carried\s+forward|page\s+total)\b/i.test(
    joined,
  );
}

/** Finds a stated grand total on a line the table reader set aside. */
function findStatedTotal(
  offWidth: readonly DelimitedRow[],
  inWidthTotals: readonly DelimitedRow[],
  rawText: string,
): string | null {
  const candidates: string[] = [];
  for (const row of offWidth) candidates.push(row.cells.join(' '));
  for (const row of inWidthTotals) candidates.push(row.cells.join(' '));
  for (const line of rawText.split(/\r?\n/)) {
    if (/\b(grand\s+total|total\s+(amount|billed|due|charges)|statement\s+total)\b/i.test(line)) {
      candidates.push(line);
    }
  }
  for (const line of candidates) {
    if (!/\b(grand\s+total|total\s+(amount|billed|due|charges)|statement\s+total)\b/i.test(line)) continue;
    const monies = [...line.matchAll(/\(?-?\$?[\d,]+\.\d{2}\)?-?/g)].map((m) => parseMoney(m[0]));
    const valid = monies.filter((m): m is string => m !== null);
    if (valid.length > 0) return valid[valid.length - 1]!;
  }
  return null;
}

export function parseFuelCardStatement(rawText: string, documentId: string): FuelCardParseResult {
  const vendor = detectVendor(rawText);
  const table = readTable(rawText, headerScore);

  if (table === null) {
    return {
      status: 'failed',
      error:
        'No transaction table was found in this document. A fuel-card statement needs a row of column ' +
        'headings (date, product, quantity, amount) with the transactions under it.',
    };
  }

  const { map, unmapped, ambiguous } = mapColumns(table.header);
  const missing = missingRequiredRoles(map);
  if (missing.length > 0) {
    return {
      status: 'failed',
      error:
        `The transaction table is missing ${missing.join(' and ')}. ` +
        `The columns read on line ${table.headerLineNumber} were: ${table.header.filter((h) => h.trim() !== '').join(' | ')}. ` +
        'Either this is not the transaction table, or the column is named something this parser does not recognise yet.',
      header: table.header,
      unmappedColumns: unmapped,
    };
  }

  const problems: string[] = [];
  for (const a of ambiguous) {
    problems.push(
      `More than one column looks like "${a.role}": ${a.headers.join(', ')}. The first was used.`,
    );
  }
  if (map.transactionDate === undefined && map.postDate !== undefined) {
    problems.push(
      'This statement has no transaction-date column, so the post date was used. Those differ, and a ' +
        'purchase made near the end of a quarter can post in the next one — check the dates on any row ' +
        'close to a quarter boundary before filing IFTA from it.',
    );
  }
  if (map.state === undefined && map.location === undefined && map.city === undefined) {
    problems.push(
      'No state, location or city column: no purchase jurisdiction can be read, so none of these gallons ' +
        'can earn an IFTA tax-paid credit. They will still post as fuel cost.',
    );
  }
  if (map.quantity === undefined) {
    problems.push(
      'No quantity column: this statement carries cost but no gallons, so it cannot supply IFTA gallons — ' +
        'which is the reason card statements are ingested at all.',
    );
  }
  if (map.amountNet === undefined && map.amountGross !== undefined) {
    problems.push(
      'Only a gross/retail amount column was found. If this statement applies a discount, the cost ' +
        'recorded here is higher than what was actually billed.',
    );
  }

  const at = (cells: readonly string[], role: keyof ColumnMap): string => {
    const i = map[role];
    if (i === undefined) return '';
    return (cells[i] ?? '').trim();
  };

  const rows: StagingRow[] = [];
  const byProduct: Record<FuelProductKind, number> = {
    diesel: 0, def: 0, reefer: 0, gasoline: 0, non_fuel: 0, unknown: 0,
  };
  let dieselGallonsHundredths = 0n;
  let netCents = 0n;
  let iftaDieselRows = 0;
  let dieselMissingJurisdiction = 0;
  let dieselMissingQuantity = 0;
  const usedPostDate = map.transactionDate === undefined;
  const inWidthTotals: DelimitedRow[] = [];

  for (const row of table.rows) {
    const dateCell = usedPostDate ? at(row.cells, 'postDate') : at(row.cells, 'transactionDate');
    const parsedDate = parseStatementDate(dateCell);

    const amountRaw = at(row.cells, 'amountNet') || at(row.cells, 'amountGross');
    const amount = parseMoney(amountRaw);

    // A totals line sits inside the table at the header's own width, so
    // nothing structural excludes it — and read as a transaction it adds
    // the whole statement to itself a second time. It is set aside here
    // and used as the checksum below, which is what it is for.
    if (isTotalsRow(row.cells, parsedDate.iso !== null)) {
      inWidthTotals.push(row);
      continue;
    }

    // A line with neither a date nor an amount is a page header repeated
    // mid-table, or blank padding — not a transaction.
    if (parsedDate.iso === null && amount === null) continue;

    if (parsedDate.problem !== null) {
      problems.push(`Line ${row.lineNumber}: ${parsedDate.problem}`);
    }

    const productRaw = at(row.cells, 'product');
    const product = classifyProduct(productRaw);
    byProduct[product.kind] += 1;

    const quantity = map.quantity === undefined ? null : parseQuantity(at(row.cells, 'quantity'));
    const jurisdiction = parseJurisdiction(at(row.cells, 'state'), at(row.cells, 'location') || at(row.cells, 'city'));

    if (product.kind === 'diesel') {
      if (quantity === null) dieselMissingQuantity += 1;
      else if (jurisdiction === null) dieselMissingJurisdiction += 1;
    }

    // Gallons reach the ledger only for diesel. Everything else posts its
    // money with `quantity: null` — the row is real, its gallons are not
    // IFTA gallons, and a null says that without losing the cost.
    const ledgerQuantity = product.countsAsIftaDiesel ? quantity : null;
    if (ledgerQuantity !== null) {
      iftaDieselRows += 1;
      dieselGallonsHundredths += BigInt(ledgerQuantity.replace('.', '').replace('-', '')) *
        (ledgerQuantity.startsWith('-') ? -1n : 1n);
    }
    if (amount !== null) netCents += centsOf(amount);

    const payload: FuelCardPayload = {
      kind: 'fuel_card',
      vendor,
      sourceLine: row.lineNumber,
      invoice: at(row.cells, 'invoice') || null,
      unitRaw: at(row.cells, 'unit') || null,
      driverRaw: at(row.cells, 'driver') || null,
      cardRaw: at(row.cells, 'cardNumber') || null,
      locationRaw: at(row.cells, 'location') || at(row.cells, 'city') || null,
      productRaw: productRaw || null,
      productKind: product.kind,
      countsAsIftaDiesel: product.countsAsIftaDiesel,
      productReason: product.reason,
      unitPrice: parseUnitPrice(at(row.cells, 'unitPrice')),
      amountGross: parseMoney(at(row.cells, 'amountGross')),
      discount: parseMoney(at(row.cells, 'discount')),
      usedPostDate,
    };

    // Fuel is a cost: money out is negative, matching the ledger's sign
    // convention. A statement prints the charge as a positive number, so
    // it is flipped here — but a credit already printed negative flips to
    // positive, which is correct: a refund is money in.
    const signedAmount = amount === null ? null : moneyOf(-centsOf(amount));

    const notes: string[] = [];
    if (product.kind !== 'diesel' && quantity !== null) {
      notes.push(
        `${quantity} gallons of ${productRaw || 'an unnamed product'} are NOT IFTA diesel gallons. ${product.reason}`,
      );
    }
    if (product.kind === 'diesel' && jurisdiction === null) {
      notes.push('Diesel with no readable purchase state — these gallons can earn no tax-paid credit.');
    }
    if (parsedDate.problem !== null) notes.push(parsedDate.problem);

    rows.push({
      stagingRowId: randomUUID(),
      documentId,
      rowIndex: rows.length,
      sourcePage: null,
      parsedPayload: payload as unknown as Record<string, unknown>,
      reviewedPayload: null,
      entityId: null,
      truckId: null,
      driverId: null,
      accrualDate: parsedDate.iso,
      categoryId: product.kind === 'non_fuel' ? null : 'fuel.diesel',
      amount: signedAmount,
      quantity: ledgerQuantity,
      jurisdiction,
      // A row a human should look at: something about it is unresolved.
      status:
        notes.length > 0 || parsedDate.iso === null || amount === null ? 'under_review' : 'parsed',
      reviewNotes: notes.length > 0 ? notes.join(' ') : null,
    });
  }

  if (rows.length === 0) {
    return {
      status: 'failed',
      error:
        `A transaction table was found on line ${table.headerLineNumber}, but no line under it parsed as a ` +
        'transaction. Every row was missing both a date and an amount.',
      header: table.header,
      unmappedColumns: unmapped,
    };
  }

  // The statement's own total, as a checksum — the same discipline the IFTA
  // mileage report allows. A disagreement is reported, never reconciled by
  // adjusting the parsed lines to match.
  const stated = findStatedTotal(table.offWidthLines, inWidthTotals, rawText);
  if (stated !== null) {
    const statedCents = centsOf(stated);
    if (statedCents !== netCents) {
      problems.push(
        `The lines read here add to ${moneyOf(netCents)} but the statement states a total of ${stated} ` +
          `(a difference of ${moneyOf(statedCents - netCents)}). Some of the statement did not parse, or a ` +
          'fee or adjustment sits outside the transaction table.',
      );
    }
  }

  if (byProduct.unknown > 0) {
    problems.push(
      `${byProduct.unknown} line${byProduct.unknown === 1 ? '' : 's'} name a product this parser does not ` +
        'recognise. Their gallons are withheld from IFTA rather than assumed to be diesel — check them on the review queue.',
    );
  }
  if (dieselMissingJurisdiction > 0) {
    problems.push(
      `${dieselMissingJurisdiction} diesel line${dieselMissingJurisdiction === 1 ? '' : 's'} carry gallons but no ` +
        'purchase state, so they earn no tax-paid credit and make the IFTA amount owed too high, not too low.',
    );
  }

  return {
    status: 'parsed',
    vendor,
    header: table.header,
    columnMap: map,
    unmappedColumns: unmapped,
    rows,
    stats: {
      totalRows: rows.length,
      iftaDieselRows,
      iftaDieselGallons: gallonsOf(dieselGallonsHundredths),
      byProduct,
      dieselMissingJurisdiction,
      dieselMissingQuantity,
      netAmountTotal: moneyOf(netCents),
    },
    problems,
  };
}

function gallonsOf(hundredths: bigint): string {
  const neg = hundredths < 0n;
  const abs = neg ? -hundredths : hundredths;
  return `${neg && abs !== 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

export { splitDelimited };
