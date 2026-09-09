import { describe, expect, it } from 'vitest';
import { isDecimal, isIsoDate, type Provenance } from '@/contract/types';

describe('isDecimal — the wire boundary for money', () => {
  it('accepts signed exact decimals', () => {
    for (const v of ['0', '-812.44', '2400.00', '214.3300', '-0.0001']) {
      expect(isDecimal(v)).toBe(true);
    }
  });

  it('rejects JS numbers, which is the whole point', () => {
    expect(isDecimal(812.44)).toBe(false);
    expect(isDecimal(0.1 + 0.2)).toBe(false);
  });

  it('rejects exponent notation, NaN and empty strings', () => {
    for (const v of ['1e3', 'NaN', 'Infinity', '', ' 12.00', '12.00 ', '--1']) {
      expect(isDecimal(v)).toBe(false);
    }
  });

  it('rejects more precision than the ledger stores', () => {
    expect(isDecimal('1.00000')).toBe(false);
  });
});

describe('isIsoDate', () => {
  it('accepts real calendar dates', () => {
    expect(isIsoDate('2026-01-15')).toBe(true);
    expect(isIsoDate('2024-02-29')).toBe(true);
  });

  it('rejects dates that do not exist', () => {
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2025-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
  });

  it('rejects non-ISO shapes', () => {
    expect(isIsoDate('01/15/2026')).toBe(false);
    expect(isIsoDate('2026-1-5')).toBe(false);
  });
});

describe('Provenance', () => {
  it('makes an untraceable figure unrepresentable', () => {
    // Each variant carries its origin; there is no member without one.
    const cases: Provenance[] = [
      { kind: 'document', sourceDocumentId: 'doc-1', stagingRowId: 'row-1' },
      { kind: 'connector', connectorPullId: 'pull-1' },
      { kind: 'derived', calcRunId: 'run-1' },
      { kind: 'adjustment', reversesEntryId: 'entry-1' },
    ];
    expect(cases.map((c) => c.kind)).toEqual([
      'document', 'connector', 'derived', 'adjustment',
    ]);
  });
});
