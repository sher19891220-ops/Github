/**
 * Timezone-aware day boundaries.
 *
 * The digest and PTI checks reason about "today for the fleet", which is a
 * local-calendar concept, while every Samsara timestamp is UTC. Node ships full
 * ICU, so this derives offsets from Intl rather than pulling in a date library.
 */

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsIn(date: Date, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return {
    year: Number(map['year']),
    month: Number(map['month']),
    day: Number(map['day']),
    // Some locales render midnight as hour 24.
    hour: Number(map['hour']) % 24,
    minute: Number(map['minute']),
    second: Number(map['second']),
  };
}

/** Offset in ms such that `utcTime + offset` reads as local wall-clock time. */
function offsetMs(date: Date, timeZone: string): number {
  const parts = partsIn(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Midnight of `date`'s local calendar day, as a UTC instant. */
export function startOfDay(date: Date, timeZone: string): Date {
  const parts = partsIn(date, timeZone);
  const naiveUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  // Resolve twice so DST transitions land on the right instant.
  let guess = new Date(naiveUtc - offsetMs(date, timeZone));
  guess = new Date(naiveUtc - offsetMs(guess, timeZone));
  return guess;
}

export interface DayWindow {
  start: Date;
  end: Date;
  /** YYYY-MM-DD in the target timezone, handy as a storage key. */
  key: string;
}

export function ymd(date: Date, timeZone: string): string {
  const parts = partsIn(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** The local day containing `now`, clipped to `now` at the upper end. */
export function todayWindow(now: Date, timeZone: string): DayWindow {
  const start = startOfDay(now, timeZone);
  return { start, end: now, key: ymd(now, timeZone) };
}

/** The full local day before `now`. */
export function yesterdayWindow(now: Date, timeZone: string): DayWindow {
  const todayStart = startOfDay(now, timeZone);
  // Stepping back a full 24h from local midnight overshoots into the day before
  // when the clocks spring forward (a 23-hour day). 12h always lands around
  // midday of the previous local day, whichever way the offset moved.
  const yesterdayMidday = new Date(todayStart.getTime() - 12 * 60 * 60 * 1000);
  const start = startOfDay(yesterdayMidday, timeZone);
  return { start, end: todayStart, key: ymd(start, timeZone) };
}
