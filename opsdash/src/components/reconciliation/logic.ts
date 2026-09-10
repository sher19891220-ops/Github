/**
 * Pure reconciliation-matching logic, kept separate from React/DOM the same
 * way `review/logic.ts` is: unit-testable directly, and shared by the
 * screen component and the mock API so there is one definition of "matched"
 * instead of two that can drift.
 *
 * The whole point of this screen is to shrink a hundred lines to the six
 * that need a human — so the matcher does as much of the work as it safely
 * can (exact same amount + date + unit) and never guesses past that:
 *
 *  - same unit, same date, same amount            -> auto_matched (collapsed)
 *  - same unit, same date, amount differs          -> near_match (the variance)
 *  - no candidate with the same unit + date at all -> unmatched, on its side
 *
 * Matching on unit + date only (never amount alone) is deliberate: two
 * unrelated lines on the same day for different trucks that happen to share
 * a dollar amount are not a match, and pairing them would hide a real
 * variance behind a false confirmation.
 */

import type { Decimal } from '@/contract/types';
import { addMoney, compareMoney, moneyEquals, subtractMoney } from '../format/decimal';
import type { ReconLine, ReconMatch, ReconMatchStatus, ReconSummary } from '../data/types';

function unitDateKey(line: ReconLine): string {
  return `${line.truckId ?? '∅'}::${line.accrualDate ?? '∅'}`;
}

let matchSeq = 0;
function nextMatchId(): string {
  matchSeq += 1;
  return `match-${matchSeq}`;
}

/**
 * Builds the match view from two independent line lists. Deterministic for
 * a given input order — callers that need stable ids across re-renders
 * should sort their inputs (e.g. by `lineId`) before calling this, since
 * `nextMatchId` is a module-level counter only meant to give every row in
 * one call a distinct id, not to survive being called twice for "the same"
 * reconciliation (the mock API caches the result instead of recomputing).
 */
export function matchReconciliation(
  documentLines: readonly ReconLine[],
  ledgerLines: readonly ReconLine[],
): ReconMatch[] {
  const matches: ReconMatch[] = [];
  const usedLedger = new Set<string>();
  const usedDocument = new Set<string>();

  // Pass 1 — exact matches: same unit, same date, same amount. Greedy is
  // safe here because "exact" leaves no ambiguity about which candidate a
  // line should pair with beyond FIFO among true duplicates.
  for (const doc of documentLines) {
    const candidate = ledgerLines.find(
      (l) => !usedLedger.has(l.lineId) && unitDateKey(l) === unitDateKey(doc) && moneyEquals(l.amount, doc.amount),
    );
    if (candidate) {
      usedLedger.add(candidate.lineId);
      usedDocument.add(doc.lineId);
      matches.push({
        matchId: nextMatchId(),
        status: 'auto_matched',
        documentLine: doc,
        ledgerLine: candidate,
        amountVariance: null,
        note: null,
        decidedBy: null,
        decidedAt: null,
      });
    }
  }

  // Pass 2 — near matches: same unit + date, amount differs. Pair the
  // closest-amount candidate first so the smallest, most obviously-correct
  // pairings are made before a larger ambiguous one consumes a candidate
  // that actually belonged to a closer match.
  const remainingDoc = documentLines.filter((d) => !usedDocument.has(d.lineId));
  const nearCandidates: { doc: ReconLine; ledger: ReconLine; diffAbsCents: bigint }[] = [];
  for (const doc of remainingDoc) {
    for (const ledger of ledgerLines) {
      if (usedLedger.has(ledger.lineId)) continue;
      if (unitDateKey(ledger) !== unitDateKey(doc)) continue;
      const diff = subtractMoney(doc.amount, ledger.amount);
      const diffAbsCents = diff.startsWith('-') ? BigInt(diff.replace('.', '').slice(1)) : BigInt(diff.replace('.', ''));
      nearCandidates.push({ doc, ledger, diffAbsCents });
    }
  }
  nearCandidates.sort((a, b) => (a.diffAbsCents < b.diffAbsCents ? -1 : a.diffAbsCents > b.diffAbsCents ? 1 : 0));
  for (const { doc, ledger } of nearCandidates) {
    if (usedDocument.has(doc.lineId) || usedLedger.has(ledger.lineId)) continue;
    usedDocument.add(doc.lineId);
    usedLedger.add(ledger.lineId);
    matches.push({
      matchId: nextMatchId(),
      status: 'near_match',
      documentLine: doc,
      ledgerLine: ledger,
      amountVariance: subtractMoney(doc.amount, ledger.amount),
      note: null,
      decidedBy: null,
      decidedAt: null,
    });
  }

  // Pass 3 — whatever is left on either side is unmatched, singleton rows.
  for (const doc of documentLines) {
    if (usedDocument.has(doc.lineId)) continue;
    matches.push({
      matchId: nextMatchId(),
      status: 'unmatched',
      documentLine: doc,
      ledgerLine: null,
      amountVariance: null,
      note: null,
      decidedBy: null,
      decidedAt: null,
    });
  }
  for (const ledger of ledgerLines) {
    if (usedLedger.has(ledger.lineId)) continue;
    matches.push({
      matchId: nextMatchId(),
      status: 'unmatched',
      documentLine: null,
      ledgerLine: ledger,
      amountVariance: null,
      note: null,
      decidedBy: null,
      decidedAt: null,
    });
  }

  return matches;
}

/** A human confirms a match (auto or near) — recorded, not just assumed. */
export function confirmMatch(match: ReconMatch, decidedBy: string, decidedAt = new Date().toISOString()): ReconMatch {
  if (match.status !== 'auto_matched' && match.status !== 'near_match') {
    throw new Error(`Only an auto_matched or near_match row can be confirmed (got ${match.status})`);
  }
  return { ...match, status: 'confirmed', decidedBy, decidedAt };
}

