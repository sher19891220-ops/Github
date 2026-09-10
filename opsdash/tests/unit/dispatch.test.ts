import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractEntityMarker, mapDriverClass, parseDispatchSheet } from '@/ingest/dispatch';
import { isDecimal, isIsoDate } from '@/contract/types';

// Real 2026 dispatch sheet, exported as markdown tables. Deliberately kept
// outside the repo (operator data, never committed) — see
// opsdash/docs/SOURCE-DISCOVERY.md §2 and the task brief for provenance.
const FIXTURE_PATH = '/home/user/opsdash-fixtures/dispatch2026.txt';
const fixtureText = readFileSync(FIXTURE_PATH, 'utf8');

describe('mapDriverClass', () => {
  it('maps CPM/LO/OO regardless of case or trailing whitespace', () => {
    expect(mapDriverClass('CPM')).toBe('company');
    expect(mapDriverClass('cpm')).toBe('company');
    expect(mapDriverClass('CPM ')).toBe('company');
    expect(mapDriverClass('LO')).toBe('lease_to_own');
    expect(mapDriverClass('OO')).toBe('owner_operator');
  });

  it('maps anything unrecognized to unassigned rather than guessing', () => {
    // The real sheet has two rows where this column literally reads "30%".
    expect(mapDriverClass('30%')).toBe('unassigned');
    expect(mapDriverClass('')).toBe('unassigned');
  });
});

describe('extractEntityMarker', () => {
  it('extracts a trailing suffix marker', () => {
    expect(extractEntityMarker('Friday Akoh XTRACK')).toBe('XTRACK');
  });

  it('extracts a slash-separated marker', () => {
    expect(extractEntityMarker('Jacky Aulibrice / AFG')).toBe('AFG');
  });

  it('extracts a parenthetical marker', () => {
    expect(extractEntityMarker('Gumiriza Cedrick  (Xtrack)')).toBe('XTRACK');
  });

  it('returns null when no marker is present — never defaults to Zone', () => {
    expect(extractEntityMarker('Ntsinzi Ndakenesha')).toBeNull();
    expect(extractEntityMarker('COLAS JASMIN')).toBeNull();
  });
});

describe('parseDispatchSheet — malformed input', () => {
  it('fails clearly on empty input', () => {
    const result = parseDispatchSheet('', 'doc-1');
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toMatch(/empty/i);
    }
  });

  it('fails clearly when no dispatcher table is recognizable', () => {
    const result = parseDispatchSheet('| Customer | Week days |\n| Fed EX | Tuesday |\n', 'doc-2');
    expect(result.status).toBe('failed');
  });
});

