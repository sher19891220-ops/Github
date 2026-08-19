import { describe, expect, it } from 'vitest';
import { lookbackWindow } from '@/domain/dates';
import { countEvents, normalizeEvidence } from '@/domain/evidence';
import { evaluateCoverage, overallDecision, type CoverageEvaluation } from '@/domain/engine';
import type { CoverageType } from '@/domain/types';
import {
  ZONE_AUTO_LIABILITY,
  XTRACK_AUTO_LIABILITY,
  fabriceEvidence,
  guideline,
  pheniasEvidence,
} from '../fixtures';

const EVAL_DATE = '2026-08-19';

/* ================================================================== *
 * 5.1 Phenias Mugisha
 * ================================================================== */

describe('Acceptance 5.1 — Phenias Mugisha', () => {
  const normalized = normalizeEvidence(pheniasEvidence(), EVAL_DATE);
  const window = lookbackWindow('2026-07-31', 36);

  it('anchors the 36-month window on the MVR order date, not today', () => {
    expect(window.start).toBe('2023-07-31');
    expect(window.end).toBe('2026-07-31');
  });

  it('treats the Abandoned Vehicle Fee as Administrative and out of window', () => {
    const { counted } = countEvents(normalized.events, 'moving_violation', window);
    const row = counted.find((c) => /abandoned/i.test(c.event.description))!;
    expect(row.event.eventType).toBe('Administrative');
    expect(row.countable).toBe(false);
    // Excluded on the window first — it is dated 2021-10-20.
    expect(row.exclusionReason).toMatch(/before the 36-month window/i);
  });

  it('treats Fail to Appear as Administrative even though it is inside the window', () => {
    const { counted } = countEvents(normalized.events, 'moving_violation', window);
    const row = counted.find((c) => /appear/i.test(c.event.description))!;
    expect(row.event.eventType).toBe('Administrative');
    expect(row.event.effectiveDate).toBe('2023-09-07');
    expect(row.countable).toBe(false);
    expect(row.exclusionReason).toMatch(/not a moving violation/i);
  });

  it('counts Limitations on Backing as the only countable moving violation', () => {
    const { counted, count } = countEvents(normalized.events, 'moving_violation', window);
    expect(count).toBe(1);
    const countable = counted.filter((c) => c.countable);
    expect(countable).toHaveLength(1);
    expect(countable[0]!.event.description).toBe('Limitations on Backing');
    expect(countable[0]!.event.severity).toBe('Minor');
  });

  it('counts 1 moving violation, not 3', () => {
    const { count } = countEvents(normalized.events, 'moving_violation', window);
    expect(count).toBe(1);
    expect(count).not.toBe(3);
  });

  it('invents no red-light violation and infers no suspension', () => {
    const descriptions = normalized.events.map((e) => e.description);
    expect(descriptions).toEqual([
      'Abandoned Vehicle Fee Due',
      'Fail to Appear - Trial/Court',
      'Limitations on Backing',
    ]);
    expect(descriptions.some((d) => /red light/i.test(d))).toBe(false);
    expect(normalized.suspensions).toHaveLength(0);
  });

  it('qualifies for Zone-OH LLC via the one-year path without importing a two-year requirement', () => {
    const result = evaluateCoverage({
      companyId: 'zone',
      coverageType: 'Auto Liability',
      guideline: guideline({ companyId: 'zone', ruleSet: ZONE_AUTO_LIABILITY }),
      evidence: pheniasEvidence(),
      evaluationDate: EVAL_DATE,
    });

    expect(result.decision).toBe('Qualified');
    // Experience from 2023-03-15 is 41 months, so both paths are open; the
    // engine must not reject on a stricter branch it was never required to use.
    expect(result.eligibilityPath).toBeTruthy();
    expect(result.excludedEvidence.join(' ')).toMatch(/Abandoned Vehicle Fee Due/);
    expect(result.excludedEvidence.join(' ')).toMatch(/Fail to Appear/);
    expect(result.evidenceUsed.join(' ')).toMatch(/Limitations on Backing/);
  });

  it('qualifies via the one-year path when experience is under two years', () => {
    const result = evaluateCoverage({
      companyId: 'zone',
      coverageType: 'Auto Liability',
      guideline: guideline({ companyId: 'zone', ruleSet: ZONE_AUTO_LIABILITY }),
      // 18 months of experience: the two-year path is unavailable, the
      // one-year path (max 1 moving violation) is satisfied by the single
      // countable backing violation.
      evidence: pheniasEvidence({ cdlOriginalIssueDate: '2025-02-19' }),
      evaluationDate: EVAL_DATE,
    });
    expect(result.decision).toBe('Qualified');
    expect(result.eligibilityPath).toBe('One-year experience path');
  });
});

