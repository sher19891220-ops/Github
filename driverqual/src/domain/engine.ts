import { lookbackWindow, type IsoDate } from './dates';
import { bandLabel, describeThreshold, experienceBand, withinThreshold, type ExperienceBand } from './experience';
import {
  countEvents,
  normalizeEvidence,
  suspensionsInWindow,
  sumPoints,
  type NormalizedEvidence,
} from './evidence';
import { isEvaluable, guidelineDisplayName, type Condition, type Guideline } from './guideline';
import {
  CONTROLLING_COVERAGE,
  type CoverageType,
  type Decision,
  type DriverEvidence,
} from './types';

/**
 * Version of the decision logic itself. Stored on every evaluation so a past
 * decision can be reproduced against the exact engine that produced it.
 *
 * Bumped to 2.0.0 for specification v2.0: experience-band selection, inclusive
 * threshold reporting, the major-classification safeguard and PSP handling all
 * change what the engine decides, so a 1.x evaluation is not comparable to a
 * 2.x one and the stored version must say which produced it.
 */
export const ENGINE_VERSION = '2.0.0';

export type ConditionStatus = 'pass' | 'fail' | 'indeterminate';

export interface ConditionOutcome {
  condition: Condition;
  status: ConditionStatus;
  /** Deterministic sentence describing what was compared and what was found. */
  detail: string;
  evidenceUsed: string[];
  excludedEvidence: string[];
  dataGaps: string[];
}

export type PathStatus = ConditionStatus | 'not_applicable';

export interface PathOutcome {
  pathId: string;
  label: string;
  sourceText: string;
  status: PathStatus;
  conditions: ConditionOutcome[];
  /** The band this path is restricted to, when it is banded. */
  appliesToExperienceBand: ExperienceBand | null;
  /** Underwriting terms that attach if this path is the one satisfied. */
  underwritingConditions: string[];
  /** Why the path was skipped, when not applicable. */
  notApplicableReason: string | null;
}

export interface CoverageEvaluation {
  companyId: string;
  coverageType: CoverageType;
  decision: Decision;
  reason: string;
  guidelineId: string | null;
  guidelineVersion: string | null;
  guidelineName: string | null;
  eligibilityPath: string | null;
  criteriaApplied: string[];
  evidenceUsed: string[];
  excludedEvidence: string[];
  dataGaps: string[];
  paths: PathOutcome[];
  disqualifiersTriggered: string[];
  /** Underwriting terms attached by the satisfied path. Never a rejection. */
  underwritingConditions: string[];
  /** The band the driver's verified experience places them in. */
  experienceBand: ExperienceBand;
  experienceBandLabel: string;
  completedExperienceMonths: number | null;
  engineVersion: string;
  extractionFormatVersion: number;
  evaluationDate: IsoDate;
}

/* ------------------------------------------------------------------ *
 * Condition evaluation
 * ------------------------------------------------------------------ */

function describeCondition(condition: Condition): string {
  switch (condition.type) {
    case 'min_experience_months':
      return `At least ${condition.months} completed months of CDL experience`;
    case 'min_age_years':
      return `At least ${condition.years} years of age`;
    case 'max_events':
      return `No more than ${condition.max} ${condition.category.replace(/_/g, ' ')}(s) in ${condition.lookbackMonths} months`;
    case 'max_points':
      return `No more than ${condition.max} ${condition.basis === 'state' ? 'state' : 'MVR activity'} points in ${condition.lookbackMonths} months`;
    case 'license_status_in':
      return `License status is one of: ${condition.statuses.join(', ')}`;
    case 'cdl_class_in':
      return `CDL class is one of: ${condition.classes.join(', ')}`;
    case 'requires_valid_medical_card':
      return 'A valid, unexpired medical examiner’s certificate is on file';
    case 'max_suspensions':
      return `No more than ${condition.max} suspension record(s) in ${condition.lookbackMonths} months`;
  }
}

