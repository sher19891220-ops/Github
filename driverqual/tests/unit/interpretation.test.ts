import { describe, expect, it } from 'vitest';
import { buildDraft, type Interpretation } from '@/server/interpretation';

function payload(overrides: Partial<Interpretation> = {}): Interpretation {
  return {
    eligibilityPaths: [
      {
        id: 'path.two_year',
        label: 'Two-year experience path',
        sourceText: 'Two years of verifiable CDL experience, maximum three moving violations in 36 months.',
        conditions: [
          { type: 'min_experience_months', months: 24 },
          { type: 'max_events', category: 'moving_violation', lookbackMonths: 36, max: 3 },
        ],
      },
      {
        id: 'path.one_year',
        label: 'One-year experience path',
        sourceText: 'One year considered with no more than one moving violation.',
        conditions: [
          { type: 'min_experience_months', months: 12 },
          { type: 'max_events', category: 'moving_violation', lookbackMonths: 36, max: 1 },
        ],
      },
    ],
    disqualifiers: [],
    notes: '',
    warnings: [],
    ...overrides,
  };
}

describe('buildDraft', () => {
  it('accepts a well-formed two-path draft', () => {
    const draft = buildDraft(payload());
    expect(draft.ok).toBe(true);
    expect(draft.ruleSet!.eligibilityPaths).toHaveLength(2);
    expect(draft.warnings).toHaveLength(0);
  });

  it('carries the model’s own warnings through to the reviewer', () => {
    const draft = buildDraft(payload({ warnings: ['Section 4 was faint and may be misread.'] }));
    expect(draft.warnings).toContain('Section 4 was faint and may be misread.');
  });

  it('discards a draft the engine could not evaluate rather than showing it as usable', () => {
    const draft = buildDraft(
      payload({
        eligibilityPaths: [
          {
            id: 'p',
            label: 'Invented condition',
            sourceText: 'Driver must be nice.',
            // Not a condition type the engine knows.
            conditions: [{ type: 'driver_seems_reliable', level: 'high' }],
          },
        ],
      }),
    );
    expect(draft.ok).toBe(false);
    expect(draft.ruleSet).toBeNull();
    expect(draft.errors.join(' ')).toMatch(/not valid against the rule schema/);
  });

  it('refuses a draft with no criteria instead of returning an empty rule set', () => {
    // An empty rule set would qualify nobody and explain nothing.
    const draft = buildDraft(payload({ eligibilityPaths: [] }));
    expect(draft.ok).toBe(false);
    expect(draft.errors.join(' ')).toMatch(/No driver-qualification criteria were found/);
  });

  it('warns when only one path was found, since alternatives are the common miss', () => {
    const single = payload();
    single.eligibilityPaths = [single.eligibilityPaths[0]!];
    const draft = buildDraft(single);
    expect(draft.ok).toBe(true);
    expect(draft.warnings.join(' ')).toMatch(/Only one eligibility path/);
    expect(draft.warnings.join(' ')).toMatch(/wrongly rejects drivers/);
  });

  it('warns when a path cannot be checked against the document', () => {
    const unquoted = payload();
    unquoted.eligibilityPaths[1]!.sourceText = '   ';
    const draft = buildDraft(unquoted);
    expect(draft.ok).toBe(true);
    expect(draft.warnings.join(' ')).toMatch(/no quoted source text/);
  });

  it('keeps disqualifiers distinct from eligibility paths', () => {
    const draft = buildDraft(
      payload({
        disqualifiers: [
          {
            id: 'dq.dui',
            label: 'No DUI in five years',
            sourceText: 'Any DUI within 5 years is unacceptable.',
            condition: {
              type: 'max_events',
              category: 'major_moving_violation',
              lookbackMonths: 60,
              max: 0,
            },
          },
        ],
      }),
    );
    expect(draft.ok).toBe(true);
    expect(draft.ruleSet!.disqualifiers).toHaveLength(1);
    expect(draft.ruleSet!.eligibilityPaths).toHaveLength(2);
  });
});