/* ================================================================== *
 * 5.2 Fabrice Karambizi
 * ================================================================== */

describe('Acceptance 5.2 — Fabrice Karambizi', () => {
  it('computes 26 completed months from a 2024-06-15 original issue date', () => {
    const normalized = normalizeEvidence(fabriceEvidence(), EVAL_DATE);
    expect(normalized.experience.months).toBe(26);
    expect(normalized.experience.originalIssueDate).toBe('2024-06-15');
  });

  it('satisfies a two-year minimum at 26 months', () => {
    const normalized = normalizeEvidence(fabriceEvidence(), EVAL_DATE);
    expect(normalized.experience.months!).toBeGreaterThanOrEqual(24);
  });

  it('reports the original issue date and derived months in the evidence used', () => {
    const result = evaluateCoverage({
      companyId: 'zone',
      coverageType: 'Auto Liability',
      guideline: guideline({ companyId: 'zone', ruleSet: ZONE_AUTO_LIABILITY }),
      evidence: fabriceEvidence(),
      evaluationDate: EVAL_DATE,
    });
    expect(result.decision).toBe('Qualified');
    expect(result.eligibilityPath).toBe('Two-year experience path');
    expect(result.evidenceUsed.join(' ')).toMatch(/Original CDL issue date 2024-06-15/);
    expect(result.evidenceUsed.join(' ')).toMatch(/26 completed months/);
  });

  it('never lets the renewal date replace the original issue date', () => {
    // The current card was issued 2025-11-02; using it would yield 9 months and
    // wrongly fail a two-year minimum.
    const normalized = normalizeEvidence(fabriceEvidence(), EVAL_DATE);
    expect(normalized.experience.months).toBe(26);
    expect(normalized.experience.months).not.toBe(9);
  });

  it('never states that 28 months is less than two years', () => {
    const result = evaluateCoverage({
      companyId: 'zone',
      coverageType: 'Auto Liability',
      guideline: guideline({ companyId: 'zone', ruleSet: ZONE_AUTO_LIABILITY }),
      evidence: fabriceEvidence({ cdlOriginalIssueDate: '2024-04-19' }),
      evaluationDate: EVAL_DATE,
    });
    const narrative = [result.reason, ...result.evidenceUsed, ...result.criteriaApplied].join(' ');
    expect(narrative).not.toMatch(/28\s*months?\s+(is\s+)?(less|fewer)\s+than\s+(2|two)\s*years?/i);
    expect(result.decision).toBe('Qualified');
  });
});

/* ================================================================== *
 * 5.3 Coverage isolation
 * ================================================================== */

describe('Acceptance 5.3 — coverage isolation', () => {
  function fixed(coverageType: CoverageType, decision: CoverageEvaluation['decision']): CoverageEvaluation {
    return {
      companyId: 'zone',
      coverageType,
      decision,
      reason: `${coverageType} fixture`,
      guidelineId: `gl_${coverageType}`,
      guidelineVersion: '1',
      guidelineName: coverageType,
      eligibilityPath: null,
      criteriaApplied: [],
      evidenceUsed: [],
      excludedEvidence: [],
      dataGaps: [],
      paths: [],
      disqualifiersTriggered: [],
      engineVersion: 'test',
      extractionFormatVersion: 3,
      evaluationDate: EVAL_DATE,
    };
  }

  it('returns Qualified overall when Auto Liability is Qualified regardless of other coverages', () => {
    const overall = overallDecision(
      [
        fixed('Auto Liability', 'Qualified'),
        fixed('General Liability', 'Not Qualified'),
        fixed('Cargo', 'Manual Review'),
        fixed('Physical Damage', 'Not Qualified'),
      ],
      'Zone-OH LLC',
    );
    expect(overall.decision).toBe('Qualified');
    expect(overall.controllingCoverage).toBe('Auto Liability');
    expect(overall.reason).toMatch(/do not affect the driver-level decision/);
  });

  it('mirrors every Auto Liability outcome exactly', () => {
    for (const decision of ['Qualified', 'Not Qualified', 'Manual Review'] as const) {
      const overall = overallDecision([
        fixed('Auto Liability', decision),
        fixed('Cargo', 'Not Qualified'),
      ]);
      expect(overall.decision).toBe(decision);
    }
  });
});

