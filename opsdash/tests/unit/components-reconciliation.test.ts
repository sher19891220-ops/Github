import { describe, expect, it } from 'vitest';
import type { ReconLine, ReconMatch } from '@/components/data/types';
import {
  confirmMatch,
  isCollapsedByDefault,
  markExpectedMissing,
  matchReconciliation,
  needsAttentionOrder,
  rejectMatch,
  summarizeRecon,
} from '@/components/reconciliation/logic';

function docLine(overrides: Partial<ReconLine> = {}): ReconLine {
  return {
    lineId: 'd1',
    side: 'document',
    sourceRef: { kind: 'document', documentId: 'doc-fuel-0091', stagingRowId: 'row-f-1', label: 'EFS_statement_2026-01.csv' },
    truckId: 'trk-50174',
    driverId: 'drv-1',
    accrualDate: '2026-01-06',
    amount: '-693.44',
    quantity: null,
    description: 'EFS fuel purchase',
    ...overrides,
  };
}

function ledgerLine(overrides: Partial<ReconLine> = {}): ReconLine {
  return {
    lineId: 'l1',
    side: 'ledger',
    sourceRef: { kind: 'ledger', entryId: 'entry-1', label: 'Ledger entry' },
    truckId: 'trk-50174',
    driverId: 'drv-1',
    accrualDate: '2026-01-06',
    amount: '-693.44',
    quantity: null,
    description: 'Fuel — diesel',
    ...overrides,
  };
}

describe('matchReconciliation — auto-matching what is unambiguous', () => {
  it('pairs same unit + date + amount as auto_matched', () => {
    const matches = matchReconciliation([docLine()], [ledgerLine()]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.status).toBe('auto_matched');
    expect(matches[0]?.documentLine?.lineId).toBe('d1');
    expect(matches[0]?.ledgerLine?.lineId).toBe('l1');
  });

  it('an auto-matched pair is collapsed by default', () => {
    const [match] = matchReconciliation([docLine()], [ledgerLine()]);
    expect(isCollapsedByDefault(match as ReconMatch)).toBe(true);
  });

  it('same unit + date, amount differs, is a near_match with the exact difference', () => {
    const matches = matchReconciliation([docLine({ amount: '-693.44' })], [ledgerLine({ amount: '-689.34' })]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.status).toBe('near_match');
    // -693.44 - (-689.34) = -4.10
    expect(matches[0]?.amountVariance).toBe('-4.10');
  });

  it('different unit or date never pairs, even with the same amount', () => {
    const matches = matchReconciliation(
      [docLine({ lineId: 'd1', truckId: 'trk-A', amount: '-100.00' })],
      [ledgerLine({ lineId: 'l1', truckId: 'trk-B', amount: '-100.00' })],
    );
    expect(matches).toHaveLength(2);
    expect(matches.every((m) => m.status === 'unmatched')).toBe(true);
  });

  it('unmatched lines on both sides are reported separately', () => {
    const matches = matchReconciliation(
      [docLine({ lineId: 'd-orphan', truckId: 'trk-999', amount: '-50.00' })],
      [ledgerLine({ lineId: 'l-orphan', truckId: 'trk-888', amount: '-75.00' })],
    );
    const docOnly = matches.filter((m) => m.documentLine && !m.ledgerLine);
    const ledgerOnly = matches.filter((m) => m.ledgerLine && !m.documentLine);
    expect(docOnly).toHaveLength(1);
    expect(ledgerOnly).toHaveLength(1);
  });

  it('shrinks a stack of mostly-identical rows to the handful that need a human', () => {
    const docs: ReconLine[] = [];
    const ledgers: ReconLine[] = [];
    for (let i = 0; i < 20; i++) {
      docs.push(docLine({ lineId: `d-${i}`, truckId: `trk-${i}`, amount: '-100.00' }));
      ledgers.push(ledgerLine({ lineId: `l-${i}`, truckId: `trk-${i}`, amount: '-100.00' }));
    }
    // One genuine variance and one genuinely missing row.
    docs.push(docLine({ lineId: 'd-variance', truckId: 'trk-variance', amount: '-100.00' }));
    ledgers.push(ledgerLine({ lineId: 'l-variance', truckId: 'trk-variance', amount: '-95.90' }));
    docs.push(docLine({ lineId: 'd-orphan', truckId: 'trk-orphan', amount: '-40.00' }));

    const matches = matchReconciliation(docs, ledgers);
    const needsHuman = needsAttentionOrder(matches);
    expect(needsHuman).toHaveLength(2); // the variance + the orphan
    expect(needsHuman[0]?.status).toBe('near_match'); // biggest-dollar / near-match ranks first
  });
});

