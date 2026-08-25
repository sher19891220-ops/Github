import { describe, expect, it } from 'vitest';
import { evaluateCoverage, overallDecision } from '@/domain/engine';
import { ruleSetSchema } from '@/domain/guideline';
import { normalizeCoverageType } from '@/domain/types';
import {
  ZONE_AUTO_LIABILITY,
  evidence,
  event,
  guideline,
  pheniasEvidence,
} from '../fixtures';

const EVAL_DATE = '2026-08-19';

function zoneEval(driverEvidence = pheniasEvidence(), ruleSet = ZONE_AUTO_LIABILITY) {
  return evaluateCoverage({
    companyId: 'zone',
    coverageType: 'Auto Liability',
    guideline: guideline({ companyId: 'zone', ruleSet }),
    evidence: driverEvidence,
    evaluationDate: EVAL_DATE,
  });
}

describe('missing evidence never produces Not Qualified', () => {
  it('returns Manual Review when the original CDL issue date is absent', () => {
    const result = zoneEval(pheniasEvidence({ cdlOriginalIssueDate: null }));
    expect(result.decision).toBe('Manual Review');
    expect(result.dataGaps.join(' ')).toMatch(/Cannot calculate/);
    expect(result.reason).toMatch(/never treated as proof that the driver is not qualified/);
  });

  it('returns Manual Review when the MVR order date is absent', () => {
    const result = zoneEval(pheniasEvidence({ mvrOrderDate: null }));
    expect(result.decision).toBe('Manual Review');
    expect(result.dataGaps.join(' ')).toMatch(/MVR order\/report date is missing/);
  });

  it('returns Manual Review when the license status is unknown', () => {
    const result = zoneEval(pheniasEvidence({ licenseStatus: 'Unknown' }));
    expect(result.decision).toBe('Manual Review');
    expect(result.dataGaps.join(' ')).toMatch(/License status/);
  });

  it('returns Manual Review, not Not Qualified, for a missing medical card', () => {
    const ruleSet = ruleSetSchema.parse({
      ...ZONE_AUTO_LIABILITY,
      eligibilityPaths: [
        {
          id: 'p',
          label: 'Medical path',
          sourceText: 'A current medical card is required.',
          conditions: [{ type: 'requires_valid_medical_card' }],
        },
      ],
    });
    const result = zoneEval(pheniasEvidence({ medicalCard: null }), ruleSet);
    expect(result.decision).toBe('Manual Review');
    expect(result.dataGaps.join(' ')).toMatch(/Medical examiner/);
  });

  it('returns Manual Review for an expired medical card rather than rejecting', () => {
    const ruleSet = ruleSetSchema.parse({
      ...ZONE_AUTO_LIABILITY,
      eligibilityPaths: [
        {
          id: 'p',
          label: 'Medical path',
          sourceText: 'A current medical card is required.',
          conditions: [{ type: 'requires_valid_medical_card' }],
        },
      ],
    });
    const result = zoneEval(
      pheniasEvidence({
        medicalCard: { present: true, expirationDate: '2026-01-01', examinerName: 'Dr. Lee' },
      }),
      ruleSet,
    );
    expect(result.decision).toBe('Manual Review');
    expect(result.reason).toMatch(/expired 2026-01-01/);
  });
});

describe('legacy extraction', () => {
  it('forces Manual Review until the documents are re-read', () => {
    const result = zoneEval(pheniasEvidence({ extractionFormatVersion: 1 }));
    expect(result.decision).toBe('Manual Review');
    expect(result.reason).toMatch(/extraction format v1/);
    expect(result.reason).toMatch(/Re-read the documents/);
  });

  it('forces Manual Review when an inferred suspension is present', () => {
    const result = zoneEval(
      pheniasEvidence({
        suspensions: [
          {
            id: 's1',
            description: 'Suspension inferred from red-light conviction',
            startDate: '2025-01-01',
            endDate: null,
            reinstatedDate: null,
            state: 'OH',
            source: 'inferred',
          },
        ],
      }),
    );
    expect(result.decision).toBe('Manual Review');
    expect(result.reason).toMatch(/inferred rather than read from a document/);
  });
});

describe('suspensions only matter when the guideline says so', () => {
  const explicitSuspension = pheniasEvidence({
    suspensions: [
      {
        id: 's1',
        description: 'Suspension - failure to maintain financial responsibility',
        startDate: '2025-01-10',
        endDate: '2025-03-10',
        reinstatedDate: '2025-03-11',
        state: 'OH',
        source: 'explicit_document_record',
      },
    ],
  });

  it('ignores an explicit suspension when no suspension criterion exists', () => {
    const result = zoneEval(explicitSuspension);
    expect(result.decision).toBe('Qualified');
  });

  it('applies a suspension criterion when the guideline contains one', () => {
    const ruleSet = ruleSetSchema.parse({
      ...ZONE_AUTO_LIABILITY,
      disqualifiers: [
        {
          id: 'dq.suspension',
          label: 'No suspensions in 36 months',
          sourceText: 'Any license suspension within the preceding 36 months is disqualifying.',
          condition: { type: 'max_suspensions', lookbackMonths: 36, max: 0 },
        },
      ],
    });
    const result = zoneEval(explicitSuspension, ruleSet);
    expect(result.decision).toBe('Not Qualified');
    expect(result.disqualifiersTriggered).toContain('No suspensions in 36 months');
  });
});

