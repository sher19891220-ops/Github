import {
  compareIsoDates,
  completedMonths,
  daysBetween,
  isValidIsoDate,
  isWithinWindow,
  lookbackWindow,
  type IsoDate,
  type LookbackWindow,
} from './dates';
import { classifyEvent } from './classification';
import {
  CURRENT_EXTRACTION_FORMAT_VERSION,
  MIN_FIELD_CONFIDENCE,
  MVR_STALENESS_DAYS,
  type DriverEvidence,
  type MvrEvent,
  type SuspensionRecord,
} from './types';
import type { EventCategory } from './guideline';

/* ------------------------------------------------------------------ *
 * Normalized event
 * ------------------------------------------------------------------ */

export interface NormalizedEvent extends MvrEvent {
  /**
   * The date the engine uses for this record: conviction date when the MVR
   * reports one, otherwise the violation/event date. The same date decides both
   * lookback membership and ordering, so a record can never be inside a window
   * by one date and outside it by the other.
   */
  effectiveDate: IsoDate | null;
  effectiveDateSource: 'conviction' | 'violation' | 'none';
  matchedRuleId: string | null;
}

export interface EvidenceBlocker {
  code: string;
  message: string;
}

export interface ExperienceResult {
  /** null when it cannot be computed — never silently substituted. */
  months: number | null;
  originalIssueDate: IsoDate | null;
  reason: string;
  /** True when staff-entered months were overridden by the derived value. */
  reportedValueIgnored: boolean;
}

export interface NormalizedEvidence {
  evaluationDate: IsoDate;
  mvrOrderDate: IsoDate | null;
  mvrAgeDays: number | null;
  events: NormalizedEvent[];
  /** Only records the source document reported explicitly. */
  suspensions: SuspensionRecord[];
  /** Records that claimed to be suspensions but were inferred; dropped. */
  discardedInferredSuspensions: SuspensionRecord[];
  experience: ExperienceResult;
  ageYears: number | null;
  /** Conditions that force Manual Review for every coverage. */
  blockers: EvidenceBlocker[];
  warnings: string[];
}

/**
 * Experience is always derived from the original CDL issue date. A renewal,
 * duplicate or expiry date is never a substitute, and a staff-entered month
 * count never overrides a derived one.
 */
export function calculateExperience(
  evidence: DriverEvidence,
  evaluationDate: IsoDate,
): ExperienceResult {
  const original = evidence.cdlOriginalIssueDate;

  if (!original || !isValidIsoDate(original)) {
    return {
      months: null,
      originalIssueDate: null,
      reason:
        'Cannot calculate: no original CDL issue date was extracted. Current issue, renewal, duplicate and expiration dates are not valid substitutes.',
      reportedValueIgnored: false,
    };
  }

  if (compareIsoDates(original, evaluationDate) > 0) {
    return {
      months: null,
      originalIssueDate: original,
      reason: `Cannot calculate: original CDL issue date ${original} is after the evaluation date ${evaluationDate}.`,
      reportedValueIgnored: false,
    };
  }

  const confidence = evidence.confidence['cdlOriginalIssueDate'];
  if (typeof confidence === 'number' && confidence < MIN_FIELD_CONFIDENCE) {
    return {
      months: null,
      originalIssueDate: original,
      reason: `Cannot calculate with confidence: the original CDL issue date was extracted at ${confidence.toFixed(2)} confidence, below the ${MIN_FIELD_CONFIDENCE} threshold. Verify the date against the source document.`,
      reportedValueIgnored: false,
    };
  }

  const months = completedMonths(original, evaluationDate);
  return {
    months,
    originalIssueDate: original,
    reason: `${months} completed months between the original CDL issue date ${original} and the evaluation date ${evaluationDate}.`,
    reportedValueIgnored:
      evidence.reportedExperienceMonths !== null &&
      evidence.reportedExperienceMonths !== months,
  };
}

