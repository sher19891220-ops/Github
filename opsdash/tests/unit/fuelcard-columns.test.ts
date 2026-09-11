/**
 * Column mapping, delimiter sniffing and value parsing for fuel-card
 * statements.
 *
 * Built without a sample of the operator's own statement, so the headers
 * below are the spellings the major card vendors publish rather than one
 * file's layout. That is the point of matching by meaning: the parser has
 * to survive a layout nobody here has seen, and say something useful when
 * it cannot.
 */
import { describe, expect, it } from 'vitest';
import { headerScore, mapColumns, missingRequiredRoles, normalizeHeader } from '@/ingest/fuelcard/columns';
import { sniffDelimiter, splitDelimited, readTable } from '@/ingest/fuelcard/delimited';
import {
  parseJurisdiction,
  parseMoney,
  parseQuantity,
  parseStatementDate,
  parseUnitPrice,
} from '@/ingest/fuelcard/values';

describe('normalizeHeader', () => {
  it('collapses the punctuation vendors sprinkle through column names', () => {
    expect(normalizeHeader('Tran. Date')).toBe('tran date');
    expect(normalizeHeader('UNIT_NUMBER')).toBe('unit number');
    expect(normalizeHeader('  Qty  ')).toBe('qty');
  });
});

describe('mapColumns', () => {
  it('maps a typical card-statement header', () => {
    const header = [
      'Tran Date', 'Invoice', 'Unit', 'Driver Name', 'Card Number',
      'Location Name', 'State', 'Product', 'Qty', 'Unit Price', 'Net Amount',
    ];
    const { map } = mapColumns(header);
    expect(map.transactionDate).toBe(0);
    expect(map.invoice).toBe(1);
    expect(map.unit).toBe(2);
    expect(map.driver).toBe(3);
    expect(map.cardNumber).toBe(4);
    expect(map.location).toBe(5);
    expect(map.state).toBe(6);
    expect(map.product).toBe(7);
    expect(map.quantity).toBe(8);
    expect(map.unitPrice).toBe(9);
    expect(map.amountNet).toBe(10);
  });

  it('maps the same facts under entirely different names', () => {
    const header = ['Transaction Date', 'Vehicle #', 'Merchant City', 'ST', 'Item Description', 'Gallons', 'Amount'];
    const { map } = mapColumns(header);
    expect(map.transactionDate).toBe(0);
    expect(map.unit).toBe(1);
    expect(map.city).toBe(2);
    expect(map.state).toBe(3);
    expect(map.product).toBe(4);
    expect(map.quantity).toBe(5);
    expect(map.amountNet).toBe(6);
  });

  it('prefers the transaction date over the post date', () => {
    // The two differ, and a purchase on 31 March posting on 2 April
    // belongs in Q1 but would file in Q2.
    const { map } = mapColumns(['Post Date', 'Tran Date', 'Amount']);
    expect(map.postDate).toBe(0);
    expect(map.transactionDate).toBe(1);
  });

  it('prefers the net amount over the gross, because net is what was billed', () => {
    // Taking gross overstates fuel cost by the whole discount, on every
    // line — and the discount is the reason the card exists.
    const { map } = mapColumns(['Retail Amount', 'Discount', 'Net Amount']);
    expect(map.amountGross).toBe(0);
    expect(map.discount).toBe(1);
    expect(map.amountNet).toBe(2);
  });

  it('does not let "Discount Amount" steal the amount role', () => {
    const { map } = mapColumns(['Tran Date', 'Discount Amount', 'Amount']);
    expect(map.amountNet).toBe(2);
    expect(map.discount).toBe(1);
  });

  it('gives one column at most one role', () => {
    const { map } = mapColumns(['Date', 'Amount']);
    expect(map.transactionDate).toBe(0);
    expect(map.postDate).toBeUndefined();
  });

  it('reports two columns competing for one role rather than silently picking', () => {
    const { map, ambiguous } = mapColumns(['Qty', 'Gallons', 'Tran Date', 'Amount']);
    expect(map.quantity).toBe(0);
    expect(ambiguous.some((a) => a.role === 'quantity' && a.headers.length === 2)).toBe(true);
  });

  it('lists the columns it did not claim', () => {
    const { unmapped } = mapColumns(['Tran Date', 'Amount', 'Odometer', 'Pump #']);
    expect(unmapped).toContain('Odometer');
    expect(unmapped).toContain('Pump #');
  });

  it('names the required roles a header is missing', () => {
    const { map } = mapColumns(['Unit', 'Product', 'Qty']);
    expect(missingRequiredRoles(map).sort()).toEqual(['amountNet', 'transactionDate']);
  });
});