/* ================================================================== *
 * 5.4 Missing Auto Liability guideline
 * ================================================================== */

describe('Acceptance 5.4 — missing Auto Liability guideline', () => {
  const evaluations = [
    evaluateCoverage({
      companyId: 'acme',
      coverageType: 'Auto Liability',
      guideline: null,
      evidence: pheniasEvidence(),
      evaluationDate: EVAL_DATE,
    }),
    evaluateCoverage({
      companyId: 'acme',
      coverageType: 'Cargo',
      guideline: guideline({
        companyId: 'acme',
        coverageType: 'Cargo',
        ruleSet: ZONE_AUTO_LIABILITY,
        usedForDriverQualification: false,
      }),
      evidence: pheniasEvidence(),
      evaluationDate: EVAL_DATE,
    }),
  ];

  it('reports Auto Liability as Not Evaluated', () => {
    expect(evaluations[0]!.decision).toBe('Not Evaluated');
    expect(evaluations[0]!.reason).toMatch(/No active Auto Liability guideline is configured/);
  });

  it('reports the driver-level decision as Manual Review with a specific explanation', () => {
    const overall = overallDecision(evaluations, 'Acme Freight');
    expect(overall.decision).toBe('Manual Review');
    expect(overall.reason).toMatch(/No active Auto Liability driver guideline is configured/);
    expect(overall.reason).toMatch(/Acme Freight/);
  });

  it('reports a non-qualification coverage as Not Evaluated', () => {
    expect(evaluations[1]!.decision).toBe('Not Evaluated');
    expect(evaluations[1]!.reason).toMatch(/not used for driver qualification/);
  });
});

/* ================================================================== *
 * Company isolation
 * ================================================================== */

describe('Company isolation', () => {
  it('produces independent results for Zone and Xtrack from identical evidence', () => {
    const driver = pheniasEvidence();

    const zone = evaluateCoverage({
      companyId: 'zone',
      coverageType: 'Auto Liability',
      guideline: guideline({ id: 'gl_zone', companyId: 'zone', ruleSet: ZONE_AUTO_LIABILITY }),
      evidence: driver,
      evaluationDate: EVAL_DATE,
    });

    const xtrack = evaluateCoverage({
      companyId: 'xtrack',
      coverageType: 'Auto Liability',
      guideline: guideline({ id: 'gl_xtrack', companyId: 'xtrack', ruleSet: XTRACK_AUTO_LIABILITY }),
      evidence: driver,
      evaluationDate: EVAL_DATE,
    });

    expect(zone.decision).toBe('Qualified');
    expect(xtrack.decision).toBe('Not Qualified');
    expect(zone.guidelineId).toBe('gl_zone');
    expect(xtrack.guidelineId).toBe('gl_xtrack');
    expect(xtrack.reason).not.toMatch(/One-year experience path/);
  });

  it('refuses to apply another company’s guideline', () => {
    expect(() =>
      evaluateCoverage({
        companyId: 'zone',
        coverageType: 'Auto Liability',
        guideline: guideline({ id: 'gl_xtrack', companyId: 'xtrack', ruleSet: XTRACK_AUTO_LIABILITY }),
        evidence: pheniasEvidence(),
        evaluationDate: EVAL_DATE,
      }),
    ).toThrow(/isolation violation/i);
  });

  it('refuses to apply another coverage’s guideline to Auto Liability', () => {
    expect(() =>
      evaluateCoverage({
        companyId: 'zone',
        coverageType: 'Auto Liability',
        guideline: guideline({ companyId: 'zone', coverageType: 'Cargo', ruleSet: ZONE_AUTO_LIABILITY }),
        evidence: pheniasEvidence(),
        evaluationDate: EVAL_DATE,
      }),
    ).toThrow(/isolation violation/i);
  });
});