describe('alternative eligibility paths', () => {
  it('never picks a stricter branch to reject a driver who satisfies a looser one', () => {
    // 14 months of experience, one countable violation: fails the two-year
    // path on experience, satisfies the one-year path.
    const result = zoneEval(pheniasEvidence({ cdlOriginalIssueDate: '2025-06-19' }));
    expect(result.decision).toBe('Qualified');
    expect(result.eligibilityPath).toBe('One-year experience path');
  });

  it('returns Not Qualified only when every decidable path fails', () => {
    const result = zoneEval(
      pheniasEvidence({
        cdlOriginalIssueDate: '2026-01-19', // 7 months — under both paths
      }),
    );
    expect(result.decision).toBe('Not Qualified');
    expect(result.reason).toMatch(/every applicable eligibility path was evaluated/);
    expect(result.reason).toMatch(/Two-year experience path fails/);
    expect(result.reason).toMatch(/One-year experience path fails/);
  });

  it('counts a major violation against a path that forbids one', () => {
    const result = zoneEval(
      pheniasEvidence({
        events: [
          event({
            description: 'Reckless driving',
            violationDate: '2024-02-01',
            convictionDate: '2024-04-01',
            statePoints: 4,
            mvrActivityPoints: 6,
          }),
        ],
      }),
    );
    expect(result.decision).toBe('Not Qualified');
    expect(result.reason).toMatch(/major moving violation/);
  });
});

describe('guideline review gate', () => {
  it('holds for review when the rule set has not been interpreted', () => {
    const result = evaluateCoverage({
      companyId: 'zone',
      coverageType: 'Auto Liability',
      guideline: guideline({
        companyId: 'zone',
        ruleSet: null,
        reviewStatus: 'pending_interpretation',
      }),
      evidence: pheniasEvidence(),
      evaluationDate: EVAL_DATE,
    });
    expect(result.decision).toBe('Manual Review');
    expect(result.reason).toMatch(/has not been interpreted/);
  });

  it('holds for review when the interpretation is not approved', () => {
    const result = evaluateCoverage({
      companyId: 'zone',
      coverageType: 'Auto Liability',
      guideline: guideline({
        companyId: 'zone',
        ruleSet: ZONE_AUTO_LIABILITY,
        reviewStatus: 'awaiting_approval',
      }),
      evidence: pheniasEvidence(),
      evaluationDate: EVAL_DATE,
    });
    expect(result.decision).toBe('Manual Review');
    expect(result.reason).toMatch(/have not been approved/);
  });

  it('holds for review when the guideline is archived', () => {
    const result = evaluateCoverage({
      companyId: 'zone',
      coverageType: 'Auto Liability',
      guideline: guideline({ companyId: 'zone', ruleSet: ZONE_AUTO_LIABILITY, status: 'archived' }),
      evidence: pheniasEvidence(),
      evaluationDate: EVAL_DATE,
    });
    expect(result.decision).toBe('Manual Review');
    expect(result.reason).toMatch(/archived/);
  });
});

describe('explanation completeness', () => {
  it('records company, coverage, guideline, path, criteria and evidence on every decision', () => {
    const result = zoneEval();
    expect(result.companyId).toBe('zone');
    expect(result.coverageType).toBe('Auto Liability');
    expect(result.guidelineVersion).toBe('1');
    expect(result.guidelineName).toMatch(/Auto Liability/);
    expect(result.criteriaApplied.length).toBeGreaterThan(0);
    expect(result.evidenceUsed.length).toBeGreaterThan(0);
    expect(result.engineVersion).toBeTruthy();
    expect(result.evaluationDate).toBe(EVAL_DATE);
    expect(result.reason).not.toMatch(/^does not meet guidelines/i);
  });

  it('lists every excluded record with a reason', () => {
    const result = zoneEval();
    expect(result.excludedEvidence.length).toBeGreaterThanOrEqual(2);
    for (const line of result.excludedEvidence) {
      expect(line).toMatch(/: .+/);
    }
  });
});

describe('coverage normalization', () => {
  it('maps legacy labels onto canonical coverage names', () => {
    expect(normalizeCoverageType('Motor Truck Cargo')).toBe('Cargo');
    expect(normalizeCoverageType('motor truck cargo legal liability')).toBe('Cargo');
    expect(normalizeCoverageType('Commercial Auto Liability')).toBe('Auto Liability');
    expect(normalizeCoverageType("Workers' Compensation")).toBe('Workers Compensation');
    expect(normalizeCoverageType('Non-Trucking Liability')).toBe('Bobtail / Non-Trucking Liability');
    expect(normalizeCoverageType('Auto Liability')).toBe('Auto Liability');
  });

  it('returns null for an unrecognised label rather than guessing', () => {
    expect(normalizeCoverageType('Cyber Liability')).toBeNull();
  });
});

describe('overall decision', () => {
  it('is Manual Review when there is no Auto Liability evaluation at all', () => {
    const overall = overallDecision([], 'Zone-OH LLC');
    expect(overall.decision).toBe('Manual Review');
    expect(overall.controllingDecision).toBe('Not Evaluated');
  });
});