function evaluateCondition(
  condition: Condition,
  evidence: EngineEvidence,
): ConditionOutcome {
  const base = {
    condition,
    evidenceUsed: [] as string[],
    excludedEvidence: [] as string[],
    dataGaps: [] as string[],
  };

  switch (condition.type) {
    case 'min_experience_months': {
      const { months, originalIssueDate, reason } = evidence.experience;
      if (months === null) {
        return {
          ...base,
          status: 'indeterminate',
          detail: `Requires ${condition.months} completed months of experience. ${reason}`,
          dataGaps: [reason],
        };
      }
      const pass = months >= condition.months;
      return {
        ...base,
        status: pass ? 'pass' : 'fail',
        detail: `Requires ${condition.months} completed months; driver has ${months} completed months as of ${evidence.evaluationDate} (original CDL issue date ${originalIssueDate}). ${months} ${
          pass ? '≥' : '<'
        } ${condition.months}.`,
        evidenceUsed: [
          `Original CDL issue date ${originalIssueDate}`,
          `${months} completed months of experience at ${evidence.evaluationDate}`,
        ],
      };
    }

    case 'min_age_years': {
      if (evidence.ageYears === null) {
        return {
          ...base,
          status: 'indeterminate',
          detail: `Requires age ${condition.years}+. No date of birth was extracted.`,
          dataGaps: ['Date of birth is missing.'],
        };
      }
      const pass = evidence.ageYears >= condition.years;
      return {
        ...base,
        status: pass ? 'pass' : 'fail',
        detail: `Requires age ${condition.years}+; driver is ${evidence.ageYears}.`,
        evidenceUsed: [`Age ${evidence.ageYears} at ${evidence.evaluationDate}`],
      };
    }

    case 'max_events': {
      if (!evidence.mvrOrderDate) {
        return {
          ...base,
          status: 'indeterminate',
          detail: `Requires no more than ${condition.max} ${condition.category.replace(/_/g, ' ')}(s) in ${condition.lookbackMonths} months, but the MVR order date is missing so the lookback window cannot be anchored.`,
          dataGaps: ['MVR order/report date is missing; MVR lookback windows cannot be anchored.'],
        };
      }
      const window = lookbackWindow(evidence.mvrOrderDate, condition.lookbackMonths);
      const { counted, count } = countEvents(evidence.events, condition.category, window);
      const countable = counted.filter((c) => c.countable);
      const excluded = counted.filter((c) => !c.countable);
      const pass = withinThreshold(count, condition.max);
      return {
        ...base,
        status: pass ? 'pass' : 'fail',
        detail: `Requires no more than ${condition.max} ${condition.category.replace(/_/g, ' ')}(s) in the ${condition.lookbackMonths}-month window ${window.start} to ${window.end} (anchored on the MVR order date). Countable: ${count} — ${describeThreshold(count, condition.max)}, so this ${pass ? 'passes' : 'fails'}.`,
        evidenceUsed: countable.map(
          (c) =>
            `${c.event.effectiveDate} — ${c.event.description} (${c.event.eventType}${
              c.event.eventType === 'Moving Violation' ? ` / ${c.event.severity}` : ''
            }, ${c.event.effectiveDateSource} date)`,
        ),
        excludedEvidence: excluded.map(
          (c) => `${c.event.description}: ${c.exclusionReason}`,
        ),
      };
    }

    case 'max_points': {
      if (!evidence.mvrOrderDate) {
        return {
          ...base,
          status: 'indeterminate',
          detail: `Requires no more than ${condition.max} points in ${condition.lookbackMonths} months, but the MVR order date is missing so the lookback window cannot be anchored.`,
          dataGaps: ['MVR order/report date is missing; MVR lookback windows cannot be anchored.'],
        };
      }
      const window = lookbackWindow(evidence.mvrOrderDate, condition.lookbackMonths);
      const { total, missing } = sumPoints(evidence.events, condition.basis, window);
      const label = condition.basis === 'state' ? 'state' : 'MVR activity';
      if (missing.length > 0) {
        return {
          ...base,
          status: 'indeterminate',
          detail: `Requires no more than ${condition.max} ${label} points in ${condition.lookbackMonths} months. ${missing.length} in-window record(s) have no ${label} point value, so the total cannot be computed.`,
          dataGaps: missing.map(
            (e) => `No ${label} point value on in-window record "${e.description}" (${e.effectiveDate}).`,
          ),
        };
      }
      const pass = withinThreshold(total, condition.max);
      return {
        ...base,
        status: pass ? 'pass' : 'fail',
        detail: `Requires no more than ${condition.max} ${label} points in the ${condition.lookbackMonths}-month window ${window.start} to ${window.end}. Total: ${total} — ${describeThreshold(total, condition.max)}.`,
        evidenceUsed: [`${total} ${label} points in ${window.start} to ${window.end}`],
      };
    }

    case 'license_status_in': {
      if (evidence.licenseStatus === 'Unknown') {
        return {
          ...base,
          status: 'indeterminate',
          detail: `Requires license status in [${condition.statuses.join(', ')}]; the extracted status is unknown.`,
          dataGaps: ['License status could not be determined from the documents.'],
        };
      }
      const pass = condition.statuses.includes(evidence.licenseStatus);
      return {
        ...base,
        status: pass ? 'pass' : 'fail',
        detail: `Requires license status in [${condition.statuses.join(', ')}]; extracted status is ${evidence.licenseStatus}.`,
        evidenceUsed: [`License status: ${evidence.licenseStatus}`],
      };
    }

    case 'cdl_class_in': {
      if (!evidence.cdlClass) {
        return {
          ...base,
          status: 'indeterminate',
          detail: `Requires CDL class in [${condition.classes.join(', ')}]; no CDL class was extracted.`,
          dataGaps: ['CDL class is missing.'],
        };
      }
      const pass = condition.classes.some(
        (c) => c.toUpperCase() === evidence.cdlClass!.toUpperCase(),
      );
      return {
        ...base,
        status: pass ? 'pass' : 'fail',
        detail: `Requires CDL class in [${condition.classes.join(', ')}]; driver holds class ${evidence.cdlClass}.`,
        evidenceUsed: [`CDL class ${evidence.cdlClass}`],
      };
    }

    case 'requires_valid_medical_card': {
      const card = evidence.medicalCard;
      if (!card || !card.present) {
        return {
          ...base,
          status: 'indeterminate',
          detail:
            'Requires a valid medical examiner’s certificate; no medical card evidence is on file. Missing evidence is a review item, not a disqualification.',
          dataGaps: ['Medical examiner’s certificate is missing.'],
        };
      }
      if (!card.expirationDate) {
        return {
          ...base,
          status: 'indeterminate',
          detail:
            'Requires a valid medical examiner’s certificate; the card is on file but its expiration date could not be read.',
          dataGaps: ['Medical card expiration date could not be read.'],
        };
      }
      const expired = card.expirationDate < evidence.evaluationDate;
      if (expired) {
        return {
          ...base,
          status: 'indeterminate',
          detail: `The medical examiner’s certificate expired ${card.expirationDate}, before the evaluation date ${evidence.evaluationDate}. An expired card is a review item; only an explicit guideline disqualifier may reject on it.`,
          dataGaps: [`Medical certificate expired ${card.expirationDate}.`],
        };
      }
      return {
        ...base,
        status: 'pass',
        detail: `Medical examiner’s certificate is valid through ${card.expirationDate}.`,
        evidenceUsed: [`Medical certificate valid through ${card.expirationDate}`],
      };
    }

    case 'max_suspensions': {
      if (!evidence.mvrOrderDate) {
        return {
          ...base,
          status: 'indeterminate',
          detail: `Requires no more than ${condition.max} suspension(s) in ${condition.lookbackMonths} months, but the MVR order date is missing so the window cannot be anchored.`,
          dataGaps: ['MVR order/report date is missing; suspension lookback cannot be anchored.'],
        };
      }
      const window = lookbackWindow(evidence.mvrOrderDate, condition.lookbackMonths);
      const { inWindow, undated } = suspensionsInWindow(evidence.suspensions, window);
      if (undated.length > 0) {
        return {
          ...base,
          status: 'indeterminate',
          detail: `Requires no more than ${condition.max} suspension(s) in ${condition.lookbackMonths} months. ${undated.length} explicit suspension record(s) carry no usable date.`,
          dataGaps: undated.map((s) => `Suspension record "${s.description}" has no usable date.`),
        };
      }
      const pass = withinThreshold(inWindow.length, condition.max);
      return {
        ...base,
        status: pass ? 'pass' : 'fail',
        detail: `Requires no more than ${condition.max} suspension(s) in the ${condition.lookbackMonths}-month window ${window.start} to ${window.end}. Explicit suspension records found: ${inWindow.length} — ${describeThreshold(inWindow.length, condition.max)}.`,
        evidenceUsed: inWindow.map(
          (s) => `Suspension: ${s.description} (${s.startDate ?? 'undated'})`,
        ),
      };
    }
  }
}