describe('headerScore', () => {
  it('scores a header above a data row that happens to match a pattern', () => {
    const header = ['Tran Date', 'Unit', 'Product', 'Qty', 'Amount'];
    const data = ['03/14/2026', '7004', 'ULSD', '118.40', '412.66'];
    expect(headerScore(header)).toBeGreaterThan(headerScore(data));
    expect(headerScore(data)).toBe(0);
  });
});

describe('splitDelimited', () => {
  it('does not break a quoted field on its own comma', () => {
    // A statement's location column contains a comma almost by
    // definition; splitting on it shifts every later column right.
    expect(splitDelimited('03/14/2026,"PILOT #123, COLUMBUS, OH",118.40', ',')).toEqual([
      '03/14/2026',
      'PILOT #123, COLUMBUS, OH',
      '118.40',
    ]);
  });

  it('understands doubled quotes', () => {
    expect(splitDelimited('a,"say ""hi""",b', ',')).toEqual(['a', 'say "hi"', 'b']);
  });

  it('drops the empty edges of a markdown pipe row', () => {
    expect(splitDelimited('| a | b | c |', '|')).toEqual(['a', 'b', 'c']);
  });
});

describe('sniffDelimiter', () => {
  it('picks tab over comma when the commas live inside prose', () => {
    const text = [
      'Date\tLocation\tAmount',
      '03/14/2026\tColumbus, OH\t412.66',
      '03/15/2026\tFishkill, NY\t388.10',
    ].join('\n');
    expect(sniffDelimiter(text)?.delimiter).toBe('\t');
  });

  it('picks comma for a real CSV', () => {
    const text = ['Date,Unit,Amount', '03/14/2026,7004,412.66', '03/15/2026,6179,388.10'].join('\n');
    const r = sniffDelimiter(text);
    expect(r?.delimiter).toBe(',');
    expect(r?.columnCount).toBe(3);
  });
});

describe('readTable', () => {
  it('finds the transaction table under a letterhead', () => {
    // Every real statement opens with an account number and a billing
    // period before the table starts. Assuming line 1 is the header reads
    // the letterhead as column names.
    const text = [
      'EFS LLC',
      'Account 99887766',
      'Billing period 03/01/2026 - 03/31/2026',
      '',
      'Tran Date,Unit,Product,Qty,Amount',
      '03/14/2026,7004,ULSD,118.40,412.66',
    ].join('\n');
    const table = readTable(text, headerScore);
    expect(table?.headerLineNumber).toBe(5);
    expect(table?.rows).toHaveLength(1);
  });

  it('keeps a line that does not match the header width rather than dropping it', () => {
    const text = [
      'Tran Date,Unit,Product,Qty,Amount',
      '03/14/2026,7004,ULSD,118.40,412.66',
      'GRAND TOTAL,412.66',
    ].join('\n');
    const table = readTable(text, headerScore);
    expect(table?.rows).toHaveLength(1);
    expect(table?.offWidthLines).toHaveLength(1);
  });
});

describe('parseStatementDate', () => {
  it('reads the formats card vendors print', () => {
    // The four-digit year is the one that bit: with the alternation
    // written `(\d{2}|\d{4})` this returned 2020-03-14, six years early,
    // on every row, with nothing about the output looking wrong.
    expect(parseStatementDate('03/14/2026').iso).toBe('2026-03-14');
    expect(parseStatementDate('3/4/26').iso).toBe('2026-03-04');
    expect(parseStatementDate('2026-03-14').iso).toBe('2026-03-14');
    expect(parseStatementDate('03-14-2026').iso).toBe('2026-03-14');
  });

  it('reports a day-first file instead of silently swapping it', () => {
    // Swapping would make the file parse and every date before the 13th
    // of a month silently wrong.
    const r = parseStatementDate('14/03/2026');
    expect(r.iso).toBeNull();
    expect(r.problem).toMatch(/day-first/);
  });

  it('rejects a date that does not exist', () => {
    expect(parseStatementDate('02/31/2026').iso).toBeNull();
    expect(parseStatementDate('02/31/2026').problem).toMatch(/Impossible/);
  });

  it('treats an empty cell as absent, not as an error', () => {
    expect(parseStatementDate('  ')).toEqual({ iso: null, problem: null });
  });
});