describe('parseDispatchSheet — the real 2026 sheet', () => {
  const result = parseDispatchSheet(fixtureText, 'doc-2026');

  it('parses end to end with no crash', () => {
    expect(result.status).toBe('parsed');
  });

  if (result.status !== 'parsed') throw new Error('setup: real fixture failed to parse');

  it('produces well-formed StagingRow output for every emitted row', () => {
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.documentId).toBe('doc-2026');
      expect(row.categoryId).toBe('revenue.linehaul');
      expect(isDecimal(row.amount)).toBe(true);
      if (row.quantity !== null) expect(isDecimal(row.quantity)).toBe(true);
      if (row.accrualDate !== null) expect(isIsoDate(row.accrualDate)).toBe(true);
      // Money never crosses as a JS number.
      expect(typeof row.amount).toBe('string');
    }
  });

  it('finds all 337 real truck-week rows (335 CPM/LO/OO + 2 with a stray "30%" Payment value)', () => {
    // SOURCE-DISCOVERY.md §8 reports 335 truck-week rows; the real file
    // has 337 — two rows (truck 6169 under "R/S/J/F", truck 560638 under
    // "Jacob Stone", in the oldest week block) carry "30%" in the Payment
    // column instead of CPM/LO/OO. They are still genuine truck-week rows
    // with real driver names and a real Gross total, so they must not be
    // silently dropped; mapDriverClass reports them as 'unassigned'.
    expect(result.truckWeeks.length).toBe(337);
  });

  it('reconciles 336 of 337 truck-weeks against the sheet\'s own Gross column, within one cent', () => {
    const reconciled = result.truckWeeks.filter((tw) => tw.reconciles);
    const notReconciled = result.truckWeeks.filter((tw) => !tw.reconciles);
    expect(reconciled.length).toBe(336);
    expect(notReconciled.length).toBe(1);

    // The one exception: the sheet's own Gross cell is a spreadsheet
    // formula error, not a number, so there is nothing to reconcile
    // against — this is a defect in the source data, not the parser.
    const [failure] = notReconciled;
    expect(failure?.grossRaw).toMatch(/#VALUE!/);
    expect(failure?.grossParsed).toBeNull();
    expect(failure?.truckNumber.trim()).toBe('495806');
  });

  it('posts no entry at all for a no-load truck-week (all seven days are OFF / not-ready)', () => {
    // Truck 496125, "Friday Akoh XTRACK", first occurrence: every day is
    // OFF / "Truck is not ready", Gross is $0.00 on the sheet.
    const noLoadWeek = result.truckWeeks.find(
      (tw) => tw.truckNumber.trim() === '496125' && tw.grossRaw.replace(/\s/g, '') === '$0.00',
    );
    expect(noLoadWeek).toBeDefined();
    expect(noLoadWeek?.sumOfParsedAmounts).toBe('0.00');
    expect(noLoadWeek?.reconciles).toBe(true);

    const rowsForThatLine = result.rows.filter(
      (r) => (r.parsedPayload as Record<string, unknown>).sourceLineNumber === noLoadWeek?.sourceLineNumber,
    );
    expect(rowsForThatLine).toHaveLength(0);
  });

  it('does not post a zero-revenue row for an ordinary blank day inside an otherwise active week', () => {
    // Stan Walker / truck 496123: Sat and Sun are both "Manchester, CT
    // stuck" with no amount. The truck-week still has five revenue days.
    const rowsForTruck = result.rows.filter(
      (r) => (r.parsedPayload as Record<string, unknown>).truckNumber === '496123'
        && (r.parsedPayload as Record<string, unknown>).sourceLineNumber === 5,
    );
    expect(rowsForTruck.length).toBe(5);
    expect(rowsForTruck.some((r) => (r.parsedPayload as Record<string, unknown>).dayLabel === 'Sat')).toBe(false);
    expect(rowsForTruck.some((r) => (r.parsedPayload as Record<string, unknown>).dayLabel === 'Sun')).toBe(false);
  });

  it('leaves entity null for the ~95% of rows with no free-text marker', () => {
    // Truck 496123 is reused across weeks (Stan Walker's "Ntsinzi
    // Ndakenesha" here, unmarked; a different, marked driver later in the
    // file) — pin to the specific source line to test the unmarked one.
    const unmarked = result.rows.filter(
      (r) => (r.parsedPayload as Record<string, unknown>).truckNumber === '496123'
        && (r.parsedPayload as Record<string, unknown>).sourceLineNumber === 5,
    );
    expect(unmarked.length).toBeGreaterThan(0);
    for (const row of unmarked) {
      expect(row.entityId).toBeNull();
    }
  });

  it('extracts entity only where the sheet actually marks it', () => {
    const afgRows = result.rows.filter((r) => (r.parsedPayload as Record<string, unknown>).truckNumber === '484506');
    expect(afgRows.length).toBeGreaterThan(0);
    for (const row of afgRows) {
      expect(row.entityId).toBe('AFG');
    }
  });

  it('never resolves truckId/driverId by string match — identity resolution is deferred', () => {
    for (const row of result.rows) {
      expect(row.truckId).toBeNull();
      expect(row.driverId).toBeNull();
    }
  });

  it('reads the miles column as a quantity even when it carries a stray "$"', () => {
    // Truck 8136, "Amane Omot Akane": day 1 is "$2,200.00 | $590.00" —
    // the second figure is miles, formatted like money by mistake.
    const row = result.rows.find(
      (r) => (r.parsedPayload as Record<string, unknown>).truckNumber === '8136'
        && (r.parsedPayload as Record<string, unknown>).dayLabel === 'Mon',
    );
    expect(row).toBeDefined();
    expect(row?.amount).toBe('2200.00');
    expect(row?.quantity).toBe('590');
  });

  it('carries a bare integer amount with no "$" the same as a formatted one', () => {
    const row = result.rows.find(
      (r) => (r.parsedPayload as Record<string, unknown>).truckNumber === '496123'
        && (r.parsedPayload as Record<string, unknown>).dayLabel === 'Fri',
    );
    expect(row).toBeDefined();
    expect(row?.amount).toBe('3000.00');
    expect(row?.quantity).toBe('1127');
  });

  it('flags an unrecognized Payment value as unassigned and under_review, without dropping the row', () => {
    const row = result.rows.find((r) => (r.parsedPayload as Record<string, unknown>).paymentRaw === '30%');
    expect(row).toBeDefined();
    expect((row?.parsedPayload as Record<string, unknown>).driverClass).toBe('unassigned');
    expect(row?.status).toBe('under_review');
    expect(row?.reviewNotes).toMatch(/30%/);
  });
});
