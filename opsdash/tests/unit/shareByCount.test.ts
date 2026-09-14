/**
 * An allocation that loses a cent is worse than no allocation: the P&L stops
 * tying to the ledger and nobody can tell which half is wrong.
 */
import { describe, expect, it } from 'vitest';
import { shareByCount } from '@/engines/allocate/shareByCount';

const sum = (xs: ReadonlyArray<{ cents: number }>) => xs.reduce((s, x) => s + x.cents, 0);

describe('shareByCount', () => {
  it('splits by weight and the parts sum to the whole exactly', () => {
    const got = shareByCount(-5039728, [
      { key: 'XTRACK', weight: 39 },
      { key: 'ZONE', weight: 31 },
      { key: 'AFG', weight: 4 },
    ]);
    expect(sum(got)).toBe(-5039728);
    expect(got.map((g) => g.key).sort()).toEqual(['AFG', 'XTRACK', 'ZONE']);
  });

  it('hands the odd pennies out largest-remainder, never dropping them', () => {
    // 100 split 1/1/1 cannot divide evenly; someone must get the extra cent.
    const got = shareByCount(-100, [
      { key: 'A', weight: 1 },
      { key: 'B', weight: 1 },
      { key: 'C', weight: 1 },
    ]);
    expect(sum(got)).toBe(-100);
    expect(got.map((g) => Math.abs(g.cents)).sort((a, b) => a - b)).toEqual([33, 33, 34]);
  });

  it('is deterministic — the same input never moves a penny on a re-run', () => {
    const args = [
      { key: 'XTRACK', weight: 39 },
      { key: 'ZONE', weight: 31 },
      { key: 'AFG', weight: 4 },
    ];
    const a = shareByCount(-1234567, args);
    const b = shareByCount(-1234567, args);
    expect(a).toEqual(b);
  });

  it('keeps the sign: a cost splits into costs, not credits', () => {
    const got = shareByCount(-999, [{ key: 'A', weight: 2 }, { key: 'B', weight: 1 }]);
    for (const g of got) expect(g.cents).toBeLessThan(0);
    expect(sum(got)).toBe(-999);
  });

  it('gives a zero-weight carrier nothing rather than an even share', () => {
    const got = shareByCount(-1000, [
      { key: 'RUNS_TRUCKS', weight: 10 },
      { key: 'NO_TRUCKS', weight: 0 },
    ]);
    expect(got.find((g) => g.key === 'NO_TRUCKS')!.cents).toBe(0);
    expect(got.find((g) => g.key === 'RUNS_TRUCKS')!.cents).toBe(-1000);
  });

  it('refuses rather than guessing when every weight is zero', () => {
    expect(() => shareByCount(-1000, [{ key: 'A', weight: 0 }, { key: 'B', weight: 0 }])).toThrow(
      /no defensible way/i,
    );
  });

  it('refuses a fractional weight, which would mean the caller already rounded', () => {
    expect(() => shareByCount(-1000, [{ key: 'A', weight: 1.5 }])).toThrow(/whole number/i);
  });

  it('handles a total of zero without inventing entries', () => {
    const got = shareByCount(0, [{ key: 'A', weight: 3 }, { key: 'B', weight: 1 }]);
    expect(sum(got)).toBe(0);
    for (const g of got) expect(g.cents).toBe(0);
  });
});
