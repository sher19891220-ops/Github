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
  const alert: FleetAlert = {
    fingerprint: 'safety:1',
    behaviorKey: 'mobileUsage',
    title: 'Mobile phone usage',
    emoji: '📱',
    severity: 'high',
    occurredAt: new Date('2026-08-17T18:30:00Z'),
    vehicle: 'Truck <12>',
    driver: 'Sam & Co',
    location: 'I-55 near Joliet',
    speedMph: 63.4,
    details: ['Coaching: Needed'],
    links: [{ label: 'Map', url: 'https://maps.google.com/?q=1,2' }],
    videos: [],
    source: 'poll',
  };

  it('escapes user-supplied values and includes the key fields', () => {
    const output = renderAlert(alert);
    expect(output).toContain('Truck &lt;12&gt;');
    expect(output).toContain('Sam &amp; Co');
    expect(output).toContain('HIGH');
    expect(output).toContain('63 mph');
    expect(output).toContain('<a href="https://maps.google.com/?q=1,2">Map</a>');
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