/**
 * Extended view of normalized evidence with the license/CDL/medical fields the
 * conditions read. Kept separate from `NormalizedEvidence` so the normalizer
 * stays focused on MVR records and dates.
 */
export interface EngineEvidence extends NormalizedEvidence {
  licenseStatus: DriverEvidence['licenseStatus'];
  cdlClass: string | null;
  medicalCard: DriverEvidence['medicalCard'];
}

export function buildEngineEvidence(
  evidence: DriverEvidence,
  evaluationDate: IsoDate,
  options: { majorCategoryMappings?: Array<{ matches: string; category: string; guidelineReference: string }> } = {},
): EngineEvidence {
  const normalized = normalizeEvidence(evidence, evaluationDate, options);
  return {
    ...normalized,
    licenseStatus: evidence.licenseStatus,
    cdlClass: evidence.cdlClass,
    medicalCard: evidence.medicalCard,
  };
}

/* ------------------------------------------------------------------ *
 * Coverage evaluation
 * ------------------------------------------------------------------ */

function notEvaluated(
  companyId: string,
  coverageType: CoverageType,
  reason: string,
  evaluationDate: IsoDate,
  extractionFormatVersion: number,
): CoverageEvaluation {
  return {
    companyId,
    coverageType,
    decision: 'Not Evaluated',
    reason,
    guidelineId: null,
    guidelineVersion: null,
    guidelineName: null,
    eligibilityPath: null,
    criteriaApplied: [],
    evidenceUsed: [],
    excludedEvidence: [],
    dataGaps: [reason],
    paths: [],
    disqualifiersTriggered: [],
    underwritingConditions: [],
    experienceBand: 'unknown',
    experienceBandLabel: bandLabel('unknown'),
    completedExperienceMonths: null,
    engineVersion: ENGINE_VERSION,
    extractionFormatVersion,
    evaluationDate,
  };
}

