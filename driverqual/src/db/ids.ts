import { randomUUID } from 'node:crypto';

/** Prefixed identifiers so a stray id is recognisable in a log or a URL. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Today's calendar date in UTC, the default evaluation anchor. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
