/**
 * The header guard.
 *
 * Migration 002 wrote down why this has to exist: a column inserted into
 * the operator's sheet shifts every amount one place and a naive sync
 * reports success. These tests are that scenario, plus the one that is
 * worse because it is invisible — a pure reorder, where every column is
 * still present and every value now lands in the wrong field.
 */
import { describe, expect, it } from 'vitest';
import {
  describeChange,
  extractHeader,
  headerChecksum,
  normalizeHeader,
  verifyHeader,
} from '@/ingest/sheets/header';

const EXPENSES = '| Unit | Issued To | Unit Type | Cost type | Date | $ used | Expense side | Details |';
const DISPATCH = '|Dispatcher|Truck #|Payment|Driver Names|Gross|Miles|RPM';

describe('extractHeader', () => {
  it('reads both export shapes this codebase actually parses', () => {
    expect(extractHeader(`${EXPENSES}\n| 5852 | D | truck |`)).toEqual([
      'unit', 'issued to', 'unit type', 'cost type', 'date', '$ used', 'expense side', 'details',
    ]);
    expect(extractHeader(`${DISPATCH}\nrow`)).toEqual([
      'dispatcher', 'truck #', 'payment', 'driver names', 'gross', 'miles', 'rpm',
    ]);
  });

  it('skips blank and title lines rather than mistaking one for a header', () => {
    const withPreamble = `\n\nTruck and trailer expenses 2026\n\n${EXPENSES}\n| 1 |`;
    expect(extractHeader(withPreamble)?.[0]).toBe('unit');
  });

  it('returns null when nothing looks like a header', () => {
    // The caller must treat this as "refuse to sync", never as "no columns".
    expect(extractHeader('')).toBeNull();
    expect(extractHeader('just a note\n\nanother note')).toBeNull();
  });
});

describe('normalizeHeader', () => {
  it('treats tidying as not a layout change', () => {
    // An operator fixing capitalisation or double spaces must not break a
    // sync; only the set and order of columns is layout.
    expect(normalizeHeader('| Unit |  Issued   To |')).toEqual(normalizeHeader('|unit|Issued To|'));
  });

  it('drops the empty cells a pipe table has at both ends', () => {
    expect(normalizeHeader('| a | b |')).toEqual(['a', 'b']);
  });
});

describe('verifyHeader', () => {
  it('accepts a first sync and hands back the checksum to store', () => {
    const v = verifyHeader(`${EXPENSES}\nrow`, null, null);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.firstSync).toBe(true);
      expect(v.checksum).toHaveLength(64);
    }
  });

  it('accepts an unchanged sheet', () => {
    const header = extractHeader(EXPENSES)!;
    const v = verifyHeader(`${EXPENSES}\nrow`, headerChecksum(header), header);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.firstSync).toBe(false);
  });

  it('refuses a sheet with a column inserted, and says which', () => {
    const before = extractHeader(EXPENSES)!;
    const shifted = '| Unit | Issued To | Unit Type | Cost type | Date | Vendor | $ used | Expense side | Details |';

    const v = verifyHeader(`${shifted}\nrow`, headerChecksum(before), before);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      // This is the scenario migration 002's comment describes: without the
      // guard, "$ used" is now read from the "Vendor" column.
      expect(v.reason).toMatch(/added "vendor"/i);
      expect(v.reason).toMatch(/nothing was synced/i);
    }
  });

  it('refuses a sheet with a column removed, and says which', () => {
    const before = extractHeader(EXPENSES)!;
    const missing = '| Unit | Issued To | Unit Type | Cost type | Date | $ used | Details |';
    const v = verifyHeader(`${missing}\nrow`, headerChecksum(before), before);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/removed "expense side"/i);
  });

  it('catches a pure reorder — the dangerous one, because it looks fine', () => {
    const before = extractHeader(EXPENSES)!;
    const reordered = '| Unit | Issued To | Unit Type | Cost type | Date | Expense side | $ used | Details |';

    const v = verifyHeader(`${reordered}\nrow`, headerChecksum(before), before);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toMatch(/same columns in a different order/i);
      expect(v.reason).toMatch(/wrong field/i);
    }
  });

  it('refuses an export with no header at all', () => {
    const v = verifyHeader('no table here', 'a'.repeat(64), ['unit']);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/refusing to guess/i);
  });
});

describe('headerChecksum', () => {
  it('is order-sensitive — that is the whole point', () => {
    expect(headerChecksum(['a', 'b'])).not.toBe(headerChecksum(['b', 'a']));
  });

  it('is stable across calls', () => {
    expect(headerChecksum(['a', 'b'])).toBe(headerChecksum(['a', 'b']));
  });

  it('does not collide on a boundary shift', () => {
    // 'a b' + 'c' must not hash the same as 'a' + 'b c'.
    expect(headerChecksum(['a b', 'c'])).not.toBe(headerChecksum(['a', 'b c']));
  });
});

describe('describeChange', () => {
  it('reports an addition and a removal together', () => {
    const msg = describeChange(['a', 'b'], ['a', 'c']);
    expect(msg).toMatch(/added "c"/);
    expect(msg).toMatch(/removed "b"/);
  });
});
