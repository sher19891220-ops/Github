import { describe, expect, it } from 'vitest';
import { evaluateCoverage } from '@/domain/engine';
import { ruleSetSchema, type RuleSet } from '@/domain/guideline';
import { resolveOriginalIssueDate } from '@/domain/cdl-dates';
import { experienceBand, withinThreshold } from '@/domain/experience';
import { classifyDescription } from '@/domain/classification';
import { deduplicateEvents, normalizeEvidence, countEvents } from '@/domain/evidence';
import { lookbackWindow } from '@/domain/dates';
import { evidence, event, guideline } from '../fixtures';

const EVAL_DATE = '2026-08-19';

/**
 * The banded guideline from §4.4: two mutually exclusive experience branches,
 * the one-year branch carrying a deductible condition rather than a rejection.
 */
const BANDED: RuleSet = ruleSetSchema.parse({
  schemaVersion: 1,
  eligibilityPaths: [
    {
      id: 'path.two_year',
      label: '2-year driver criteria',
      sourceText: 'Drivers with two years of verifiable experience: maximum 3 minor violations and 1 accident in 36 months, no major violations.',
      appliesToExperienceBand: 'two_year',
      conditions: [
        { type: 'max_events', category: 'minor_moving_violation', lookbackMonths: 36, max: 3 },
        { type: 'max_events', category: 'accident', lookbackMonths: 36, max: 1 },
        { type: 'max_events', category: 'major_moving_violation', lookbackMonths: 60, max: 0 },
      ],
    },
    {
      id: 'path.one_year',
      label: '1-year driver criteria',
      sourceText: 'Drivers with one year of experience: maximum 1 minor violation, no accidents, no major violations.',
      appliesToExperienceBand: 'one_year',
      underwritingConditions: [
        'Increase deductible by 100%, with a minimum deductible of $5,000, whichever is greater.',
      ],
      conditions: [
        { type: 'max_events', category: 'minor_moving_violation', lookbackMonths: 36, max: 1 },
        { type: 'max_events', category: 'accident', lookbackMonths: 36, max: 0 },
        { type: 'max_events', category: 'major_moving_violation', lookbackMonths: 60, max: 0 },
      ],
    },
  ],
  disqualifiers: [],
});

function evaluate(driverEvidence: ReturnType<typeof evidence>, ruleSet: RuleSet = BANDED) {
  return evaluateCoverage({
    companyId: 'zone',
    coverageType: 'Auto Liability',
    guideline: guideline({ companyId: 'zone', ruleSet }),
    evidence: driverEvidence,
    evaluationDate: EVAL_DATE,
  });
}

/** Evidence with a given experience and a set of minor violations. */
function driver(monthsAgoIssued: number, minorCount: number, extra = {}) {
  const issue = new Date(Date.UTC(2026, 7 - monthsAgoIssued, 19)).toISOString().slice(0, 10);
  return evidence({
    mvrOrderDate: '2026-08-01',
    cdlOriginalIssueDate: issue,
    events: Array.from({ length: minorCount }, (_, i) =>
      event({
        id: `m${i}`,
        description: 'Speeding',
        violationDate: `2025-0${(i % 8) + 1}-10`,
        convictionDate: `2025-0${(i % 8) + 1}-20`,
        statePoints: 2,
        mvrActivityPoints: 2,
      }),
    ),
    ...extra,
  });
}

/* ================================================================== *
 * 5.5 Abdallahi Doro — threshold case
 * ================================================================== */