describe('a human can confirm or reject an auto-matched pair', () => {
  it('confirming an auto_matched row moves it to confirmed and records who/when', () => {
    const [match] = matchReconciliation([docLine()], [ledgerLine()]);
    const confirmed = confirmMatch(match as ReconMatch, 'ops@example.com');
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.decidedBy).toBe('ops@example.com');
    expect(confirmed.decidedAt).toBeTruthy();
  });

  it('rejecting an auto_matched row splits it back into two independent unmatched rows', () => {
    const [match] = matchReconciliation([docLine()], [ledgerLine()]);
    const split = rejectMatch(match as ReconMatch, 'ops@example.com');
    expect(split).toHaveLength(2);
    expect(split.every((m) => m.status === 'rejected')).toBe(true);
    const doc = split.find((m) => m.documentLine);
    const ledger = split.find((m) => m.ledgerLine);
    expect(doc?.ledgerLine).toBeNull();
    expect(ledger?.documentLine).toBeNull();
  });

  it('cannot confirm an already-unmatched singleton row', () => {
    const matches = matchReconciliation([docLine({ truckId: 'trk-lonely' })], []);
    expect(() => confirmMatch(matches[0] as ReconMatch, 'ops@example.com')).toThrow();
  });
});

describe('marking a line expected-missing requires a note', () => {
  it('accepts a note and records it', () => {
    const [match] = matchReconciliation([docLine({ truckId: 'trk-lonely' })], []);
    const marked = markExpectedMissing(match as ReconMatch, 'Personal fuel purchase, not reimbursed.', 'ops@example.com');
    expect(marked.status).toBe('expected_missing');
    expect(marked.note).toBe('Personal fuel purchase, not reimbursed.');
  });

  it('rejects an empty note', () => {
    const [match] = matchReconciliation([docLine({ truckId: 'trk-lonely' })], []);
    expect(() => markExpectedMissing(match as ReconMatch, '   ', 'ops@example.com')).toThrow();
  });

  it('cannot mark an already-paired row expected-missing', () => {
    const [match] = matchReconciliation([docLine()], [ledgerLine()]);
    expect(() => markExpectedMissing(match as ReconMatch, 'note', 'ops@example.com')).toThrow();
  });
});

describe('summarizeRecon — the running totals', () => {
  it('counts an exact match as matched with zero net variance', () => {
    const matches = matchReconciliation([docLine()], [ledgerLine()]);
    const summary = summarizeRecon(matches);
    expect(summary.autoMatched).toBe(1);
    expect(summary.netVariance).toBe('0.00');
  });

  it('a near-match contributes its exact difference to net variance', () => {
    const matches = matchReconciliation([docLine({ amount: '-100.00' })], [ledgerLine({ amount: '-95.90' })]);
    const summary = summarizeRecon(matches);
    expect(summary.nearMatch).toBe(1);
    expect(summary.netVariance).toBe('-4.10');
  });

  it('an unmatched document line contributes its full amount', () => {
    const matches = matchReconciliation([docLine({ truckId: 'trk-lonely', amount: '-40.00' })], []);
    const summary = summarizeRecon(matches);
    expect(summary.unmatchedDocument).toBe(1);
    expect(summary.unmatchedLedger).toBe(0);
    expect(summary.netVariance).toBe('-40.00');
  });

  it('an unmatched ledger line contributes its amount with sign flipped', () => {
    const matches = matchReconciliation([], [ledgerLine({ truckId: 'trk-lonely', amount: '-40.00' })]);
    const summary = summarizeRecon(matches);
    expect(summary.unmatchedLedger).toBe(1);
    expect(summary.netVariance).toBe('40.00');
  });

  it('expected_missing rows are explained and excluded from net variance', () => {
    const [raw] = matchReconciliation([docLine({ truckId: 'trk-lonely', amount: '-40.00' })], []);
    const marked = markExpectedMissing(raw as ReconMatch, 'Known non-reimbursable charge.', 'ops@example.com');
    const summary = summarizeRecon([marked]);
    expect(summary.expectedMissing).toBe(1);
    expect(summary.unmatchedDocument).toBe(0);
    expect(summary.netVariance).toBe('0.00');
  });

  it('a rejected pairing counts through its two split-off unmatched rows, not the rejected row itself', () => {
    const [match] = matchReconciliation([docLine({ amount: '-100.00' })], [ledgerLine({ amount: '-95.90' })]);
    const split = rejectMatch(match as ReconMatch, 'ops@example.com');
    const summary = summarizeRecon(split);
    expect(summary.rejected).toBe(2);
    expect(summary.netVariance).toBe('0.00'); // rejected rows are excluded, same as expected_missing
  });
});
