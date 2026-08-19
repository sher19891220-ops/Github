import { describe, expect, it } from 'vitest';
import { lookbackWindow } from '@/domain/dates';
import { calculateExperience, countEvents, normalizeEvidence } from '@/domain/evidence';
import { evidence, event, pheniasEvidence } from '../fixtures';

describe('effective date selection', () => {
  it('prefers the conviction date over the violation date', () => {
    const n = normalizeEvidence(
      evidence({
        mvrOrderDate: '2026-07-31',
        events: [
          event({
            description: 'Speeding',
            violationDate: '2023-05-02',
            convictionDate: '2023-09-07',
          }),
        ],
      }),
      '2026-08-19',
    );
    expect(n.events[0]!.effectiveDate).toBe('2023-09-07');
    expect(n.events[0]!.effectiveDateSource).toBe('conviction');
  });

  it('falls back to the violation date when no conviction date exists', () => {
    const n = normalizeEvidence(
      evidence({
        mvrOrderDate: '2026-07-31',
        events: [event({ description: 'Speeding', violationDate: '2024-01-05' })],
      }),
      '2026-08-19',
    );
    expect(n.events[0]!.effectiveDate).toBe('2024-01-05');
    expect(n.events[0]!.effectiveDateSource).toBe('violation');
  });

  it('uses the conviction date consistently for window membership', () => {
    // Violation 2023-05-02 is outside a 36-month window anchored 2026-07-31,
    // but the 2023-09-07 conviction is inside it. The record must be treated as
    // in-window, and excluded on classification instead.
    const n = normalizeEvidence(pheniasEvidence(), '2026-08-19');
    const window = lookbackWindow('2026-07-31', 36);
    const failToAppear = n.events.find((e) => /appear/i.test(e.description))!;
    expect(window.start).toBe('2023-07-31');
    expect(failToAppear.effectiveDate).toBe('2023-09-07');

    const { counted } = countEvents(n.events, 'moving_violation', window);
    const row = counted.find((c) => /appear/i.test(c.event.description))!;
    expect(row.countable).toBe(false);
    expect(row.exclusionReason).toMatch(/not a moving violation/i);
    expect(row.exclusionReason).not.toMatch(/window/i);
  });

  it('flags an event with no usable date instead of silently dropping it', () => {
    const n = normalizeEvidence(
      evidence({ mvrOrderDate: '2026-07-31', events: [event({ description: 'Speeding' })] }),
      '2026-08-19',
    );
    expect(n.blockers.map((b) => b.code)).toContain('event_missing_date');
  });
});

describe('suspension handling', () => {
  it('keeps only explicit document records and blocks on inferred ones', () => {
    const n = normalizeEvidence(
      evidence({
        mvrOrderDate: '2026-07-31',
        suspensions: [
          {
            id: 's1',
            description: 'Suspension - FRA non-compliance',
            startDate: '2024-01-01',
            endDate: '2024-03-01',
            reinstatedDate: '2024-03-02',
            state: 'OH',
            source: 'explicit_document_record',
          },
          {
            id: 's2',
            description: 'Suspension inferred from red-light conviction',
            startDate: '2024-06-01',
            endDate: null,
            reinstatedDate: null,
            state: 'OH',
            source: 'inferred',
          },
        ],
      }),
      '2026-08-19',
    );
    expect(n.suspensions).toHaveLength(1);
    expect(n.suspensions[0]!.id).toBe('s1');
    expect(n.discardedInferredSuspensions).toHaveLength(1);
    expect(n.blockers.map((b) => b.code)).toContain('inferred_suspension_present');
  });

  it('never derives a suspension from a violation or a fee record', () => {
    const n = normalizeEvidence(pheniasEvidence(), '2026-08-19');
    expect(n.suspensions).toHaveLength(0);
    expect(n.discardedInferredSuspensions).toHaveLength(0);
  });
});

describe('experience calculation', () => {
  it('derives months from the original CDL issue date', () => {
    const result = calculateExperience(
      evidence({ cdlOriginalIssueDate: '2024-06-15' }),
      '2026-08-19',
    );
    expect(result.months).toBe(26);
    expect(result.originalIssueDate).toBe('2024-06-15');
  });

  it('never substitutes the current issue, renewal or expiration date', () => {
    const result = calculateExperience(
      evidence({
        cdlOriginalIssueDate: null,
        cdlCurrentIssueDate: '2025-11-02',
        cdlExpirationDate: '2029-11-02',
      }),
      '2026-08-19',
    );
    expect(result.months).toBeNull();
    expect(result.reason).toMatch(/Cannot calculate/);
    expect(result.reason).toMatch(/not valid substitutes/);
  });

  it('ignores staff-reported months when the original date is present', () => {
    const result = calculateExperience(
      evidence({ cdlOriginalIssueDate: '2024-06-15', reportedExperienceMonths: 8 }),
      '2026-08-19',
    );
    expect(result.months).toBe(26);
    expect(result.reportedValueIgnored).toBe(true);
  });

  it('refuses to calculate from a low-confidence date', () => {
    const result = calculateExperience(
      evidence({
        cdlOriginalIssueDate: '2024-06-15',
        confidence: { cdlOriginalIssueDate: 0.4 },
      }),
      '2026-08-19',
    );
    expect(result.months).toBeNull();
    expect(result.reason).toMatch(/confidence/);
  });

  it('refuses a future issue date', () => {
    const result = calculateExperience(
      evidence({ cdlOriginalIssueDate: '2027-01-01' }),
      '2026-08-19',
    );
    expect(result.months).toBeNull();
  });
});

describe('evidence blockers', () => {
  it('blocks on a legacy extraction format', () => {
    const n = normalizeEvidence(
      evidence({ extractionFormatVersion: 1, mvrOrderDate: '2026-08-01' }),
      '2026-08-19',
    );
    expect(n.blockers.map((b) => b.code)).toContain('legacy_extraction_format');
  });

  it('blocks on a stale MVR', () => {
    const n = normalizeEvidence(evidence({ mvrOrderDate: '2025-01-01' }), '2026-08-19');
    expect(n.blockers.map((b) => b.code)).toContain('mvr_stale');
  });

  it('blocks on an unclassifiable record', () => {
    const n = normalizeEvidence(
      evidence({
        mvrOrderDate: '2026-08-01',
        events: [event({ description: 'ORC 4511.99 entry', violationDate: '2025-01-01' })],
      }),
      '2026-08-19',
    );
    expect(n.blockers.map((b) => b.code)).toContain('event_unclassified');
  });
});