describe('Acceptance 5.5 — Abdallahi Doro threshold case', () => {
  it('places 17 months in the 1-year band, not a failed 2-year driver', () => {
    expect(experienceBand(17)).toBe('one_year');
  });

  it('compares 2 minor violations against the 1-year maximum of 1, and shows 2 > 1', () => {
    const result = evaluate(driver(17, 2));

    expect(result.decision).toBe('Not Qualified');
    expect(result.experienceBandLabel).toBe('1-year driver criteria');
    expect(result.reason).toMatch(/2 > 1/);

    // It must not measure the driver against the two-year branch's limit of 3.
    expect(result.reason).not.toMatch(/2 > 3|2 ≤ 3/);
    const twoYear = result.paths.find((p) => p.pathId === 'path.two_year')!;
    expect(twoYear.status).toBe('not_applicable');
    expect(twoYear.notApplicableReason).toMatch(/17 completed months/);
  });

  it('the same driver at 24 months uses the 2-year branch, where 2 ≤ 3 passes', () => {
    const result = evaluate(driver(24, 2));

    expect(result.decision).toBe('Qualified');
    expect(result.experienceBandLabel).toBe('2-year driver criteria');
    expect(result.reason).toMatch(/2-year driver criteria/);

    const applied = result.paths.find((p) => p.pathId === 'path.two_year')!;
    expect(applied.conditions.some((c) => c.detail.includes('2 ≤ 3'))).toBe(true);
  });

  it('never treats a passed threshold as a failure', () => {
    // The rule that "any violation disqualifies" is exactly what §4.4 forbids.
    expect(evaluate(driver(24, 1)).decision).toBe('Qualified');
    expect(evaluate(driver(24, 3)).decision).toBe('Qualified');
    expect(evaluate(driver(24, 4)).decision).toBe('Not Qualified');
    expect(evaluate(driver(17, 1)).decision).toBe('Qualified');
  });
});

/* ================================================================== *
 * §4.4 — the deductible condition is not a rejection
 * ================================================================== */

describe('Underwriting conditions', () => {
  it('qualifies a compliant 1-year driver and surfaces the deductible condition', () => {
    const result = evaluate(driver(17, 1));

    expect(result.decision).toBe('Qualified');
    expect(result.underwritingConditions).toHaveLength(1);
    expect(result.underwritingConditions[0]).toMatch(/deductible by 100%/);
    expect(result.underwritingConditions[0]).toMatch(/\$5,000/);
    expect(result.reason).toMatch(/not grounds for rejecting the driver/);
  });

  it('attaches no condition to the 2-year branch', () => {
    expect(evaluate(driver(30, 2)).underwritingConditions).toHaveLength(0);
  });

  it('holds an under-1-year driver for review rather than rejecting them', () => {
    // The guideline defines no branch for them; that is absence of coverage,
    // not a finding against the driver.
    const result = evaluate(driver(8, 0));
    expect(result.decision).toBe('Manual Review');
    expect(result.experienceBandLabel).toBe('Under 1 year');
    expect(result.reason).toMatch(/defines no branch covering that experience/);
  });

  it('holds for review when experience cannot be verified', () => {
    const result = evaluate(driver(30, 0, { cdlOriginalIssueDate: null }));
    expect(result.decision).toBe('Manual Review');
    expect(result.experienceBand).toBe('unknown');
    expect(result.reason).toMatch(/could not be verified/);
  });
});

/* ================================================================== *
 * 5.6 Major-classification safeguard
 * ================================================================== */

