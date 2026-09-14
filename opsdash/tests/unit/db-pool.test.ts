import { describe, expect, it } from 'vitest';
import { types } from 'pg';
import '@/db/pool';

describe('the money path across the database boundary', () => {
  it('returns NUMERIC as a string, never a JS number', () => {
    // 1700 = NUMERIC. If this ever parses to a number, every exact decimal
    // in the ledger silently becomes an IEEE double and the reconciliation
    // guarantees this build rests on stop being true.
    const parse = types.getTypeParser(1700);
    const out = parse('1879.98');
    expect(typeof out).toBe('string');
    expect(out).toBe('1879.98');
  });

  it('keeps precision that a float would destroy', () => {
    const parse = types.getTypeParser(1700);
    // 0.1 + 0.2 !== 0.3 in binary floating point; as text it is exact.
    expect(parse('0.30')).toBe('0.30');
    expect(parse('78959.21')).toBe('78959.21');
  });

  it('returns INT8 as a string, so large ids do not lose digits', () => {
    const parse = types.getTypeParser(20);
    expect(parse('9007199254740993')).toBe('9007199254740993');
  });
});
