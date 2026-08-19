import { describe, expect, it } from 'vitest';
import { classifyDescription, classifyEvent, mentionsSuspension } from '@/domain/classification';
import { event } from '../fixtures';

describe('administrative classification', () => {
  const administrative = [
    'Abandoned Vehicle Fee Due',
    'Fail to Appear - Trial/Court',
    'Failure to Appear',
    'Parking violation',
    'Toll evasion',
    'Registration fee due',
    'Reinstatement fee',
    'No proof of insurance',
    'Failure to display license',
  ];

  it.each(administrative)('classifies "%s" as Administrative', (description) => {
    expect(classifyDescription(description).eventType).toBe('Administrative');
  });

  it('never labels an administrative record as a minor moving violation', () => {
    for (const description of administrative) {
      const c = classifyDescription(description);
      expect(c.eventType).not.toBe('Moving Violation');
      expect(c.severity).not.toBe('Minor');
    }
  });
});

describe('moving violation classification', () => {
  it('classifies Limitations on Backing as a minor moving violation', () => {
    const c = classifyDescription('Limitations on Backing');
    expect(c.eventType).toBe('Moving Violation');
    expect(c.severity).toBe('Minor');
  });

  it('classifies major offences above minor ones', () => {
    expect(classifyDescription('Operating vehicle while under the influence')).toMatchObject({
      eventType: 'Moving Violation',
      severity: 'Major',
    });
    expect(classifyDescription('Reckless driving')).toMatchObject({ severity: 'Major' });
    expect(classifyDescription('Leaving the scene of an accident')).toMatchObject({
      severity: 'Major',
    });
    expect(classifyDescription('Driving while license suspended')).toMatchObject({
      severity: 'Major',
    });
  });

  it('classifies serious traffic violations distinctly from minor ones', () => {
    expect(classifyDescription('Following too closely')).toMatchObject({ severity: 'Serious' });
    expect(classifyDescription('Improper lane change')).toMatchObject({ severity: 'Serious' });
    expect(classifyDescription('Speeding 20 mph over limit')).toMatchObject({ severity: 'Serious' });
    expect(classifyDescription('Speeding')).toMatchObject({ severity: 'Minor' });
  });

  it('leaves an unrecognised description Unknown rather than guessing', () => {
    const c = classifyDescription('Section 4511.99 miscellaneous entry');
    expect(c.eventType).toBe('Unknown');
    expect(c.severity).toBe('Unknown');
    expect(c.matchedRuleId).toBeNull();
  });

  it('treats an empty description as Unknown', () => {
    expect(classifyDescription('').eventType).toBe('Unknown');
    expect(classifyDescription('   ').eventType).toBe('Unknown');
  });
});

describe('reviewer overrides', () => {
  it('does not overwrite a reviewer-confirmed classification', () => {
    const confirmed = event({
      description: 'Abandoned Vehicle Fee Due',
      eventType: 'Moving Violation',
      severity: 'Minor',
      reviewerConfirmed: true,
    });
    expect(classifyEvent(confirmed).eventType).toBe('Moving Violation');
  });

  it('reclassifies an unconfirmed event', () => {
    const unconfirmed = event({
      description: 'Abandoned Vehicle Fee Due',
      eventType: 'Moving Violation',
      severity: 'Minor',
    });
    expect(classifyEvent(unconfirmed).eventType).toBe('Administrative');
  });
});

describe('mentionsSuspension', () => {
  it('detects suspension language for warning purposes only', () => {
    expect(mentionsSuspension('License suspended 30 days')).toBe(true);
    expect(mentionsSuspension('Limitations on Backing')).toBe(false);
  });
});
