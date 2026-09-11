/**
 * The pairing rule and the summary, without a database.
 *
 * These are the two places a reconciliation screen can lie: by pairing two
 * lines that are not the same transaction, and by reporting a variance that
 * makes finished work look unfinished (or the reverse).
 */
import { describe, expect, it } from 'vitest';
import type { ReconLine, ReconMatch } from '@/contract/types';
import {
  type MatchCandidate,
  normalizeUnitKey,
  proposeMatches,
} from '@/db/repo/reconciliationMatcher';
import { summarize } from '@/db/repo/reconciliation';

function candidate(
  lineId: string,
  unitKey: string | null,
  accrualDate: string | null,
  amountCents: number,
): MatchCandidate {
  return { lineId, unitKey, accrualDate, amountCents };
}

describe('normalizeUnitKey', () => {
  it('reads the same unit through the spellings a statement and a sheet use', () => {
    expect(normalizeUnitKey('5852')).toBe('5852');
    expect(normalizeUnitKey(' 5852 ')).toBe('5852');
    expect(normalizeUnitKey('Unit 5852')).toBe('5852');
    expect(normalizeUnitKey('UNIT #5852')).toBe('5852');
    expect(normalizeUnitKey('#5852')).toBe('5852');
  });

  it('does not invent a unit out of nothing', () => {
    expect(normalizeUnitKey(null)).toBeNull();
    expect(normalizeUnitKey('')).toBeNull();
    expect(normalizeUnitKey('   ')).toBeNull();
  });

  it('leaves a unit that is not a bare number alone', () => {
    expect(normalizeUnitKey('trl 50272')).toBe('TRL 50272');
  });
});

describe('proposeMatches', () => {
  it('pairs an exact same-unit, same-day, same-amount line', () => {
    const out = proposeMatches(
      [candidate('d1', '5852', '2026-03-04', -81244)],
      [candidate('l1', '5852', '2026-03-04', -81244)],
    );
    expect(out).toEqual([{ documentLineId: 'd1', ledgerLineId: 'l1', varianceCents: 0 }]);
  });

  it('pairs same unit and day at a different amount, and carries the variance', () => {
    const out = proposeMatches(
      [candidate('d1', '5852', '2026-03-04', -81244)],
      [candidate('l1', '5852', '2026-03-04', -80000)],
    );
    expect(out).toEqual([{ documentLineId: 'd1', ledgerLineId: 'l1', varianceCents: -1244 }]);
  });

  it('never lets a near match consume a partner some other line matches exactly', () => {
    // d1 could pair with either ledger line; d2 can only pair exactly with
    // l2. If the near pass ran first and greedily took l2 for d1, d2 would
    // be left unmatched and an exact pairing would have been thrown away.
    const out = proposeMatches(
      [candidate('d1', '5852', '2026-03-04', -50000), candidate('d2', '5852', '2026-03-04', -40000)],
      [candidate('l1', '5852', '2026-03-04', -30000), candidate('l2', '5852', '2026-03-04', -40000)],
    );
    expect(out).toContainEqual({ documentLineId: 'd2', ledgerLineId: 'l2', varianceCents: 0 });
    expect(out).toContainEqual({ documentLineId: 'd1', ledgerLineId: 'l1', varianceCents: -20000 });
  });

  it('picks the nearer amount when two candidates remain', () => {
    const out = proposeMatches(
      [candidate('d1', '5852', '2026-03-04', -50000)],
      [candidate('l_far', '5852', '2026-03-04', -10000), candidate('l_near', '5852', '2026-03-04', -49000)],
    );
    expect(out).toContainEqual({ documentLineId: 'd1', ledgerLineId: 'l_near', varianceCents: -1000 });
    expect(out).toContainEqual({ documentLineId: null, ledgerLineId: 'l_far', varianceCents: null });
  });

  it('refuses to pair across a different day even at an identical amount', () => {
    const out = proposeMatches(
      [candidate('d1', '5852', '2026-03-04', -81244)],
      [candidate('l1', '5852', '2026-03-05', -81244)],
    );
    expect(out).toEqual([
      { documentLineId: 'd1', ledgerLineId: null, varianceCents: null },
      { documentLineId: null, ledgerLineId: 'l1', varianceCents: null },
    ]);
  });

  it('refuses to pair across a different unit even on the same day and amount', () => {
    const out = proposeMatches(
      [candidate('d1', '5852', '2026-03-04', -81244)],
      [candidate('l1', '4546', '2026-03-04', -81244)],
    );
    expect(out.every((m) => m.documentLineId === null || m.ledgerLineId === null)).toBe(true);
  });

  it('never pairs a line that names no unit', () => {
    // An office cost with no unit and a truck cost with no unit are not the
    // same transaction just because they cost the same on the same day.
    const out = proposeMatches(
      [candidate('d1', null, '2026-03-04', -81244)],
      [candidate('l1', null, '2026-03-04', -81244)],
    );
    expect(out).toEqual([
      { documentLineId: 'd1', ledgerLineId: null, varianceCents: null },
      { documentLineId: null, ledgerLineId: 'l1', varianceCents: null },
    ]);
  });

  it('never pairs a line with no date', () => {
    const out = proposeMatches(
      [candidate('d1', '5852', null, -81244)],
      [candidate('l1', '5852', null, -81244)],
    );
    expect(out.every((m) => m.documentLineId === null || m.ledgerLineId === null)).toBe(true);
  });

  it('uses each side at most once', () => {
    const out = proposeMatches(
      [candidate('d1', '5852', '2026-03-04', -10000), candidate('d2', '5852', '2026-03-04', -10000)],
      [candidate('l1', '5852', '2026-03-04', -10000)],
    );
    const usedLedger = out.filter((m) => m.ledgerLineId === 'l1');
    expect(usedLedger).toHaveLength(1);
    expect(out.filter((m) => m.ledgerLineId === null && m.documentLineId !== null)).toHaveLength(1);
  });

  it('returns every line exactly once across the whole result', () => {
    const doc = [
      candidate('d1', '5852', '2026-03-04', -10000),
      candidate('d2', '4546', '2026-03-04', -20000),
      candidate('d3', null, '2026-03-04', -30000),
    ];
    const led = [
      candidate('l1', '5852', '2026-03-04', -10000),
      candidate('l2', '9999', '2026-03-04', -40000),
    ];
    const out = proposeMatches(doc, led);

    const seenDoc = out.map((m) => m.documentLineId).filter((v) => v !== null);
    const seenLed = out.map((m) => m.ledgerLineId).filter((v) => v !== null);
    expect(new Set(seenDoc)).toEqual(new Set(['d1', 'd2', 'd3']));
    expect(new Set(seenLed)).toEqual(new Set(['l1', 'l2']));
    expect(seenDoc).toHaveLength(3);
    expect(seenLed).toHaveLength(2);
  });
});

