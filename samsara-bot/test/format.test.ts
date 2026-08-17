import { describe, expect, it } from 'vitest';
import { splitMessage } from '../src/telegram/api';
import {
  escapeHtml,
  formatDuration,
  formatTime,
  metersToMiles,
  renderAlert,
  renderDigest,
} from '../src/telegram/format';
import type { FleetAlert } from '../src/samsara/events';

describe('escapeHtml', () => {
  it('escapes the characters Telegram HTML mode parses', () => {
    expect(escapeHtml('<b>a & b</b>')).toBe('&lt;b&gt;a &amp; b&lt;/b&gt;');
  });
});

describe('formatDuration', () => {
  it('formats hours and minutes', () => {
    expect(formatDuration(3 * 3600 * 1000 + 5 * 60 * 1000)).toBe('3h 05m');
    expect(formatDuration(45 * 60 * 1000)).toBe('45m');
  });

  it('renders a dash for missing or negative values', () => {
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
});

describe('metersToMiles', () => {
  it('converts and passes through missing values', () => {
    expect(metersToMiles(1609.344)).toBeCloseTo(1, 6);
    expect(metersToMiles(undefined)).toBeUndefined();
  });
});

describe('formatTime', () => {
  it('renders in the requested timezone', () => {
    const output = formatTime(new Date('2026-08-17T18:30:00Z'), 'America/Chicago');
    expect(output).toContain('Aug 17');
    expect(output).toContain('1:30');
  });

  it('handles a missing date', () => {
    expect(formatTime(undefined)).toBe('unknown time');
  });
});

describe('renderAlert', () => {
  // Mirrors a real Samsara Events message, including the composite vehicle
  // label and the one deliberate change: a specific behaviour, not "Harsh Event".
  const alert: FleetAlert = {
    fingerprint: 'safety:1',
    behaviorKey: 'mobileUsage',
    title: 'Mobile phone usage',
    emoji: '📱',
    severity: 'high',
    occurredAt: new Date('2026-08-14T02:08:20Z'),
    vehicle: '5269 (GZP5W69Z75) 281474991641331',
    driver: 'Sam & Co',
    location: 'I 99;US 220, Allegheny Township, PA, 16648',
    latitude: 40.449877,
    longitude: -78.421974,
    speedMph: 61,
    incidentUrl: 'https://cloud.samsara.com/o/7002595/fleet/workflows/incidents/abc',
    eventId: '36757615-df83-4f8d-8ebb-31a45a92d5be',
    details: [],
    links: [],
    videos: [],
    source: 'webhook',
  };

  it('matches the field layout the events group already reads', () => {
    const output = renderAlert(alert);
    expect(output).toContain('🚗 <b>Vehicle:</b> 5269 (GZP5W69Z75) 281474991641331');
    expect(output).toContain('🗺 <b>Location:</b> I 99;US 220, Allegheny Township, PA, 16648');
    expect(output).toContain('🏃 <b>Speed:</b> 61.0 Mph');
    expect(output).toContain('View Incident');
    expect(output).toContain('🆔 <code>36757615-df83-4f8d-8ebb-31a45a92d5be</code>');
  });

  it('names the actual behaviour rather than a generic "Harsh Event"', () => {
    const output = renderAlert(alert);
    expect(output).toContain('Mobile phone usage');
    expect(output).toContain('HIGH');
    expect(output).not.toContain('Harsh Event');
  });

  it('links the coordinates to a map', () => {
    expect(renderAlert(alert)).toContain(
      '<a href="https://maps.google.com/?q=40.449877,-78.421974">40.449877, -78.421974</a>',
    );
  });

  it('escapes user-supplied values', () => {
    const output = renderAlert({ ...alert, driver: 'Sam & <Co>' });
    expect(output).toContain('Sam &amp; &lt;Co&gt;');
  });
});

describe('renderDigest', () => {
  it('shows an em-dash for empty sections and a warning for failed ones', () => {
    const output = renderDigest('Test digest', [
      { title: 'Empty', emoji: '⚠️', lines: [] },
      { title: 'Broken', emoji: '🔧', lines: [], error: 'Could not load: boom' },
      { title: 'Fine', emoji: '✅', lines: ['• one'] },
    ]);
    expect(output).toContain('— none —');
    expect(output).toContain('⚠️ Could not load: boom');
    expect(output).toContain('• one');
  });
});

describe('splitMessage', () => {
  it('leaves short messages alone', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });

  it('splits on line boundaries', () => {
    const text = ['aaaa', 'bbbb', 'cccc'].join('\n');
    expect(splitMessage(text, 9)).toEqual(['aaaa\nbbbb', 'cccc']);
  });

  it('hard-splits a single over-long line', () => {
    const chunks = splitMessage('x'.repeat(25), 10);
    expect(chunks).toHaveLength(3);
    expect(chunks.join('')).toBe('x'.repeat(25));
  });

  it('never emits a chunk over the limit', () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    for (const chunk of splitMessage(text, 100)) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });
});
