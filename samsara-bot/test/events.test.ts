import { describe, expect, it } from 'vitest';
import {
  classifyBehavior,
  fromDvir,
  fromSafetyEvent,
  fromWebhook,
  normalizeKey,
  severityRank,
  shouldDeliver,
} from '../src/samsara/events';

describe('classifyBehavior', () => {
  it('matches the canonical keys', () => {
    expect(classifyBehavior('mobileUsage').key).toBe('mobileUsage');
    expect(classifyBehavior('crash').severity).toBe('critical');
  });

  it('matches human labels regardless of spacing and case', () => {
    expect(classifyBehavior('No Seat Belt').key).toBe('noSeatbelt');
    expect(classifyBehavior('Mobile Usage').key).toBe('mobileUsage');
    expect(classifyBehavior('following distance').key).toBe('tailgating');
  });

  it('maps the alert vocabulary the user cares about', () => {
    expect(classifyBehavior('Cell Phone').key).toBe('mobileUsage');
    expect(classifyBehavior('accident').key).toBe('crash');
    expect(classifyBehavior('Unattended Driving').key).toBe('unassignedDriving');
    expect(classifyBehavior('Severe Speeding').key).toBe('severeSpeeding');
  });

  it('falls back to substring matching for compound event types', () => {
    expect(classifyBehavior('HarshEventSevereSpeeding').key).toBe('severeSpeeding');
  });

  it('never drops an unknown behaviour', () => {
    const spec = classifyBehavior('someBrandNewThing');
    expect(spec.title).toBe('Some brand new thing');
    expect(spec.severity).toBe('low');
  });

  it('handles missing input', () => {
    expect(classifyBehavior(undefined).key).toBe('unknown');
  });
});

describe('normalizeKey', () => {
  it('strips punctuation and case', () => {
    expect(normalizeKey('No Seat-Belt!')).toBe('noseatbelt');
  });
});

describe('fromSafetyEvent', () => {
  it('picks the most severe behaviour as the headline', () => {
    const alert = fromSafetyEvent({
      id: 'evt-1',
      time: '2026-08-17T14:30:00Z',
      vehicle: { id: '1', name: 'Truck 12' },
      driver: { id: '9', name: 'Sam Rivera' },
      behaviorLabels: [{ name: 'Harsh Brake' }, { name: 'Crash' }],
      speedMilesPerHour: 54,
      latitude: 41.88,
      longitude: -87.63,
    });

    expect(alert.behaviorKey).toBe('crash');
    expect(alert.severity).toBe('critical');
    expect(alert.vehicle).toBe('Truck 12');
    expect(alert.driver).toBe('Sam Rivera');
    expect(alert.details.join(' ')).toContain('Harsh braking');
    expect(alert.links.some((item) => item.label === 'Map')).toBe(true);
    expect(alert.fingerprint).toBe('safety:evt-1');
  });

  it('builds a fingerprint when the event carries no id', () => {
    const alert = fromSafetyEvent({
      time: '2026-08-17T14:30:00Z',
      vehicleId: '4',
      driverId: '5',
      behaviorLabels: [{ label: 'speeding' }],
    });
    expect(alert.fingerprint).toContain('4');
    expect(alert.fingerprint).toContain('speeding');
  });

  it('still produces an alert with no behaviour labels', () => {
    const alert = fromSafetyEvent({ id: 'x', time: '2026-08-17T00:00:00Z' });
    expect(alert.title).toBe('Safety event');
  });
});

describe('fromDvir', () => {
  it('summarises unresolved defects', () => {
    const alert = fromDvir({
      id: 'dvir-3',
      vehicle: { id: '2', name: 'Truck 8' },
      driver: { id: '7', name: 'Alex Kim' },
      safetyStatus: 'unsafe',
      inspectionType: 'preTrip',
      endTime: '2026-08-17T12:00:00Z',
      defects: [
        { defectType: 'brakes', comment: 'soft pedal', isResolved: false },
        { defectType: 'lights', isResolved: true },
      ],
    });

    expect(alert.severity).toBe('high');
    expect(alert.title).toBe('DVIR defects reported');
    expect(alert.details.join('\n')).toContain('soft pedal');
    expect(alert.details.join('\n')).toContain('Inspection: Pre trip');
  });
});

describe('fromWebhook', () => {
  it('reads fields out of the nested data envelope', () => {
    const alert = fromWebhook({
      eventId: 'wh-1',
      eventType: 'SevereSpeedingDetected',
      happenedAtTime: '2026-08-17T15:00:00Z',
      data: {
        vehicle: { id: '11', name: 'Truck 3' },
        driver: { id: '22', name: 'Jordan Lee' },
        speedMilesPerHour: 88,
        latitude: 32.7,
        longitude: -96.8,
      },
    });

    expect(alert?.behaviorKey).toBe('severeSpeeding');
    expect(alert?.vehicle).toBe('Truck 3');
    expect(alert?.speedMph).toBe(88);
    expect(alert?.fingerprint).toBe('webhook:wh-1');
    expect(alert?.source).toBe('webhook');
  });

  it('handles the alert-style envelope with a details block', () => {
    const alert = fromWebhook({
      eventId: 'wh-2',
      eventType: 'Alert',
      eventTime: '2026-08-17T16:00:00Z',
      data: {
        alertConditionType: 'unassignedDriving',
        alertConfigurationName: 'After-hours movement',
        details: { vehicle: { id: '5', name: 'Van 2' } },
      },
    });

    expect(alert?.behaviorKey).toBe('unassignedDriving');
    expect(alert?.vehicle).toBe('Van 2');
    expect(alert?.details.join(' ')).toContain('After-hours movement');
  });

  it('returns undefined for a non-object payload', () => {
    expect(fromWebhook(undefined as never)).toBeUndefined();
  });
});

describe('shouldDeliver', () => {
  const base = {
    fingerprint: 'f',
    title: 't',
    emoji: '🔔',
    details: [],
    links: [],
    source: 'poll' as const,
  };

  it('honours the severity floor', () => {
    const alert = { ...base, behaviorKey: 'speeding', severity: 'medium' as const };
    expect(shouldDeliver(alert, { behaviors: [], minSeverity: 'high' })).toBe(false);
    expect(shouldDeliver(alert, { behaviors: [], minSeverity: 'low' })).toBe(true);
  });

  it('honours the behaviour allow-list, ignoring case and punctuation', () => {
    const alert = { ...base, behaviorKey: 'noSeatbelt', severity: 'high' as const };
    expect(shouldDeliver(alert, { behaviors: ['crash'], minSeverity: 'low' })).toBe(false);
    expect(shouldDeliver(alert, { behaviors: ['no_seat_belt'], minSeverity: 'low' })).toBe(true);
  });
});

describe('severityRank', () => {
  it('orders severities and defaults unknown to the floor', () => {
    expect(severityRank('critical')).toBeGreaterThan(severityRank('high'));
    expect(severityRank('nonsense')).toBe(0);
  });
});