describe('Acceptance 5.6 — major-classification safeguard', () => {
  it('classifies FAIL TO HAVE VEHICLE UNDER CONTROL as a minor moving violation', () => {
    const c = classifyDescription('FAIL TO HAVE VEHICLE UNDER CONTROL');
    expect(c.eventType).toBe('Moving Violation');
    expect(c.severity).toBe('Minor');
  });

  it.each(['Careless driving', 'Inattentive driving', 'Negligent driving', 'Improper driving'])(
    'keeps "%s" minor without an explicit guideline mapping',
    (description) => {
      expect(classifyDescription(description).severity).toBe('Minor');
    },
  );

  it('does not silently strengthen an ambiguous offence into a major', () => {
    const result = evaluate(
      driver(30, 0, {
        events: [
          event({
            description: 'FAIL TO HAVE VEHICLE UNDER CONTROL',
            violationDate: '2025-03-01',
            convictionDate: '2025-04-01',
            statePoints: 2,
            mvrActivityPoints: 2,
          }),
        ],
      }),
    );
    // Minor, so 1 ≤ 3 on the two-year branch: qualified, not rejected as major.
    expect(result.decision).toBe('Qualified');
  });

  it('elevates it only where the guideline says so, recording the authority', () => {
    const mapped = ruleSetSchema.parse({
      ...BANDED,
      majorCategoryMappings: [
        {
          matches: 'vehicle under control',
          category: 'Careless / Improper Driving',
          guidelineReference: 'Zone AL guideline §3.2, "loss of vehicle control is treated as improper driving".',
        },
      ],
    });

    const driverEvidence = driver(30, 0, {
      events: [
        event({
          description: 'FAIL TO HAVE VEHICLE UNDER CONTROL',
          violationDate: '2025-03-01',
          convictionDate: '2025-04-01',
          statePoints: 2,
          mvrActivityPoints: 2,
        }),
      ],
    });

    const result = evaluate(driverEvidence, mapped);
    expect(result.decision).toBe('Not Qualified');
    expect(result.reason).toMatch(/major moving violation/);

    // The authority for the elevation must be recorded on the event itself.
    const normalized = normalizeEvidence(driverEvidence, EVAL_DATE, {
      majorCategoryMappings: mapped.majorCategoryMappings,
    });
    const elevated = normalized.events[0]!;
    expect(elevated.severity).toBe('Major');
    expect(elevated.majorClassification).toMatchObject({
      eventDescription: 'FAIL TO HAVE VEHICLE UNDER CONTROL',
      matchedCategory: 'Careless / Improper Driving',
    });
    expect(elevated.majorClassification!.guidelineReference).toMatch(/§3.2/);
  });

  it('still classifies unambiguous majors from the record itself', () => {
    expect(classifyDescription('Reckless driving').severity).toBe('Major');
    expect(classifyDescription('DUI').severity).toBe('Major');
    expect(classifyDescription('Leaving the scene of an accident').severity).toBe('Major');
  });
});

/* ================================================================== *
 * §4.1 CDL issue-date provenance
 * ================================================================== */

describe('CDL issue-date precedence', () => {
  const cdlOriginal = {
    date: '2019-04-08',
    sourceDocument: 'CDL' as const,
    printedLabel: 'ORIG ISS',
    explicitlyOriginal: true,
  };
  const mvrStateIssue = {
    date: '2024-11-02',
    sourceDocument: 'MVR' as const,
    printedLabel: 'STATE ISSUE DATE',
    explicitlyOriginal: false,
  };

  it('a verified original on the CDL beats a later MVR state issuance', () => {
    const resolved = resolveOriginalIssueDate([mvrStateIssue, cdlOriginal]);
    expect(resolved.date).toBe('2019-04-08');
    expect(resolved.reason).toMatch(/does not replace it/);
    expect(resolved.reason).toMatch(/does not restart CDL experience/);
  });

  it('refuses to guess when no document labels a date as the original', () => {
    const resolved = resolveOriginalIssueDate([mvrStateIssue]);
    expect(resolved.date).toBeNull();
    expect(resolved.reason).toMatch(/none is labelled as the original/);
  });

  it('prefers the licence over another document that also claims original', () => {
    const resolved = resolveOriginalIssueDate([
      { date: '2020-01-01', sourceDocument: 'PSP', printedLabel: 'CDL SINCE', explicitlyOriginal: true },
      cdlOriginal,
    ]);
    expect(resolved.chosen!.sourceDocument).toBe('CDL');
  });

  it('accepts an explicit original from another document when the CDL has none', () => {
    const resolved = resolveOriginalIssueDate([
      mvrStateIssue,
      { date: '2018-06-01', sourceDocument: 'MVR', printedLabel: 'CDL SINCE', explicitlyOriginal: true },
    ]);
    expect(resolved.date).toBe('2018-06-01');
  });

  it('drives the experience calculation through the candidates', () => {
    const normalized = normalizeEvidence(
      evidence({
        mvrOrderDate: '2026-08-01',
        cdlOriginalIssueDate: '2024-11-02', // the wrong one, if trusted blindly
        cdlIssueDateCandidates: [mvrStateIssue, cdlOriginal],
      }),
      EVAL_DATE,
    );
    expect(normalized.experience.originalIssueDate).toBe('2019-04-08');
    expect(normalized.experience.months).toBe(88);
  });

  it('holds for review when candidates exist but none is authoritative', () => {
    const normalized = normalizeEvidence(
      evidence({ mvrOrderDate: '2026-08-01', cdlIssueDateCandidates: [mvrStateIssue] }),
      EVAL_DATE,
    );
    expect(normalized.experience.months).toBeNull();
    expect(normalized.experience.reason).toMatch(/Cannot calculate/);
  });
});

