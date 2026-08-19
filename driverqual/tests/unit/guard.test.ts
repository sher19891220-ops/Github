import { describe, expect, it } from 'vitest';
import { applyNumericGuard, extractNumericClaims, validateModelExplanation } from '@/domain/guard';
import { evaluateCoverage } from '@/domain/engine';
import { ZONE_AUTO_LIABILITY, fabriceEvidence, guideline } from '../fixtures';

describe('extractNumericClaims', () => {
  it('detects a false months-to-years comparison', () => {
    const claims = extractNumericClaims('The driver has 28 months, which is less than 2 years.');
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ leftMonths: 28, rightMonths: 24, comparator: 'lt', holds: false });
  });

  it('handles spelled-out numbers', () => {
    const claims = extractNumericClaims('28 months is less than two years of experience.');
    expect(claims[0]!.holds).toBe(false);
  });

  it('accepts a true comparison', () => {
    const claims = extractNumericClaims('26 months is at least 24 months.');
    expect(claims[0]!.holds).toBe(true);
  });

  it('detects a false "does not meet" claim', () => {
    const claims = extractNumericClaims('30 months does not meet the required 24 months.');
    expect(claims[0]).toMatchObject({ holds: false });
  });

  it('returns nothing for text without a comparison', () => {
    expect(extractNumericClaims('The driver holds a Class A CDL issued in Ohio.')).toHaveLength(0);
  });
});

describe('applyNumericGuard', () => {
  it('downgrades Not Qualified to Manual Review and names the invalid comparison', () => {
    const result = applyNumericGuard(
      'Not Qualified',
      'Driver has 28 months of experience, which is less than 2 years required by the guideline.',
    );
    expect(result.decision).toBe('Manual Review');
    expect(result.downgraded).toBe(true);
    expect(result.reason).toMatch(/invalid numeric comparison/i);
    expect(result.reason).toMatch(/28 months vs 24 months/);
  });

  it('leaves a sound Not Qualified alone', () => {
    const result = applyNumericGuard(
      'Not Qualified',
      'Driver has 10 months of experience, which is less than 2 years required by the guideline.',
    );
    expect(result.decision).toBe('Not Qualified');
    expect(result.downgraded).toBe(false);
  });

  it('warns but does not change a Qualified decision', () => {
    const result = applyNumericGuard('Qualified', '28 months is less than 2 years.');
    expect(result.decision).toBe('Qualified');
    expect(result.reason).toMatch(/Validation warning/);
  });
});

describe('validateModelExplanation', () => {
  const evaluation = evaluateCoverage({
    companyId: 'zone',
    coverageType: 'Auto Liability',
    guideline: guideline({ companyId: 'zone', ruleSet: ZONE_AUTO_LIABILITY }),
    evidence: fabriceEvidence(),
    evaluationDate: '2026-08-19',
  });

  it('accepts an explanation that agrees with the engine', () => {
    const result = validateModelExplanation(
      {
        decision: 'Qualified',
        reason:
          'The driver has 26 completed months of CDL experience, at least the 24 months required by the two-year experience path, with no countable moving violations in the 36-month window.',
        criteria_applied: ['At least 24 completed months of CDL experience'],
        eligibility_path: 'Two-year experience path',
        evidence_used: ['Original CDL issue date 2024-06-15'],
        excluded_evidence: [],
        data_gaps: [],
      },
      evaluation,
    );
    expect(result.accepted).toBe(true);
  });

  it('rejects an explanation that overrides the engine decision', () => {
    const result = validateModelExplanation(
      { decision: 'Not Qualified', reason: 'Insufficient experience.', criteria_applied: [] },
      evaluation,
    );
    expect(result.accepted).toBe(false);
    expect(result.rejectionReasons.join(' ')).toMatch(/engine's decision is authoritative/);
  });

  it('rejects a criterion the guideline does not contain', () => {
    const result = validateModelExplanation(
      {
        decision: 'Qualified',
        reason: 'Driver meets the criteria including a clean PSP report.',
        criteria_applied: ['PSP report shows no crashes'],
      },
      evaluation,
    );
    expect(result.accepted).toBe(false);
    expect(result.rejectionReasons.join(' ')).toMatch(/not present in the applied guideline/);
  });

  it('rejects vague boilerplate', () => {
    const result = validateModelExplanation(
      { decision: 'Qualified', reason: 'Does not meet guidelines.', criteria_applied: [] },
      evaluation,
    );
    expect(result.accepted).toBe(false);
    expect(result.rejectionReasons.join(' ')).toMatch(/too vague/);
  });

  it('rejects malformed payloads', () => {
    const result = validateModelExplanation({ decision: 'Maybe', reason: '' }, evaluation);
    expect(result.accepted).toBe(false);
    expect(result.explanation).toBeNull();
  });
});
