import type { Guideline, RuleSet } from '@/domain/guideline';
import {
  CURRENT_EXTRACTION_FORMAT_VERSION,
  emptyEvidence,
  type CoverageType,
  type DriverEvidence,
  type MvrEvent,
} from '@/domain/types';

export function event(partial: Partial<MvrEvent> & { description: string }): MvrEvent {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    description: partial.description,
    violationDate: partial.violationDate ?? null,
    convictionDate: partial.convictionDate ?? null,
    state: partial.state ?? 'OH',
    statePoints: partial.statePoints ?? null,
    mvrActivityPoints: partial.mvrActivityPoints ?? null,
    disposition: partial.disposition ?? null,
    eventType: partial.eventType ?? 'Unknown',
    severity: partial.severity ?? 'Unknown',
    reviewerConfirmed: partial.reviewerConfirmed,
    atFault: partial.atFault ?? null,
    preventable: partial.preventable ?? null,
  };
}

export function evidence(overrides: Partial<DriverEvidence> = {}): DriverEvidence {
  return {
    ...emptyEvidence(),
    extractionFormatVersion: CURRENT_EXTRACTION_FORMAT_VERSION,
    licenseStatus: 'Valid',
    cdlClass: 'A',
    cdlState: 'OH',
    medicalCard: { present: true, expirationDate: '2027-01-01', examinerName: 'Dr. Lee' },
    ...overrides,
  };
}

export function guideline(overrides: Partial<Guideline> & { companyId: string; ruleSet: RuleSet | null }): Guideline {
  return {
    id: overrides.id ?? `gl_${overrides.companyId}`,
    companyId: overrides.companyId,
    coverageType: (overrides.coverageType ?? 'Auto Liability') as CoverageType,
    version: overrides.version ?? '1',
    status: overrides.status ?? 'active',
    effectiveDate: overrides.effectiveDate ?? '2026-01-01',
    expirationDate: overrides.expirationDate ?? null,
    carrier: overrides.carrier ?? null,
    policyNumber: overrides.policyNumber ?? null,
    fileName: overrides.fileName ?? 'guideline.pdf',
    usedForDriverQualification: overrides.usedForDriverQualification ?? true,
    reviewStatus: overrides.reviewStatus ?? 'approved',
    ruleSet: overrides.ruleSet,
  };
}

/**
 * Zone-OH LLC's Auto Liability driver criteria, expressed as a rule tree with
 * two alternative paths — the shape that makes "two years" a branch rather than
 * an absolute requirement.
 */
export const ZONE_AUTO_LIABILITY: RuleSet = {
  schemaVersion: 1,
  notes: 'Zone-OH LLC Auto Liability driver criteria.',
  eligibilityPaths: [
    {
      id: 'path.two_year',
      label: 'Two-year experience path',
      sourceText:
        'Drivers with two (2) or more years of verifiable CDL experience: maximum of three (3) moving violations in the preceding 36 months.',
      conditions: [
        { type: 'min_experience_months', months: 24 },
        { type: 'max_events', category: 'moving_violation', lookbackMonths: 36, max: 3 },
        { type: 'max_events', category: 'major_moving_violation', lookbackMonths: 60, max: 0 },
        { type: 'license_status_in', statuses: ['Valid'] },
      ],
    },
    {
      id: 'path.one_year',
      label: 'One-year experience path',
      sourceText:
        'Drivers with at least one (1) year of verifiable CDL experience: maximum of one (1) moving violation in the preceding 36 months.',
      conditions: [
        { type: 'min_experience_months', months: 12 },
        { type: 'max_events', category: 'moving_violation', lookbackMonths: 36, max: 1 },
        { type: 'max_events', category: 'major_moving_violation', lookbackMonths: 60, max: 0 },
        { type: 'license_status_in', statuses: ['Valid'] },
      ],
    },
  ],
  disqualifiers: [],
};

/** Xtrack LLC is deliberately stricter, so company isolation is observable. */
export const XTRACK_AUTO_LIABILITY: RuleSet = {
  schemaVersion: 1,
  notes: 'Xtrack LLC Auto Liability driver criteria.',
  eligibilityPaths: [
    {
      id: 'path.standard',
      label: 'Standard path',
      sourceText:
        'Minimum three (3) years CDL experience and no moving violations in the preceding 36 months.',
      conditions: [
        { type: 'min_experience_months', months: 36 },
        { type: 'max_events', category: 'moving_violation', lookbackMonths: 36, max: 0 },
        { type: 'license_status_in', statuses: ['Valid'] },
      ],
    },
  ],
  disqualifiers: [],
};

/** Phenias Mugisha — acceptance case 5.1. */
export function pheniasEvidence(overrides: Partial<DriverEvidence> = {}): DriverEvidence {
  return evidence({
    mvrOrderDate: '2026-07-31',
    cdlOriginalIssueDate: '2023-03-15',
    dateOfBirth: '1990-04-02',
    events: [
      event({
        id: 'ph1',
        description: 'Abandoned Vehicle Fee Due',
        violationDate: '2021-10-20',
        statePoints: 0,
        mvrActivityPoints: 0,
      }),
      event({
        id: 'ph2',
        description: 'Fail to Appear - Trial/Court',
        violationDate: '2023-05-02',
        convictionDate: '2023-09-07',
        statePoints: 0,
        mvrActivityPoints: 0,
      }),
      event({
        id: 'ph3',
        description: 'Limitations on Backing',
        violationDate: '2024-05-20',
        convictionDate: '2024-07-24',
        statePoints: 2,
        mvrActivityPoints: 4,
      }),
    ],
    ...overrides,
  });
}

/** Fabrice Karambizi — acceptance case 5.2. */
export function fabriceEvidence(overrides: Partial<DriverEvidence> = {}): DriverEvidence {
  return evidence({
    mvrOrderDate: '2026-08-01',
    cdlOriginalIssueDate: '2024-06-15',
    cdlCurrentIssueDate: '2025-11-02',
    cdlExpirationDate: '2029-11-02',
    dateOfBirth: '1995-02-11',
    events: [],
    ...overrides,
  });
}