/* ================================================================== *
 * PSP handling
 * ================================================================== */

describe('PSP documents', () => {
  it('never counts a roadside inspection as a moving violation', () => {
    const normalized = normalizeEvidence(
      evidence({
        mvrOrderDate: '2026-08-01',
        events: [
          event({
            id: 'insp',
            description: 'Roadside inspection — no violations',
            violationDate: '2025-06-01',
            source: 'PSP',
            isInspection: true,
          }),
        ],
      }),
      EVAL_DATE,
    );
    const { count, counted } = countEvents(
      normalized.events,
      'moving_violation',
      lookbackWindow('2026-08-01', 36),
    );
    expect(count).toBe(0);
    expect(counted[0]!.exclusionReason).toMatch(/inspections never count/);
  });

  it('counts an incident once when it appears on both the MVR and the PSP', () => {
    const shared = { violationDate: '2025-03-01', convictionDate: '2025-04-01' };
    const { kept, duplicates } = deduplicateEvents([
      event({ id: 'mvr1', description: 'Speeding 15 MPH over', source: 'MVR', ...shared }),
      event({ id: 'psp1', description: 'SPEEDING 15 MPH OVER.', source: 'PSP', ...shared }),
    ]);

    expect(kept).toHaveLength(1);
    expect(kept[0]!.source).toBe('MVR'); // the conviction record wins
    expect(duplicates).toHaveLength(1);
  });

  it('keeps genuinely different incidents apart', () => {
    const { kept } = deduplicateEvents([
      event({ id: 'a', description: 'Speeding', violationDate: '2025-03-01' }),
      event({ id: 'b', description: 'Speeding', violationDate: '2025-09-01' }),
    ]);
    expect(kept).toHaveLength(2);
  });

  it('reports deduplication so a reviewer can see both documents had it', () => {
    const shared = { violationDate: '2025-03-01', convictionDate: '2025-04-01' };
    const normalized = normalizeEvidence(
      evidence({
        mvrOrderDate: '2026-08-01',
        events: [
          event({ id: 'mvr1', description: 'Improper lane change', source: 'MVR', ...shared }),
          event({ id: 'psp1', description: 'Improper Lane Change', source: 'PSP', ...shared }),
        ],
      }),
      EVAL_DATE,
    );
    expect(normalized.events).toHaveLength(1);
    expect(normalized.warnings.join(' ')).toMatch(/appeared on more than one document/);
  });
});

/* ================================================================== *
 * §17 threshold matrix
 * ================================================================== */

describe('Inclusive thresholds', () => {
  it.each([
    [1, 3, true],
    [3, 3, true],
    [4, 3, false],
    [1, 1, true],
    [2, 1, false],
    [0, 0, true],
    [1, 0, false],
  ])('%i against a maximum of %i => %s', (count, maximum, expected) => {
    expect(withinThreshold(count, maximum)).toBe(expected);
  });
});

describe('Experience banding', () => {
  it.each([
    [null, 'unknown'],
    [0, 'under_one_year'],
    [11, 'under_one_year'],
    [12, 'one_year'],
    [17, 'one_year'],
    [23, 'one_year'],
    [24, 'two_year'],
    [28, 'two_year'],
    [120, 'two_year'],
  ])('%s completed months => %s', (months, band) => {
    expect(experienceBand(months as number | null)).toBe(band);
  });
});
