import { config } from '../config';
import type { FleetAlert } from '../samsara/events';

/** Escapes the three characters Telegram's HTML parse mode cares about. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function bold(value: string): string {
  return `<b>${escapeHtml(value)}</b>`;
}

export function code(value: string): string {
  return `<code>${escapeHtml(value)}</code>`;
}

export function link(label: string, url: string): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

/** Formats a timestamp in the fleet's configured timezone. */
export function formatTime(date: Date | undefined, timezone = config.timezone): string {
  if (!date) return 'unknown time';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

export function formatDate(date: Date, timezone = config.timezone): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

export function formatDuration(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

export function metersToMiles(meters: number | undefined): number | undefined {
  if (typeof meters !== 'number' || !Number.isFinite(meters)) return undefined;
  return meters / 1609.344;
}

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'INFO',
};

/** Renders a single alert as a Telegram HTML message. */
export function renderAlert(alert: FleetAlert): string {
  const lines: string[] = [];
  const badge = SEVERITY_BADGE[alert.severity] ?? alert.severity.toUpperCase();
  lines.push(`${alert.emoji} ${bold(alert.title)} · ${escapeHtml(badge)}`);
  lines.push('');

  if (alert.vehicle) lines.push(`🚛 ${bold('Vehicle:')} ${escapeHtml(alert.vehicle)}`);
  if (alert.driver) lines.push(`👤 ${bold('Driver:')} ${escapeHtml(alert.driver)}`);
  lines.push(`🕒 ${bold('When:')} ${escapeHtml(formatTime(alert.occurredAt))}`);
  if (alert.location) lines.push(`📍 ${bold('Where:')} ${escapeHtml(alert.location)}`);
  if (typeof alert.speedMph === 'number') {
    lines.push(`💨 ${bold('Speed:')} ${Math.round(alert.speedMph)} mph`);
  }

  if (alert.details.length) {
    lines.push('');
    for (const detail of alert.details) lines.push(escapeHtml(detail));
  }

  if (alert.links.length) {
    lines.push('');
    lines.push(alert.links.map((item) => link(item.label, item.url)).join(' · '));
  }

  return lines.join('\n');
}

export interface DigestSection {
  title: string;
  emoji: string;
  lines: string[];
  /** Rendered instead of `lines` when the section could not be built. */
  error?: string;
}

/** Renders the daily digest from independently-built sections. */
export function renderDigest(heading: string, sections: DigestSection[]): string {
  const parts: string[] = [`📊 ${bold(heading)}`];
  for (const section of sections) {
    parts.push('');
    parts.push(`${section.emoji} ${bold(section.title)}`);
    if (section.error) {
      parts.push(`⚠️ ${escapeHtml(section.error)}`);
    } else if (section.lines.length === 0) {
      parts.push('— none —');
    } else {
      for (const line of section.lines) parts.push(escapeHtml(line));
    }
  }
  return parts.join('\n');
}
