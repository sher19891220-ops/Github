/**
 * The pairing rule, as a pure function.
 *
 * Kept out of the persistence module on purpose: a reconciliation matcher is
 * the kind of thing that has to be argued with, and an argument you can only
 * have against a live database is an argument nobody has. Everything here is
 * integer cents and plain strings.
 *
 * The rule, deliberately narrow:
 *
 *   1. Exact — same unit, same date, same amount. Unambiguous.
 *   2. Near  — same unit, same date, amount differs. This is the case a
 *              person actually has to look at, and the one the whole screen
 *              exists for.
 *   3. Everything else stays unmatched on its own side.
 *
 * What it deliberately does NOT do is pair on amount alone, or on a date
 * window, or on a fuzzy description. Every one of those produces confident
 * pairings that are wrong, and a wrong pairing is worse than an unmatched
 * line: an unmatched line gets looked at.
 */

/** One side's line, reduced to just what the rule reads. */
export interface MatchCandidate {
  lineId: string;
  /** Normalized unit identity. Null means the line names no unit, and a
   *  line that names no unit is never paired — there is nothing to pair on. */
  unitKey: string | null;
  /** YYYY-MM-DD. Null is treated the same way as a null unit. */
  accrualDate: string | null;
  amountCents: number;
}

export interface ProposedMatch {
  documentLineId: string | null;
  ledgerLineId: string | null;
  /** document - ledger, in cents. Null for a singleton. */
  varianceCents: number | null;
}

/** Leading noise and case differ between a statement and the sheet
 *  ("Unit 5852", "5852 ", "#5852"); the identity does not. */
export function normalizeUnitKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value
    .trim()
    .toUpperCase()
    .replace(/^UNIT[\s#]*/, '')
    .replace(/^#/, '')
    .trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pairKey(c: MatchCandidate): string | null {
  if (c.unitKey === null || c.accrualDate === null) return null;
  return `${c.unitKey} ${c.accrualDate}`;
}

export function proposeMatches(
  documentLines: readonly MatchCandidate[],
  ledgerLines: readonly MatchCandidate[],
): ProposedMatch[] {
  const matches: ProposedMatch[] = [];
  const usedLedger = new Set<string>();
  const pairedDocument = new Set<string>();

  // Ledger lines indexed by unit+date, in input order so the result is
  // deterministic when two ledger rows are genuinely identical.
  const byPair = new Map<string, MatchCandidate[]>();
  for (const l of ledgerLines) {
    const k = pairKey(l);
    if (k === null) continue;
    const bucket = byPair.get(k);
    if (bucket) bucket.push(l);
    else byPair.set(k, [l]);
  }

  // Pass 1: exact. Runs before any near match so an exact partner is never
  // consumed by an inexact one that happened to be considered first.
  for (const d of documentLines) {
    const k = pairKey(d);
    if (k === null) continue;
    const bucket = byPair.get(k);
    if (!bucket) continue;
    const hit = bucket.find((l) => !usedLedger.has(l.lineId) && l.amountCents === d.amountCents);
    if (!hit) continue;
    usedLedger.add(hit.lineId);
    pairedDocument.add(d.lineId);
    matches.push({ documentLineId: d.lineId, ledgerLineId: hit.lineId, varianceCents: 0 });
  }

  // Pass 2: same unit and date, different amount. The closest remaining
  // amount wins — with two candidates left, the nearer one is the more
  // defensible guess, and a person confirms or rejects it either way.
  for (const d of documentLines) {
    if (pairedDocument.has(d.lineId)) continue;
    const k = pairKey(d);
    if (k === null) continue;
    const bucket = byPair.get(k);
    if (!bucket) continue;

    let best: MatchCandidate | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const l of bucket) {
      if (usedLedger.has(l.lineId)) continue;
      const gap = Math.abs(d.amountCents - l.amountCents);
      if (gap < bestGap) {
        best = l;
        bestGap = gap;
      }
    }
    if (!best) continue;

    usedLedger.add(best.lineId);
    pairedDocument.add(d.lineId);
    matches.push({
      documentLineId: d.lineId,
      ledgerLineId: best.lineId,
      varianceCents: d.amountCents - best.amountCents,
    });
  }

  for (const d of documentLines) {
    if (!pairedDocument.has(d.lineId)) {
      matches.push({ documentLineId: d.lineId, ledgerLineId: null, varianceCents: null });
    }
  }
  for (const l of ledgerLines) {
    if (!usedLedger.has(l.lineId)) {
      matches.push({ documentLineId: null, ledgerLineId: l.lineId, varianceCents: null });
    }
  }

  return matches;
}