/**
 * Evaluates one company/coverage pair against exactly one guideline.
 *
 * `guideline` must already be the active guideline for this company and this
 * coverage. The engine has no way to reach any other company's or coverage's
 * rules — isolation is structural, not a check that could be forgotten.
 */
export function evaluateCoverage(params: {
  companyId: string;
  coverageType: CoverageType;
  guideline: Guideline | null;
  evidence: DriverEvidence;
  evaluationDate: IsoDate;
}): CoverageEvaluation {
  const { companyId, coverageType, guideline, evidence, evaluationDate } = params;

  if (!guideline) {
    return notEvaluated(
      companyId,
      coverageType,
      `No active ${coverageType} guideline is configured for the selected company.`,
      evaluationDate,
      evidence.extractionFormatVersion,
    );
  }

  if (guideline.companyId !== companyId || guideline.coverageType !== coverageType) {
    throw new Error(
      `Guideline isolation violation: guideline ${guideline.id} belongs to company ${guideline.companyId}/${guideline.coverageType}, not ${companyId}/${coverageType}.`,
    );
  }

  if (!guideline.usedForDriverQualification) {
    return notEvaluated(
      companyId,
      coverageType,
      `The ${coverageType} policy for this company is tracked for compliance but is not used for driver qualification.`,
      evaluationDate,
      evidence.extractionFormatVersion,
    );
  }

  const guidelineName = guidelineDisplayName(guideline);

  // The guideline's own major mappings are applied while normalising, so a
  // severity only ever rises where that guideline authorises it.
  const majorCategoryMappings = guideline.ruleSet?.majorCategoryMappings ?? [];
  const engineEvidence = buildEngineEvidence(evidence, evaluationDate, { majorCategoryMappings });

  const months = engineEvidence.experience.months;
  const band = experienceBand(months);

  const shell = {
    companyId,
    coverageType,
    underwritingConditions: [] as string[],
    experienceBand: band,
    experienceBandLabel: bandLabel(band),
    completedExperienceMonths: months,
    guidelineId: guideline.id,
    guidelineVersion: guideline.version,
    guidelineName,
    engineVersion: ENGINE_VERSION,
    extractionFormatVersion: evidence.extractionFormatVersion,
    evaluationDate,
  };

  if (!isEvaluable(guideline)) {
    const why =
      guideline.status !== 'active'
        ? 'the guideline is archived'
        : guideline.ruleSet === null
          ? 'the guideline file has not been interpreted into evaluable criteria yet'
          : 'the interpreted criteria have not been approved by a reviewer yet';
    return {
      ...shell,
      decision: 'Manual Review',
      reason: `Held for manual review: ${why}. No decision can be issued from an unapproved interpretation.`,
      eligibilityPath: null,
      criteriaApplied: [],
      evidenceUsed: [],
      excludedEvidence: [],
      dataGaps: [`Guideline ${guidelineName} is not approved for automated evaluation (${why}).`],
      paths: [],
      disqualifiersTriggered: [],
    };
  }

  const ruleSet = guideline.ruleSet!;

  // Evidence-level blockers hold the applicant before any rule is applied.
  if (engineEvidence.blockers.length > 0) {
    return {
      ...shell,
      decision: 'Manual Review',
      reason: `Held for manual review before applying ${guidelineName}: ${engineEvidence.blockers
        .map((b) => b.message)
        .join(' ')}`,
      eligibilityPath: null,
      criteriaApplied: [],
      evidenceUsed: [],
      excludedEvidence: engineEvidence.discardedInferredSuspensions.map(
        (s) => `Discarded inferred suspension: ${s.description}`,
      ),
      dataGaps: engineEvidence.blockers.map((b) => b.message),
      paths: [],
      disqualifiersTriggered: [],
    };
  }

  const disqualifierOutcomes = ruleSet.disqualifiers.map((d) => ({
    disqualifier: d,
    outcome: evaluateCondition(d.condition, engineEvidence),
  }));

  // Banded paths cover mutually exclusive experience ranges, so at most one can
  // apply. Skipping the others as "not applicable" rather than evaluating them
  // is what stops a 17-month driver being reported against a two-year rule they
  // were never eligible for — and keeps their violation count compared with
  // their own band's limit.
  const guidelineIsBanded = ruleSet.eligibilityPaths.some(
    (p) => p.appliesToExperienceBand !== null,
  );

  const paths: PathOutcome[] = ruleSet.eligibilityPaths.map((path) => {
    const shared = {
      pathId: path.id,
      label: path.label,
      sourceText: path.sourceText,
      appliesToExperienceBand: path.appliesToExperienceBand,
      underwritingConditions: path.underwritingConditions,
    };

    if (path.appliesToExperienceBand !== null && path.appliesToExperienceBand !== band) {
      return {
        ...shared,
        status: 'not_applicable' as const,
        conditions: [],
        notApplicableReason:
          band === 'unknown'
            ? 'Experience could not be verified, so no experience-based branch applies.'
            : `This branch covers ${bandLabel(path.appliesToExperienceBand)}; the driver's ${months} completed months place them in ${bandLabel(band)}.`,
      };
    }

    const conditions = path.conditions.map((c) => evaluateCondition(c, engineEvidence));
    const status: ConditionStatus = conditions.some((c) => c.status === 'fail')
      ? 'fail'
      : conditions.some((c) => c.status === 'indeterminate')
        ? 'indeterminate'
        : 'pass';
    return { ...shared, status, conditions, notApplicableReason: null };
  });

  const applicablePaths = paths.filter((p) => p.status !== 'not_applicable');

  // A banded guideline with no applicable branch has not rejected the driver —
  // it simply does not cover them. That is a review item, not a failure.
  if (guidelineIsBanded && applicablePaths.length === 0) {
    return {
      ...shell,
      decision: 'Manual Review',
      reason:
        band === 'unknown'
          ? `Held for manual review under ${guidelineName}: the original CDL issue date could not be verified, so the applicable experience branch cannot be determined. ${engineEvidence.experience.reason}`
          : `Held for manual review under ${guidelineName}: the driver has ${months} completed months (${bandLabel(band)}) and this guideline defines no branch covering that experience. Confirm whether another path applies before deciding.`,
      eligibilityPath: null,
      criteriaApplied: [],
      evidenceUsed: [],
      excludedEvidence: [],
      dataGaps: [
        band === 'unknown'
          ? engineEvidence.experience.reason
          : `No eligibility branch covers ${bandLabel(band)}.`,
      ],
      paths,
      disqualifiersTriggered: [],
    };
  }

  // A disqualifier fires when its condition *fails* — the condition states the
  // acceptable state, so failing it is the disqualifying event.
  const firedDisqualifiers = disqualifierOutcomes.filter((d) => d.outcome.status === 'fail');
  const unresolvedDisqualifiers = disqualifierOutcomes.filter(
    (d) => d.outcome.status === 'indeterminate',
  );

  const collect = (outcomes: ConditionOutcome[], key: 'evidenceUsed' | 'excludedEvidence' | 'dataGaps') =>
    Array.from(new Set(outcomes.flatMap((o) => o[key])));

  if (firedDisqualifiers.length > 0) {
    const outcomes = firedDisqualifiers.map((d) => d.outcome);
    return {
      ...shell,
      decision: 'Not Qualified',
      reason: `Disqualified under ${guidelineName}: ${firedDisqualifiers
        .map((d) => `${d.disqualifier.label} — ${d.outcome.detail}`)
        .join(' ')}`,
      eligibilityPath: null,
      criteriaApplied: firedDisqualifiers.map((d) =>
        d.disqualifier.sourceText
          ? `${d.disqualifier.label}: "${d.disqualifier.sourceText}"`
          : d.disqualifier.label,
      ),
      evidenceUsed: collect(outcomes, 'evidenceUsed'),
      excludedEvidence: collect(outcomes, 'excludedEvidence'),
      dataGaps: collect(outcomes, 'dataGaps'),
      paths,
      disqualifiersTriggered: firedDisqualifiers.map((d) => d.disqualifier.label),
    };
  }

  const passingPath = applicablePaths.find((p) => p.status === 'pass');

  if (passingPath && unresolvedDisqualifiers.length === 0) {
    return {
      ...shell,
      decision: 'Qualified',
      underwritingConditions: passingPath.underwritingConditions,
      reason: `Qualified under ${guidelineName} via ${passingPath.label}: every condition on this eligibility path is satisfied by verified evidence, and no disqualifier applies.${
        passingPath.underwritingConditions.length
          ? ` This branch carries underwriting condition(s): ${passingPath.underwritingConditions.join('; ')}. These are terms on the placement, not grounds for rejecting the driver.`
          : ''
      }`,
      eligibilityPath: passingPath.label,
      criteriaApplied: passingPath.conditions.map((c) => describeCondition(c.condition)),
      evidenceUsed: collect(passingPath.conditions, 'evidenceUsed'),
      excludedEvidence: collect(passingPath.conditions, 'excludedEvidence'),
      dataGaps: [],
      paths,
      disqualifiersTriggered: [],
    };
  }

  if (unresolvedDisqualifiers.length > 0) {
    const outcomes = unresolvedDisqualifiers.map((d) => d.outcome);
    return {
      ...shell,
      decision: 'Manual Review',
      reason: `Held for manual review under ${guidelineName}: a disqualifying criterion cannot be resolved from the available evidence — ${unresolvedDisqualifiers
        .map((d) => `${d.disqualifier.label} (${d.outcome.detail})`)
        .join('; ')}.`,
      eligibilityPath: passingPath ? passingPath.label : null,
      criteriaApplied: unresolvedDisqualifiers.map((d) => d.disqualifier.label),
      evidenceUsed: collect(outcomes, 'evidenceUsed'),
      excludedEvidence: collect(outcomes, 'excludedEvidence'),
      dataGaps: collect(outcomes, 'dataGaps'),
      paths,
      disqualifiersTriggered: [],
    };
  }

  const indeterminatePaths = applicablePaths.filter((p) => p.status === 'indeterminate');
  if (indeterminatePaths.length > 0) {
    const outcomes = indeterminatePaths.flatMap((p) =>
      p.conditions.filter((c) => c.status === 'indeterminate'),
    );
    return {
      ...shell,
      decision: 'Manual Review',
      reason: `Held for manual review under ${guidelineName}: no eligibility path is decidable on the evidence available. ${indeterminatePaths
        .map(
          (p) =>
            `${p.label} is undetermined because ${p.conditions
              .filter((c) => c.status === 'indeterminate')
              .map((c) => c.detail)
              .join(' ')}`,
        )
        .join(' ')} Missing evidence is never treated as proof that the driver is not qualified.`,
      eligibilityPath: null,
      criteriaApplied: indeterminatePaths.flatMap((p) =>
        p.conditions.map((c) => describeCondition(c.condition)),
      ),
      evidenceUsed: collect(
        indeterminatePaths.flatMap((p) => p.conditions),
        'evidenceUsed',
      ),
      excludedEvidence: collect(
        indeterminatePaths.flatMap((p) => p.conditions),
        'excludedEvidence',
      ),
      dataGaps: collect(outcomes, 'dataGaps'),
      paths,
      disqualifiersTriggered: [],
    };
  }

  // Every applicable path was decidable and every one failed.
  const allConditions = applicablePaths.flatMap((p) => p.conditions);
  return {
    ...shell,
    decision: 'Not Qualified',
    reason: `Not qualified under ${guidelineName}: every applicable eligibility path was evaluated on verified evidence and each one fails. ${applicablePaths
      .map(
        (p) =>
          `${p.label} fails because ${p.conditions
            .filter((c) => c.status === 'fail')
            .map((c) => c.detail)
            .join(' ')}`,
      )
      .join(' ')}`,
    eligibilityPath: null,
    criteriaApplied: applicablePaths.map((p) =>
      p.sourceText ? `${p.label}: "${p.sourceText}"` : p.label,
    ),
    evidenceUsed: collect(allConditions, 'evidenceUsed'),
    excludedEvidence: collect(allConditions, 'excludedEvidence'),
    dataGaps: [],
    paths,
    disqualifiersTriggered: [],
  };
}

