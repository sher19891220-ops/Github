import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isDecimal, isIsoDate } from '@/contract/types';
import { parseExpensesDocument, sniffExpensesDocument } from '@/ingest/expenses';
import { parseExpenseDate } from '@/ingest/expenses/dates';

// Real, live-sheet export. Never a synthetic fixture — see CLAUDE.md §2 and
// docs/SOURCE-DISCOVERY.md, which are quoted from this exact file.
const FIXTURE_PATH = '/home/user/opsdash-fixtures/expenses.txt';
const haveFixture = existsSync(FIXTURE_PATH);

describe.skipIf(!haveFixture)('parseExpensesDocument — real expenses.txt', () => {
  const text = haveFixture ? readFileSync(FIXTURE_PATH, 'utf8') : '';

  it('sniffs the document as an expenses sheet', () => {
    expect(sniffExpensesDocument(text)).toBe(true);
  });

  it('parses end to end with no crash and no silent full-document failure', () => {
    const result = parseExpensesDocument(text, 'doc-expenses-1');
    expect(result.status).toBe('parsed');
    expect(result.rows.length).toBeGreaterThan(500);

    // eslint-disable-next-line no-console
    console.log('expenses parse stats:', JSON.stringify(result.stats, null, 2));
  });

  it('every emitted row has a wire-legal amount and, when present, an ISO date', () => {
    const result = parseExpensesDocument(text, 'doc-expenses-2');
    for (const row of result.rows) {
      expect(isDecimal(row.amount)).toBe(true);
      if (row.accrualDate !== null) expect(isIsoDate(row.accrualDate)).toBe(true);
    }
  });

  it('extracts chargedTo, and finds real driver-charged rows (lease-to-own margin)', () => {
    const result = parseExpensesDocument(text, 'doc-expenses-3');
    expect(result.stats.chargedToCounts.company).toBeGreaterThan(0);
    expect(result.stats.chargedToCounts.driver).toBeGreaterThan(0);
    // The real sheet also carries values that are neither ("Iron Lease exp",
    // "STL exp", "?", blank) — these must come back `unknown`, never a
    // silent default to `company`.
    expect(result.stats.chargedToCounts.unknown).toBeGreaterThan(0);
  });

  it('extracts unitType and defaults to unknown, never truck, when absent', () => {
    const result = parseExpensesDocument(text, 'doc-expenses-4');
    expect(result.stats.unitTypeCounts.truck).toBeGreaterThan(0);
    expect(result.stats.unitTypeCounts.trailer).toBeGreaterThan(0);
    expect(result.stats.unitTypeCounts.unknown).toBeGreaterThan(0);

    const missingUnitType = result.rows.filter(
      (r) => (r.parsedPayload as { unitTypeRaw: string | null }).unitTypeRaw === null,
    );
    expect(missingUnitType.length).toBeGreaterThan(0);
    for (const row of missingUnitType) {
      expect((row.parsedPayload as { unitType: string }).unitType).toBe('unknown');
    }
  });

  it('categorizes exact "Toll violations" vendor rows as toll, not maintenance', () => {
    const result = parseExpensesDocument(text, 'doc-expenses-5');
    const tollRows = result.rows.filter(
      (r) => (r.parsedPayload as { vendorRaw: string | null }).vendorRaw?.toLowerCase() === 'toll violations',
    );
    expect(tollRows.length).toBeGreaterThan(0);
    for (const row of tollRows) {
      expect((row.parsedPayload as { categoryGroupHint: string }).categoryGroupHint).toBe('toll');
    }
  });

  it('flags ambiguous/invalid dates for review rather than silently fixing them', () => {
    const result = parseExpensesDocument(text, 'doc-expenses-6');
    expect(result.stats.flaggedDateCount).toBeGreaterThan(0);
    const flagged = result.rows.filter((r) => r.accrualDate === null);
    for (const row of flagged) {
      expect(row.status).toBe('under_review');
      expect(row.reviewNotes).toMatch(/date:/);
    }
  });

  it('never reads a "total:" row or a bare section-marker row as a line item', () => {
    const result = parseExpensesDocument(text, 'doc-expenses-7');
    const suspicious = result.rows.filter((r) => {
      const p = r.parsedPayload as { vendorRaw: string | null };
      return p.vendorRaw?.toLowerCase().startsWith('total') ?? false;
    });
    expect(suspicious.length).toBe(0);
    expect(result.stats.skippedByReason.section_marker ?? 0).toBeGreaterThan(0);
    // The one literal "total:" row in the real sheet sits inside a
    // headerless inter-company settlement table (SOURCE-DISCOVERY §11) that
    // is excluded entirely rather than misread through a stale header.
    expect(result.stats.skippedByReason.outside_recognized_cost_table ?? 0).toBeGreaterThan(0);
  });

  it('excludes the inter-company Truck Max settlement table rather than double-counting it as a repair cost', () => {
    const result = parseExpensesDocument(text, 'doc-expenses-9');
    const settlementRows = result.rows.filter((r) => {
      const p = r.parsedPayload as { detailsRaw: string | null; costTypeRaw: string | null };
      return (p.detailsRaw ?? '').includes('Rent yard') || (p.costTypeRaw ?? '') === 'invoice';
    });
    expect(settlementRows.length).toBe(0);
  });

  it('picks up the literal entity code recycled into some rows\' Details column, as a hint only', () => {
    const result = parseExpensesDocument(text, 'doc-expenses-10');
    const withHint = result.rows.filter(
      (r) => (r.parsedPayload as { entityHint: string | null }).entityHint !== null,
    );
    expect(withHint.length).toBeGreaterThan(0);
    for (const row of withHint) {
      // A hint informs the review step; it never resolves entityId itself.
      expect(row.entityId).toBeNull();
    }
  });

  it('never resolves driver/truck identity by string match — only raw signals are emitted', () => {
    const result = parseExpensesDocument(text, 'doc-expenses-8');
    for (const row of result.rows) {
      expect(row.driverId).toBeNull();
      expect(row.truckId).toBeNull();
      expect(row.entityId).toBeNull();
    }
  });
});