export function normalizeEvent(event: MvrEvent): NormalizedEvent {
  const classified = classifyEvent(event);
  const conviction = event.convictionDate && isValidIsoDate(event.convictionDate) ? event.convictionDate : null;
  const violation = event.violationDate && isValidIsoDate(event.violationDate) ? event.violationDate : null;

  const effectiveDate = conviction ?? violation;
  const effectiveDateSource: NormalizedEvent['effectiveDateSource'] = conviction
    ? 'conviction'
    : violation
      ? 'violation'
      : 'none';

  return { ...classified, effectiveDate, effectiveDateSource };
}

export function normalizeEvidence(
  evidence: DriverEvidence,
  evaluationDate: IsoDate,
): NormalizedEvidence {
  const blockers: EvidenceBlocker[] = [];
  const warnings = [...evidence.warnings];

  if (evidence.extractionFormatVersion < CURRENT_EXTRACTION_FORMAT_VERSION) {
    blockers.push({
      code: 'legacy_extraction_format',
      message: `Evidence was captured with extraction format v${evidence.extractionFormatVersion}; the current format is v${CURRENT_EXTRACTION_FORMAT_VERSION}. Re-read the documents before relying on any decision.`,
    });
  }

  const events = evidence.events.map(normalizeEvent);

  const undatedEvents = events.filter((e) => e.effectiveDate === null);
  if (undatedEvents.length > 0) {
    blockers.push({
      code: 'event_missing_date',
      message: `${undatedEvents.length} MVR record(s) have no usable conviction or violation date, so lookback membership cannot be determined.`,
    });
  }

  const unknownEvents = events.filter((e) => e.eventType === 'Unknown' && e.effectiveDate !== null);
  if (unknownEvents.length > 0) {
    blockers.push({
      code: 'event_unclassified',
      message: `${unknownEvents.length} MVR record(s) could not be classified from their description and need reviewer classification: ${unknownEvents
        .map((e) => `"${e.description}"`)
        .join(', ')}.`,
    });
  }

  const explicitSuspensions = evidence.suspensions.filter(
    (s) => s.source === 'explicit_document_record',
  );
  const discardedInferredSuspensions = evidence.suspensions.filter(
    (s) => s.source !== 'explicit_document_record',
  );
  if (discardedInferredSuspensions.length > 0) {
    blockers.push({
      code: 'inferred_suspension_present',
      message: `${discardedInferredSuspensions.length} suspension record(s) were inferred rather than read from a document. They have been discarded and the applicant is held for review until the documents are re-read.`,
    });
  }

  let mvrAgeDays: number | null = null;
  if (evidence.mvrOrderDate && isValidIsoDate(evidence.mvrOrderDate)) {
    mvrAgeDays = daysBetween(evidence.mvrOrderDate, evaluationDate);
    if (mvrAgeDays < 0) {
      blockers.push({
        code: 'mvr_order_date_in_future',
        message: `The MVR order date ${evidence.mvrOrderDate} is after the evaluation date ${evaluationDate}.`,
      });
    } else if (mvrAgeDays > MVR_STALENESS_DAYS) {
      blockers.push({
        code: 'mvr_stale',
        message: `The MVR was ordered ${mvrAgeDays} days ago, beyond the ${MVR_STALENESS_DAYS}-day freshness limit. Order a current MVR.`,
      });
    }

    const anchor = evidence.mvrOrderDate;
    const futureEvents = events.filter(
      (e) => e.effectiveDate !== null && compareIsoDates(e.effectiveDate, anchor) > 0,
    );
    if (futureEvents.length > 0) {
      warnings.push(
        `${futureEvents.length} MVR record(s) are dated after the MVR order date and are excluded from every lookback window.`,
      );
    }
  }

  const experience = calculateExperience(evidence, evaluationDate);

  const ageYears =
    evidence.dateOfBirth && isValidIsoDate(evidence.dateOfBirth)
      ? Math.floor(completedMonths(evidence.dateOfBirth, evaluationDate) / 12)
      : null;

  if (experience.reportedValueIgnored) {
    warnings.push(
      `Staff-reported experience of ${evidence.reportedExperienceMonths} months was ignored in favour of ${experience.months} months derived from the original CDL issue date.`,
    );
  }

  return {
    evaluationDate,
    mvrOrderDate: evidence.mvrOrderDate,
    mvrAgeDays,
    events,
    suspensions: explicitSuspensions,
    discardedInferredSuspensions,
    experience,
    ageYears,
    blockers,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * Counting
 * ------------------------------------------------------------------ */

export interface CountedEvent {
  event: NormalizedEvent;
  countable: boolean;
  exclusionReason: string | null;
}

export function matchesCategory(event: NormalizedEvent, category: EventCategory): boolean {
  switch (category) {
    case 'moving_violation':
      return event.eventType === 'Moving Violation';
    case 'minor_moving_violation':
      return event.eventType === 'Moving Violation' && event.severity === 'Minor';
    case 'serious_moving_violation':
      return event.eventType === 'Moving Violation' && event.severity === 'Serious';
    case 'major_moving_violation':
      return event.eventType === 'Moving Violation' && event.severity === 'Major';
    case 'accident':
      return event.eventType === 'Accident';
    case 'at_fault_accident':
      return event.eventType === 'Accident' && event.atFault === true;
    case 'administrative':
      return event.eventType === 'Administrative';
  }
}

function categoryLabel(category: EventCategory): string {
  return category.replace(/_/g, ' ');
}

/**
 * Applies a category and a lookback window to the normalized events, returning
 * every record with an explicit countable/excluded verdict. Excluded records
 * always carry a reason, so an explanation can list exactly what was left out
 * and why.
 */
export function countEvents(
  events: NormalizedEvent[],
  category: EventCategory,
  window: LookbackWindow,
): { counted: CountedEvent[]; count: number } {
  const counted = events.map<CountedEvent>((event) => {
    if (event.effectiveDate === null) {
      return {
        event,
        countable: false,
        exclusionReason: 'No conviction or violation date; lookback membership is undetermined.',
      };
    }
    if (!isWithinWindow(event.effectiveDate, window)) {
      const relation =
        compareIsoDates(event.effectiveDate, window.end) > 0 ? 'after' : 'before';
      return {
        event,
        countable: false,
        exclusionReason: `Dated ${event.effectiveDate} (${event.effectiveDateSource} date), ${relation} the ${window.months}-month window ${window.start} to ${window.end}.`,
      };
    }
    if (!matchesCategory(event, category)) {
      return {
        event,
        countable: false,
        exclusionReason: `Classified as ${event.eventType}${
          event.eventType === 'Moving Violation' ? ` / ${event.severity}` : ''
        }, which is not a ${categoryLabel(category)}.`,
      };
    }
    return { event, countable: true, exclusionReason: null };
  });

  return { counted, count: counted.filter((c) => c.countable).length };
}

export function sumPoints(
  events: NormalizedEvent[],
  basis: 'state' | 'mvr_activity',
  window: LookbackWindow,
): { total: number; missing: NormalizedEvent[] } {
  let total = 0;
  const missing: NormalizedEvent[] = [];
  for (const event of events) {
    if (event.effectiveDate === null || !isWithinWindow(event.effectiveDate, window)) continue;
    const value = basis === 'state' ? event.statePoints : event.mvrActivityPoints;
    if (value === null || value === undefined) {
      missing.push(event);
      continue;
    }
    total += value;
  }
  return { total, missing };
}

export function suspensionsInWindow(
  suspensions: SuspensionRecord[],
  window: LookbackWindow,
): { inWindow: SuspensionRecord[]; undated: SuspensionRecord[] } {
  const inWindow: SuspensionRecord[] = [];
  const undated: SuspensionRecord[] = [];
  for (const s of suspensions) {
    const date = s.startDate ?? s.endDate ?? s.reinstatedDate;
    if (!date || !isValidIsoDate(date)) {
      undated.push(s);
      continue;
    }
    if (isWithinWindow(date, window)) inWindow.push(s);
  }
  return { inWindow, undated };
}

export { lookbackWindow };