/* ------------------------------------------------------------------ *
 * Driver-level decision
 * ------------------------------------------------------------------ */

export interface OverallDecision {
  decision: Decision;
  reason: string;
  controllingCoverage: CoverageType;
  controllingDecision: Decision;
}

/**
 * The driver-level decision is a pure function of the Auto Liability result for
 * the selected company. No other coverage can move it.
 *
 * The one place the two differ: Auto Liability `Not Evaluated` (no active driver
 * guideline) becomes `Manual Review` at driver level, because "we have not
 * configured a rule" is a review item, not a neutral outcome for a person.
 */
export function overallDecision(
  coverageEvaluations: CoverageEvaluation[],
  companyName?: string,
): OverallDecision {
  const auto = coverageEvaluations.find((e) => e.coverageType === CONTROLLING_COVERAGE);
  const company = companyName ? `${companyName}` : 'the selected company';

  if (!auto || auto.decision === 'Not Evaluated') {
    return {
      decision: 'Manual Review',
      reason: `No active Auto Liability driver guideline is configured for ${company}, so the driver-level decision cannot be issued automatically. Add an approved Auto Liability driver guideline for ${company} to evaluate this driver.`,
      controllingCoverage: CONTROLLING_COVERAGE,
      controllingDecision: auto ? auto.decision : 'Not Evaluated',
    };
  }

  const others = coverageEvaluations.filter(
    (e) => e.coverageType !== CONTROLLING_COVERAGE && e.decision !== 'Not Evaluated',
  );
  const otherNote = others.length
    ? ` Results for ${others
        .map((o) => `${o.coverageType} (${o.decision})`)
        .join(', ')} are reported separately and do not affect the driver-level decision.`
    : '';

  return {
    decision: auto.decision,
    reason: `Auto Liability is the controlling driver-qualification coverage for ${company}. The driver-level decision is ${auto.decision} because the Auto Liability evaluation returned ${auto.decision}.${otherNote}`,
    controllingCoverage: CONTROLLING_COVERAGE,
    controllingDecision: auto.decision,
  };
}