function line(side: 'document' | 'ledger', amount: string): ReconLine {
  return {
    lineId: `${side}-${amount}`,
    side,
    sourceRef:
      side === 'document'
        ? { kind: 'document', documentId: 'doc', stagingRowId: 'sr', label: 'Unit 5852' }
        : { kind: 'ledger', entryId: 'le', label: 'Unit 5852' },
    truckId: null,
    driverId: null,
    accrualDate: '2026-03-04',
    amount,
    quantity: null,
    description: null,
  };
}

function match(partial: Partial<ReconMatch> & Pick<ReconMatch, 'status'>): ReconMatch {
  return {
    matchId: `m-${Math.random()}`,
    documentLine: null,
    ledgerLine: null,
    amountVariance: null,
    note: null,
    decidedBy: null,
    decidedAt: null,
    ...partial,
  };
}

describe('summarize', () => {
  it('counts each status and leaves netVariance at zero when nothing is open', () => {
    const s = summarize([
      match({ status: 'auto_matched', documentLine: line('document', '-100.00'), ledgerLine: line('ledger', '-100.00'), amountVariance: '0.00' }),
      match({ status: 'confirmed', documentLine: line('document', '-200.00'), ledgerLine: line('ledger', '-200.00'), amountVariance: '0.00' }),
    ]);
    expect(s.autoMatched).toBe(1);
    expect(s.confirmed).toBe(1);
    expect(s.netVariance).toBe('0.00');
  });

  it('counts only the variance on an open near match, not the whole amount', () => {
    const s = summarize([
      match({
        status: 'near_match',
        documentLine: line('document', '-812.44'),
        ledgerLine: line('ledger', '-800.00'),
        amountVariance: '-12.44',
      }),
    ]);
    expect(s.nearMatch).toBe(1);
    expect(s.netVariance).toBe('-12.44');
  });

  it('counts the whole amount of an unmatched line, on the side it sits', () => {
    const s = summarize([
      match({ status: 'unmatched', documentLine: line('document', '-500.00') }),
      match({ status: 'unmatched', ledgerLine: line('ledger', '-200.00') }),
    ]);
    expect(s.unmatchedDocument).toBe(1);
    expect(s.unmatchedLedger).toBe(1);
    // The document says 500 went out and the ledger only knows about 200:
    // 300 is still unexplained, and the sign says which way.
    expect(s.netVariance).toBe('-300.00');
  });

  it('drops a settled line out of the variance so finished work reads finished', () => {
    const s = summarize([
      match({ status: 'expected_missing', documentLine: line('document', '-500.00'), note: 'billed direct' }),
      match({ status: 'confirmed', documentLine: line('document', '-812.44'), ledgerLine: line('ledger', '-800.00'), amountVariance: '-12.44' }),
    ]);
    expect(s.expectedMissing).toBe(1);
    expect(s.confirmed).toBe(1);
    expect(s.netVariance).toBe('0.00');
  });

  it('sums exactly, with no float drift across many lines', () => {
    const many = Array.from({ length: 300 }, () =>
      match({ status: 'unmatched', documentLine: line('document', '-0.10') }),
    );
    expect(summarize(many).netVariance).toBe('-30.00');
  });
});