/**
 * Two defects the real sheet carries that a header-driven parser misses.
 * Both were found by replaying the live export, not by reading the code.
 */
describe('parseExpenseDate — a cost cannot be incurred in the future', () => {
  const AS_OF = new Date('2026-09-12T00:00:00Z');

  it('takes a well-formed past date literally and does not flag it', () => {
    const got = parseExpenseDate('02.18.25', AS_OF);
    expect(got).toEqual({ iso: '2025-02-18', raw: '02.18.25', flagged: false, reason: null });
  });

  it('flags a drag-filled year that lands in the future', () => {
    // The live sheet has eight consecutive interior-detailing rows at the same
    // price dated 02.18.25 through 02.18.32 — Excel incremented the year
    // instead of the day. The past ones are indistinguishable from real dates;
    // these are not, and six of them were posting before this guard.
    for (const raw of ['02.18.27', '02.18.30', '02.18.32']) {
      const got = parseExpenseDate(raw, AS_OF);
      expect(got.flagged).toBe(true);
      expect(got.reason).toBe('future_date');
      // Flagged for review, never silently dropped or rewritten.
      expect(got.iso).not.toBeNull();
    }
  });

  it('keeps the shape complaint when a date is both nonstandard and future', () => {
    const got = parseExpenseDate('02.18.2030', AS_OF);
    expect(got.flagged).toBe(true);
    expect(got.reason).toBe('nonstandard_date_format+future_date');
  });

  it('does not flag today itself', () => {
    expect(parseExpenseDate('09.12.26', AS_OF).flagged).toBe(false);
  });
});

describe.skipIf(!haveFixture)('a cost section whose header the export blanked out', () => {
  const text = haveFixture ? readFileSync(FIXTURE_PATH, 'utf8') : '';

  it('adopts it from the row shape rather than discarding hundreds of cost rows', () => {
    const result = parseExpensesDocument(text, 'doc-expenses-headerless');
    // The live export has a 420-row block of variant-B cost rows — Penske and
    // Ryder tolls, parking violations, a Samsara subscription — whose header
    // survived only as a stray "Date" in one cell.
    expect(result.stats.headerlessSectionsAdopted).toBeGreaterThan(0);
    expect(result.rows.length).toBeGreaterThan(1700);
  });

  it('holds every inferred-schema row for review, however clean it looks', () => {
    const result = parseExpensesDocument(text, 'doc-expenses-headerless-2');
    const inferred = result.rows.filter((r) =>
      (r.reviewNotes ?? '').includes('schema:inferred_from_row_shape'),
    );
    expect(inferred.length).toBeGreaterThan(0);
    for (const row of inferred) expect(row.status).toBe('under_review');
  });

  it('still refuses the settlement table pasted into the same tab', () => {
    // It also carries money at index 3 and a date at index 8, so only the
    // `truck`/`trailer` check at index 6 keeps it out. Its running-balance
    // columns would double-count if summed.
    const result = parseExpensesDocument(text, 'doc-expenses-headerless-3');
    for (const row of result.rows) {
      const p = row.parsedPayload as Record<string, unknown>;
      expect(String(p.unitTypeRaw ?? '').toLowerCase()).not.toMatch(/^(invoice|paid|unpaid)$/);
      expect(String(p.vendorRaw ?? '').toLowerCase()).not.toMatch(/^(invoice|paid)$/);
    }
  });
});
