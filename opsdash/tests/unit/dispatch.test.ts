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
    expect(extractEntityMarker('A Driver XTRACK')).toBe('XTRACK');
  });

  it('extracts a slash-separated marker', () => {
    expect(extractEntityMarker('Jacky Aulibrice / AFG')).toBe('AFG');
  });

  it('extracts a parenthetical marker', () => {
    expect(extractEntityMarker('Gumiriza Cedrick  (Xtrack)')).toBe('XTRACK');
  });

  it('returns null when no marker is present — never defaults to Zone', () => {
    expect(extractEntityMarker('A Driver Name')).toBeNull();
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
    // has 337 — two rows in the oldest week block carry "30%" in the
    // Payment column instead of CPM/LO/OO. They are still genuine
    // truck-week rows with a real driver and a real Gross total, so they
    // must not be silently dropped; mapDriverClass reports them as
    // 'unassigned'.
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
    // Identified by the defect itself rather than by its truck number:
    // this repository is public, and the property under test is "the row
    // whose Gross is a spreadsheet error", not "this particular truck".
    expect(failure?.truckNumber.trim()).not.toBe('');
  });

  it('posts no entry at all for a no-load truck-week (all seven days are OFF / not-ready)', () => {
    // Selected by the property, not by a truck number: a week whose own
    // Gross cell reads $0.00. There is at least one in the real file —
    // every day OFF / "Truck is not ready".
    const noLoadWeek = result.truckWeeks.find(
      (tw) => tw.grossRaw.replace(/\s/g, '') === '$0.00',
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
    // One real truck-week has two days written up as "stuck" with no
    // amount, and five days that earned. Found by that shape rather than
    // by naming the truck or its driver.
    const rowsByLine = new Map<number, typeof result.rows>();
    for (const r of result.rows) {
      const line = (r.parsedPayload as Record<string, unknown>).sourceLineNumber as number;
      rowsByLine.set(line, [...(rowsByLine.get(line) ?? []), r]);
    }
    const fiveDayWeek = [...rowsByLine.values()].find(
      (rows) =>
        rows.length === 5 &&
        !rows.some((r) => (r.parsedPayload as Record<string, unknown>).dayLabel === 'Sat') &&
        !rows.some((r) => (r.parsedPayload as Record<string, unknown>).dayLabel === 'Sun'),
    );
    // A blank day contributes no row at all — it is not posted as $0.00,
    // which would read as "this truck earned nothing that day" rather
    // than "nobody wrote anything down".
    expect(fiveDayWeek).toBeDefined();
  });

  it('leaves entity null for the ~95% of rows with no free-text marker', () => {
    // The same truck number is reused across weeks with different
    // drivers, some marked and some not, so this pins to one source line
    // rather than to a truck. Line 5 is unmarked in the real file.
    const unmarked = result.rows.filter(
      (r) => (r.parsedPayload as Record<string, unknown>).sourceLineNumber === 5,
    );
    expect(unmarked.length).toBeGreaterThan(0);
    for (const row of unmarked) {
      expect(row.entityId).toBeNull();
    }
    // And the claim in the test's name: the overwhelming majority carry
    // no marker at all.
    const withEntity = result.rows.filter((r) => r.entityId !== null);
    expect(withEntity.length / result.rows.length).toBeLessThan(0.1);
  });

  it('extracts entity only where the sheet actually marks it', () => {
    // Found by the marker, not by the truck it happens to sit on.
    const afgRows = result.rows.filter((r) => r.entityId === 'AFG');
    expect(afgRows.length).toBeGreaterThan(0);
    // Every marked row's own text carries the marker — the parser never
    // spreads an entity from one row onto its neighbours.
    for (const row of afgRows) {
      const payload = row.parsedPayload as Record<string, unknown>;
      expect(String(payload.entityMarkerRaw ?? '')).toMatch(/afg/i);
    }
  });

  it('never resolves truckId/driverId by string match — identity resolution is deferred', () => {
    for (const row of result.rows) {
      expect(row.truckId).toBeNull();
      expect(row.driverId).toBeNull();
    }
  });

  it('reads the miles column as a quantity even when it carries a stray "$"', () => {
    // Somewhere in the real file a day reads "$2,200.00 | $590.00" — the
    // second figure is miles, formatted like money by mistake. Found by
    // that shape rather than by naming the truck or its driver.
    const rows = result.rows.filter(
      (r) => (r.parsedPayload as Record<string, unknown>).milesRaw?.toString().includes('$'),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // The stray dollar sign is stripped from the quantity, never
      // carried into it and never mistaken for a second amount.
      expect(row.quantity).toMatch(/^\d+(\.\d+)?$/);
    }
  });

  it('carries a bare integer amount with no "$" the same as a formatted one', () => {
    const bare = result.rows.filter((r) => {
      const raw = (r.parsedPayload as Record<string, unknown>).amountRaw;
      return typeof raw === 'string' && raw.trim() !== '' && !raw.includes('$');
    });
    expect(bare.length).toBeGreaterThan(0);
    for (const row of bare) {
      expect(row.amount).toMatch(/^-?\d+\.\d{2}$/);
    }
  });

  it('flags an unrecognized Payment value as unassigned and under_review, without dropping the row', () => {
    const row = result.rows.find((r) => (r.parsedPayload as Record<string, unknown>).paymentRaw === '30%');
    expect(row).toBeDefined();
    expect((row?.parsedPayload as Record<string, unknown>).driverClass).toBe('unassigned');
    expect(row?.status).toBe('under_review');
    expect(row?.reviewNotes).toMatch(/30%/);
  });
});
