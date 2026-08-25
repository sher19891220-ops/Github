import { compareIsoDates, isValidIsoDate, type IsoDate } from './dates';
import type { CdlIssueDateCandidate, SourceDocument } from './types';

/**
 * Choosing the original CDL issue date from competing candidates.
 *
 * Documents disagree in a specific, predictable way: the licence carries the
 * original issue date, while an MVR usually prints only the most recent state
 * issuance or transfer. Both are "issue dates". Taking the later one silently
 * costs the driver every year before their last transfer, which is exactly the
 * error that turns a qualified driver into a rejected one.
 *
 * So the rule is not "earliest date wins" — an earlier date on an unlabelled
 * field is no more trustworthy than a later one. The rule is that only a date
 * the document *itself* identifies as the first/original issue may be used at
 * all. Anything else leaves the date unresolved, which means Manual Review
 * rather than a guess.
 */

/** Ranking for explicitly-original candidates. The licence outranks the rest. */
const SOURCE_PRECEDENCE: Record<SourceDocument, number> = {
  CDL: 0,
  MVR: 1,
  PSP: 2,
  Other: 3,
};

export interface ResolvedOriginalIssueDate {
  date: IsoDate | null;
  /** The candidate the date came from, when one was chosen. */
  chosen: CdlIssueDateCandidate | null;
  /** Candidates that were not used, each with the reason. */
  rejected: Array<{ candidate: CdlIssueDateCandidate; reason: string }>;
  /** Reviewer-facing explanation of the outcome. */
  reason: string;
}

function describe(candidate: CdlIssueDateCandidate): string {
  return `${candidate.date} from the ${candidate.sourceDocument} labelled "${candidate.printedLabel}"`;
}

export function resolveOriginalIssueDate(
  candidates: CdlIssueDateCandidate[],
): ResolvedOriginalIssueDate {
  const usable = candidates.filter((c) => isValidIsoDate(c.date));
  const rejected: ResolvedOriginalIssueDate['rejected'] = [];

  for (const candidate of candidates) {
    if (!isValidIsoDate(candidate.date)) {
      rejected.push({ candidate, reason: 'Not a valid calendar date.' });
    }
  }

  const explicit = usable.filter((c) => c.explicitlyOriginal);
  for (const candidate of usable) {
    if (!candidate.explicitlyOriginal) {
      rejected.push({
        candidate,
        reason: `The document does not identify this as the original CDL issue date — "${candidate.printedLabel}" may be a renewal, duplicate, transfer or state-issuance date.`,
      });
    }
  }

  if (explicit.length === 0) {
    return {
      date: null,
      chosen: null,
      rejected,
      reason:
        usable.length === 0
          ? 'No CDL issue date was found on any document.'
          : `No document identifies an original/first CDL issue date. ${usable.length} other issue date(s) were found but none is labelled as the original, so none can be used: ${usable.map(describe).join('; ')}.`,
    };
  }

  // Prefer the licence itself; among equals prefer the earliest, since two
  // documents both claiming "original" and disagreeing means the later one is
  // describing a re-issue.
  const sorted = [...explicit].sort((a, b) => {
    const bySource = SOURCE_PRECEDENCE[a.sourceDocument] - SOURCE_PRECEDENCE[b.sourceDocument];
    if (bySource !== 0) return bySource;
    return compareIsoDates(a.date, b.date);
  });

  const chosen = sorted[0]!;
  for (const candidate of sorted.slice(1)) {
    rejected.push({
      candidate,
      reason: `A more authoritative original issue date was available (${describe(chosen)}).`,
    });
  }

  const laterOnOtherDocument = usable.filter(
    (c) => c !== chosen && compareIsoDates(c.date, chosen.date) > 0,
  );
  const note = laterOnOtherDocument.length
    ? ` A later issue date (${laterOnOtherDocument.map((c) => `${c.date} on the ${c.sourceDocument}`).join(', ')}) was found but does not replace it — a state re-issuance does not restart CDL experience.`
    : '';

  return {
    date: chosen.date,
    chosen,
    rejected,
    reason: `Original CDL issue date taken from ${describe(chosen)}.${note}`,
  };
}