/**
 * A human rejects a pairing. The two lines split back into independent
 * unmatched rows — a rejected match is not "resolved", it's un-done, and
 * both lines still need to be accounted for somewhere.
 */
export function rejectMatch(match: ReconMatch, decidedBy: string, decidedAt = new Date().toISOString()): ReconMatch[] {
  if (match.documentLine == null && match.ledgerLine == null) {
    throw new Error('Cannot reject a match with no lines');
  }
  const decided = { decidedBy, decidedAt };
  const out: ReconMatch[] = [];
  if (match.documentLine) {
    out.push({
      matchId: `${match.matchId}-doc`,
      status: 'rejected',
      documentLine: match.documentLine,
      ledgerLine: null,
      amountVariance: null,
      note: match.note,
      ...decided,
    });
  }
  if (match.ledgerLine) {
    out.push({
      matchId: `${match.matchId}-ledger`,
      status: 'rejected',
      documentLine: null,
      ledgerLine: match.ledgerLine,
      amountVariance: null,
      note: match.note,
      ...decided,
    });
  }
  return out;
}

/** A human marks a singleton (unmatched) line as expected to have no
 *  counterpart, with a note explaining why — required, not optional, since
 *  an unexplained "expected missing" is indistinguishable from a shrug. */
export function markExpectedMissing(
  match: ReconMatch,
  note: string,
  decidedBy: string,
  decidedAt = new Date().toISOString(),
): ReconMatch {
  if (match.status !== 'unmatched') {
    throw new Error(`Only an unmatched row can be marked expected-missing (got ${match.status})`);
  }
  if (!note.trim()) {
    throw new Error('A note is required to mark a line expected-missing');
  }
  return { ...match, status: 'expected_missing', note, decidedBy, decidedAt };
}

function signedContribution(match: ReconMatch): Decimal | null {
  if (match.status === 'expected_missing' || match.status === 'rejected') return null;
  if (match.documentLine && match.ledgerLine) {
    // Paired: 0 for an exact match, the variance itself for a near match.
    return subtractMoney(match.documentLine.amount, match.ledgerLine.amount);
  }
  if (match.documentLine) return match.documentLine.amount;
  if (match.ledgerLine) return subtractMoney('0.00', match.ledgerLine.amount);
  return null;
}

/**
 * The running totals the screen's header bar shows. `netVariance` sums a
 * signed contribution per row: 0 for an exact match, the actual difference
 * for a near match/confirmed pairing, and the full line amount (sign
 * flipped for the ledger side) for anything still genuinely unmatched.
 * `expected_missing` and `rejected` rows are excluded from `netVariance` —
 * a rejected pairing has already been split back into fresh `unmatched`
 * rows that DO count, and an expected-missing row has a human-authored
 * reason it should not count as outstanding variance at all.
 */
export function summarizeRecon(matches: readonly ReconMatch[]): ReconSummary {
  let autoMatched = 0;
  let nearMatch = 0;
  let confirmed = 0;
  let unmatchedDocument = 0;
  let unmatchedLedger = 0;
  let expectedMissing = 0;
  let rejected = 0;
  const contributions: Decimal[] = [];

  for (const m of matches) {
    switch (m.status) {
      case 'auto_matched':
        autoMatched += 1;
        break;
      case 'near_match':
        nearMatch += 1;
        break;
      case 'confirmed':
        confirmed += 1;
        break;
      case 'expected_missing':
        expectedMissing += 1;
        break;
      case 'rejected':
        rejected += 1;
        break;
      case 'unmatched':
        if (m.documentLine) unmatchedDocument += 1;
        if (m.ledgerLine) unmatchedLedger += 1;
        break;
    }
    const c = signedContribution(m);
    if (c != null) contributions.push(c);
  }

  const netVariance = contributions.reduce((acc, c) => addMoney(acc, c), '0.00');

  return {
    autoMatched,
    nearMatch,
    confirmed,
    unmatchedDocument,
    unmatchedLedger,
    expectedMissing,
    rejected,
    netVariance,
  };
}

/** True for rows the operator never needs to open — the auto-matched pile
 *  the screen collapses by default. */
export function isCollapsedByDefault(match: ReconMatch): boolean {
  return match.status === 'auto_matched';
}

/** Sort order for the "needs a human" list: near-matches (the variance
 *  itself) first, then unmatched, largest amount first within each group,
 *  so the biggest dollars surface at the top. Excludes everything a human
 *  has already resolved — `auto_matched`/`confirmed` (accepted) as well as
 *  `rejected`/`expected_missing` (a decision was already recorded for
 *  those) — because the whole point of this ordering is "what still needs
 *  a person to look at it", not a full audit log. */
export function needsAttentionOrder(matches: readonly ReconMatch[]): ReconMatch[] {
  const rank: Record<ReconMatchStatus, number> = {
    near_match: 0,
    unmatched: 1,
    rejected: 2,
    expected_missing: 3,
    confirmed: 4,
    auto_matched: 5,
  };
  const magnitude = (m: ReconMatch): Decimal => {
    if (m.amountVariance) return m.amountVariance.replace(/^-/, '');
    const line = m.documentLine ?? m.ledgerLine;
    return line ? line.amount.replace(/^-/, '') : '0.00';
  };
  return [...matches]
    .filter((m) => m.status === 'near_match' || m.status === 'unmatched')
    .sort((a, b) => {
      const r = rank[a.status] - rank[b.status];
      if (r !== 0) return r;
      return compareMoney(magnitude(b), magnitude(a));
    });
}
