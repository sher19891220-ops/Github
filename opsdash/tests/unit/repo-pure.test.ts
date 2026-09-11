/**
 * Pure-logic unit tests for the persistence layer — no database required, so
 * these run under `npm run check` like everything else in tests/unit. The
 * DB-backed behavior (commit atomicity/idempotency, staging edits, NUMERIC
 * round-trips) is proven against a real Postgres in tests/integration/**.
 */
import { describe, expect, it } from 'vitest';
import type { StagingRowRecord } from '@/db/repo/types';
import { toWireStagingRow } from '@/db/repo/mappers';
import { isTextDecodable, parseByDocType } from '@/db/repo/parseByDocType';

function baseRecord(overrides: Partial<StagingRowRecord> = {}): StagingRowRecord {
  return {
    stagingRowId: 'row-1',
    documentId: 'doc-1',
    rowIndex: 0,
    sourcePage: null,
    parsedPayload: { foo: 'bar' },
    reviewedPayload: null,
    entityId: null,
    truckId: null,
    driverId: null,
    accrualDate: null,
    categoryId: null,
    amount: null,
    quantity: null,
    jurisdiction: null,
    status: 'parsed',
    reviewNotes: null,
    chargedTo: null,
    unitType: null,
    unitNumber: null,
    committedEntryId: null,
    ...overrides,
  };
}

describe('toWireStagingRow', () => {
  it('strips internal-only columns so the response matches the fixed StagingRow contract exactly', () => {
    const record = baseRecord({ chargedTo: 'driver', unitType: 'truck', unitNumber: '50174', committedEntryId: 'entry-1' });
    const wire = toWireStagingRow(record);
    expect(wire).not.toHaveProperty('chargedTo');
    expect(wire).not.toHaveProperty('unitType');
    expect(wire).not.toHaveProperty('unitNumber');
    expect(wire).not.toHaveProperty('committedEntryId');
    // Nothing else was dropped or renamed along the way.
    expect(wire.stagingRowId).toBe('row-1');
    expect(wire.parsedPayload).toEqual({ foo: 'bar' });
  });

  it('never touches parsedPayload — same reference back out', () => {
    const payload = { immutable: true };
    const record = baseRecord({ parsedPayload: payload });
    expect(toWireStagingRow(record).parsedPayload).toBe(payload);
  });
});

describe('parseByDocType', () => {
  it('routes "ifta_mileage" to the mileage parser', () => {
    // This used to assert "no parser implemented". DATA-CONTRACT.md §7's
    // blocking open item — miles by state have no source — is closed.
    const result = parseByDocType(
      'ifta_mileage',
      [
        'DEMO CARRIER LLC',
        'IFTA by Vehicles: 1',
        '2026-04-01 - 2026-06-30',
        'Vehicle: 1001 (1AAAAAAAAAAAAAAA1)',
        'Seq State Miles',
        '1 OH 1,200.50',
        'Total 1,200.50',
      ].join('\n'),
      'doc-1',
    );
    expect(result.status).toBe('parsed');
    if (result.status === 'parsed') {
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ jurisdiction: 'OH', quantity: '1200.50', amount: null });
    }
  });

  it('fails an ifta_mileage document that carries no vehicle mileage', () => {
    // An empty parse is a failed parse, not a document with zero miles —
    // zero miles in a quarter is a claim, and no parser should make it.
    const result = parseByDocType('ifta_mileage', 'anything', 'doc-1');
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toMatch(/no vehicle mileage/);
  });

  it('fails clearly for an unrecognized doc_type rather than guessing a parser', () => {
    const result = parseByDocType('not-a-real-type', 'anything', 'doc-1');
    expect(result.status).toBe('failed');
  });

  it('routes "revenue" to the dispatch parser', () => {
    const result = parseByDocType('revenue', '', 'doc-1');
    // Empty text fails the dispatch parser's own "empty input" check —
    // proves this really is the dispatch parser, not a stub.
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toMatch(/empty/i);
  });
});

describe('isTextDecodable', () => {
  it('accepts text/* mime types', () => {
    expect(isTextDecodable('text/plain', 'sheet.txt')).toBe(true);
    expect(isTextDecodable('text/csv', 'sheet')).toBe(true);
  });

  it('accepts common text-like extensions even with a generic mime type', () => {
    expect(isTextDecodable('application/octet-stream', 'export.csv')).toBe(true);
    expect(isTextDecodable('application/octet-stream', 'export.tsv')).toBe(true);
  });

  it('rejects binary formats this build has no extraction step for', () => {
    expect(isTextDecodable('application/pdf', 'invoice.pdf')).toBe(false);
    expect(isTextDecodable('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'book.xlsx')).toBe(false);
  });
});