describe('parseMoney', () => {
  it('reads the shapes a statement prints', () => {
    expect(parseMoney('$1,234.56')).toBe('1234.56');
    expect(parseMoney('1234.5')).toBe('1234.50');
    expect(parseMoney('412.66')).toBe('412.66');
  });

  it('reads accounting parentheses as negative', () => {
    // A reversal read as a charge doubles the error: the refund gets
    // added instead of subtracted.
    expect(parseMoney('(275.00)')).toBe('-275.00');
    // Symbol outside the parenthesis, and inside it: both appear.
    expect(parseMoney('$(1,234.56)')).toBe('-1234.56');
    expect(parseMoney('( $1,234.56 )')).toBe('-1234.56');
  });

  it('reads a trailing minus as negative', () => {
    expect(parseMoney('275.00-')).toBe('-275.00');
  });

  it('returns null rather than zero for something unreadable', () => {
    expect(parseMoney('n/a')).toBeNull();
    expect(parseMoney('')).toBeNull();
  });
});

describe('parseQuantity', () => {
  it('reads gallons, with or without a unit suffix', () => {
    expect(parseQuantity('118.40')).toBe('118.40');
    expect(parseQuantity('1,118.4')).toBe('1118.40');
    expect(parseQuantity('80g')).toBe('80.00');
  });

  it('is null, never zero, for a cell it cannot read', () => {
    // Zero gallons claims no fuel was bought. Null says nobody knows.
    // The fuel sheet already taught this: 97.5% of its rows say
    // "full tank".
    expect(parseQuantity('full tank')).toBeNull();
    expect(parseQuantity('')).toBeNull();
    expect(parseQuantity('-')).toBeNull();
  });

  it('reads a reversal as negative gallons', () => {
    expect(parseQuantity('(118.40)')).toBe('-118.40');
  });
});

describe('parseUnitPrice', () => {
  it('keeps the third decimal fuel is actually priced in', () => {
    // Measured across the operator's real fuel sheet: 319 of 399 price
    // cells carry three decimals, only 79 carry two. `parseMoney` caps at
    // two because that is what a ledger amount is; a unit price keeps
    // every digit the source printed.
    expect(parseUnitPrice('3.799')).toBe('3.799');
    expect(parseUnitPrice('3.56')).toBe('3.56');
  });

  it('takes the dollar sign on either end', () => {
    // The operator's own sheets write `3.56$`; card statements write
    // `$3.56`. Both appear.
    expect(parseUnitPrice('3.799$')).toBe('3.799');
    expect(parseUnitPrice('$3.56')).toBe('3.56');
  });

  it('is null for something unreadable', () => {
    expect(parseUnitPrice('n/a')).toBeNull();
    expect(parseUnitPrice('')).toBeNull();
  });
});

describe('parseJurisdiction', () => {
  it('prefers a dedicated state column', () => {
    expect(parseJurisdiction('OH', 'anything at all')).toBe('OH');
    expect(parseJurisdiction(' oh ', '')).toBe('OH');
  });

  it('falls back to pulling a state out of a location string', () => {
    expect(parseJurisdiction('', 'PILOT #123, 4700 Groveport Rd, Columbus, OH 43207')).toBe('OH');
    expect(parseJurisdiction('', 'LOVES 456, FISHKILL NY')).toBe('NY');
  });

  it('recognises Canadian provinces, which are IFTA jurisdictions too', () => {
    expect(parseJurisdiction('ON', '')).toBe('ON');
  });

  it('does not read a gallon quantity as a state', () => {
    // Found by running this against the operator's real fuel sheet: the
    // cells "80 GA" and "50 GA" — eighty and fifty *gallons* — were read
    // as Georgia. A wrong jurisdiction moves a tax-paid credit onto the
    // wrong state's return, which is worse than finding no state at all.
    expect(parseJurisdiction('', '80 GA')).toBeNull();
    expect(parseJurisdiction('', '50 GA')).toBeNull();
    expect(parseJurisdiction('', '120.5 OH')).toBeNull();
    // A real place name before the code still resolves.
    expect(parseJurisdiction('', 'Harrisonburg, VA')).toBe('VA');
    expect(parseJurisdiction('', 'Pontoon Beach, IL')).toBe('IL');
  });

  it('returns null rather than guessing from a city name', () => {
    // Plenty of city names are shared across states, and a wrong
    // jurisdiction moves a credit to the wrong return.
    expect(parseJurisdiction('', 'Springfield')).toBeNull();
    expect(parseJurisdiction('ZZ', 'nowhere')).toBeNull();
  });
});
