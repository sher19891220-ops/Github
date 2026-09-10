import { describe, expect, it } from 'vitest';
import type { StagingRow } from '@/contract/types';
import { applyEdit, blockedReason, isBlocked, missingFields, summarizeCommit } from '@/components/review/logic';

function makeRow(overrides: Partial<StagingRow> = {}): StagingRow {
  return {
    stagingRowId: 'row-1',
    documentId: 'doc-1',
    rowIndex: 1,
    sourcePage: null,
    parsedPayload: { amount: '$2,400.00', category: null },
    reviewedPayload: null,
    entityId: 'ent-zone',
    truckId: 'trk-1',
    driverId: null,
    accrualDate: '2026-01-06',
    categoryId: 'fuel.diesel',
    amount: '2400.00',
    quantity: null,
    jurisdiction: 'OH',
    status: 'parsed',
    reviewNotes: null,
    ...overrides,
  };
}

describe('a blocked row cannot commit', () => {
  it('a fully populated row is not blocked', () => {
    expect(isBlocked(makeRow())).toBe(false);
    expect(blockedReason(makeRow())).toBeNull();
  });

  it('a row missing category is blocked and says exactly why', () => {
    const row = makeRow({ categoryId: null });
    expect(isBlocked(row)).toBe(true);
    expect(missingFields(row)).toEqual(['categoryId']);
    expect(blockedReason(row)).toBe('Missing category');
  });

  it('a row missing multiple required fields names all of them', () => {
    const row = makeRow({ entityId: null, amount: null });
    expect(blockedReason(row)).toBe('Missing entity, amount');
  });

  it('truck and driver are not required — their absence never blocks commit', () => {
    const row = makeRow({ truckId: null, driverId: null });
    expect(isBlocked(row)).toBe(false);
  });

  it('summarizeCommit refuses to allow commit while any row is blocked', () => {
    const rows = [makeRow({ stagingRowId: 'r1' }), makeRow({ stagingRowId: 'r2', categoryId: null })];
    const summary = summarizeCommit(rows);
    expect(summary.blocked).toBe(1);
    expect(summary.willCommit).toBe(1);
    expect(summary.canCommit).toBe(false);
  });

  it('summarizeCommit allows commit once nothing is blocked', () => {
    const rows = [makeRow({ stagingRowId: 'r1' }), makeRow({ stagingRowId: 'r2' })];
    const summary = summarizeCommit(rows);
    expect(summary.blocked).toBe(0);
    expect(summary.willCommit).toBe(2);
    expect(summary.canCommit).toBe(true);
  });

  it('an excluded (rejected) row is not counted as blocked even if incomplete', () => {
    const rows = [makeRow({ stagingRowId: 'r1', categoryId: null, status: 'rejected' })];
    const summary = summarizeCommit(rows);
    expect(summary.blocked).toBe(0);
    expect(summary.excluded).toBe(1);
    expect(summary.canCommit).toBe(false); // nothing left to commit
  });

  it('a document with zero commitable rows cannot commit even with zero blocked', () => {
    const rows: StagingRow[] = [];
    expect(summarizeCommit(rows).canCommit).toBe(false);
  });
});

describe('an edit writes the reviewed value without destroying the original', () => {
  it('applying an edit leaves parsedPayload byte-for-byte unchanged', () => {
    const original = makeRow();
    const parsedBefore = { ...original.parsedPayload };
    const edited = applyEdit(original, { amount: '2346.00' });

    expect(edited.parsedPayload).toEqual(parsedBefore);
    // Same reference, not just equal content — applyEdit must never rebuild
    // or touch this object.
    expect(edited.parsedPayload).toBe(original.parsedPayload);
  });

  it('the edit lands in the normalized column and in reviewedPayload', () => {
    const original = makeRow();
    const edited = applyEdit(original, { amount: '2346.00' });

    expect(edited.amount).toBe('2346.00');
    expect(edited.reviewedPayload).toEqual({ amount: '2346.00' });
  });

  it('a second edit on a different field accumulates rather than replacing the first', () => {
    const original = makeRow();
    const afterFirst = applyEdit(original, { amount: '2346.00' });
    const afterSecond = applyEdit(afterFirst, { jurisdiction: 'NY' });

    expect(afterSecond.reviewedPayload).toEqual({ amount: '2346.00', jurisdiction: 'NY' });
    expect(afterSecond.amount).toBe('2346.00');
    expect(afterSecond.jurisdiction).toBe('NY');
  });

  it('does not mutate the row object it was given', () => {
    const original = makeRow();
    const snapshotAmount = original.amount;
    applyEdit(original, { amount: '999.00' });
    expect(original.amount).toBe(snapshotAmount);
    expect(original.reviewedPayload).toBeNull();
  });

  it('moves status from parsed to under_review on first edit', () => {
    const original = makeRow({ status: 'parsed' });
    const edited = applyEdit(original, { amount: '2346.00' });
    expect(edited.status).toBe('under_review');
  });

  it('never reopens a row that is already committed or rejected', () => {
    const committed = makeRow({ status: 'committed' });
    expect(applyEdit(committed, { amount: '1.00' }).status).toBe('committed');

    const rejected = makeRow({ status: 'rejected' });
    expect(applyEdit(rejected, { amount: '1.00' }).status).toBe('rejected');
  });
});
