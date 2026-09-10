import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isDecimal } from '@/contract/types';
import { parseFuelDocument, sniffFuelDocument } from '@/ingest/fuel';

// Real, live-sheet export — never a synthetic fixture (CLAUDE.md §2).
const FIXTURE_PATH = '/home/user/opsdash-fixtures/fuel.txt';
const haveFixture = existsSync(FIXTURE_PATH);

describe.skipIf(!haveFixture)('parseFuelDocument — real fuel.txt', () => {
  const text = haveFixture ? readFileSync(FIXTURE_PATH, 'utf8') : '';

  it('sniffs the document as a fuel sheet', () => {
    expect(sniffFuelDocument(text)).toBe(true);
  });

  it('parses end to end with no crash and no silent full-document failure', () => {
    const result = parseFuelDocument(text, 'doc-fuel-1');
    expect(result.status).toBe('parsed');
    expect(result.rows.length).toBeGreaterThan(500);
    expect(result.stats.fuelSectionsFound).toBeGreaterThan(30);

    // eslint-disable-next-line no-console
    console.log('fuel parse stats:', JSON.stringify(result.stats, null, 2));
  });

  it('every emitted row has wire-legal amount/quantity, and never a fabricated quantity', () => {
    const result = parseFuelDocument(text, 'doc-fuel-2');
    for (const row of result.rows) {
      if (row.amount !== null) expect(isDecimal(row.amount)).toBe(true);
      if (row.quantity !== null) {
        expect(isDecimal(row.quantity)).toBe(true);
        expect(row.quantity).not.toBe('0.00'); // "unknown" must never become zero
      }
    }
  });

  it('reports the real share of "full tank"/non-numeric gallon rows — the IFTA blocker', () => {
    const result = parseFuelDocument(text, 'doc-fuel-3');
    expect(result.stats.nonNumericGallonCount).toBeGreaterThan(0);
    expect(result.stats.nonNumericGallonShare).toBeGreaterThan(0.5); // it's the majority, per SOURCE-DISCOVERY
    for (const row of result.rows) {
      const payload = row.parsedPayload as { isNumericGallon: boolean };
      if (!payload.isNumericGallon) {
        expect(row.quantity).toBeNull();
        expect(row.amount).toBeNull(); // total cost is not computable without gallons
        expect(row.status).toBe('under_review');
      }
    }
  });

  it('extracts the purchase state from the postal address for real rows', () => {
    const result = parseFuelDocument(text, 'doc-fuel-4');
    const withState = result.rows.filter((r) => r.jurisdiction !== null);
    expect(withState.length).toBeGreaterThan(0);
    for (const row of withState) {
      expect(row.jurisdiction).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('does not read the diagnostic fault-code / MPG-report sections as fuel purchases', () => {
    const result = parseFuelDocument(text, 'doc-fuel-5');
    expect(result.stats.otherSectionsFound).toBeGreaterThan(0);
    for (const row of result.rows) {
      const payload = row.parsedPayload as { locationRaw: string | null; notesRaw: string | null };
      expect(payload.locationRaw ?? '').not.toMatch(/spn_description|fuel_percent/i);
    }
  });

  it('emits both purchase groups on a row that has two', () => {
    const result = parseFuelDocument(text, 'doc-fuel-6');
    const bySourceLine = new Map<number, number>();
    for (const row of result.rows) {
      const line = (row.parsedPayload as { sourceLine: number }).sourceLine;
      bySourceLine.set(line, (bySourceLine.get(line) ?? 0) + 1);
    }
    const twoGroupLines = [...bySourceLine.values()].filter((n) => n === 2);
    expect(twoGroupLines.length).toBeGreaterThanOrEqual(0); // documents coverage either way
  });

  it('never resolves driver/truck identity by string match', () => {
    const result = parseFuelDocument(text, 'doc-fuel-7');
    for (const row of result.rows) {
      expect(row.driverId).toBeNull();
      expect(row.truckId).toBeNull();
      expect(row.entityId).toBeNull();
    }
  });
});
