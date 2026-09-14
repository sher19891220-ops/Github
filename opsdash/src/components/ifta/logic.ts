/**
 * Pure presentation logic for the IFTA screen.
 *
 * Kept out of the component so it runs under this repo's `node` vitest
 * environment, and because — as with the P&L — every function here is a
 * place an IFTA figure could quietly read as more final than it is. The
 * two that matter most are `saveBlockReason`, which explains a refusal
 * before a person clicks into it, and `netDueReading`, which never lets a
 * credit and an amount owed share a wording.
 */
import type { IftaReturnView } from '@/db/repo/ifta';
import type { IftaJurisdictionLine } from '@/engines/ifta';
import { moneyToCents } from '@/components/format/decimal';

export interface PeriodPreset {
  id: string;
  label: string;
  from: string;
  to: string;
  /** A quarter can be filed. Anything else is an accrual. */
  kind: 'quarter' | 'accrual';
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function quarterRange(year: number, quarter: number): { from: string; to: string } {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  const p = (n: number) => String(n).padStart(2, '0');
  return { from: `${year}-${p(startMonth)}-01`, to: `${year}-${p(endMonth)}-${p(lastDay)}` };
}

/**
 * The periods offered, newest first: the current quarter and the three
 * before it, then a week and a month.
 *
 * The accrual presets exist because the operator asked for a daily and
 * weekly figure, and they are labelled as accruals in the same list rather
 * than in a separate tab — a person picking "this week" should see what
 * they are getting at the moment they pick it, not after they read the
 * result.
 *
 * The week runs Monday to Sunday and is clamped to the quarter it ends in,
 * because a period spanning two quarters has two different rate tables and
 * the server refuses it. Clamping here means the refusal never fires for a
 * preset a person was offered.
 */
export function periodPresets(today: Date): PeriodPreset[] {
  const year = today.getUTCFullYear();
  const quarter = Math.floor(today.getUTCMonth() / 3) + 1;

  const presets: PeriodPreset[] = [];
  for (let back = 0; back < 4; back += 1) {
    const qAbs = quarter - back;
    const y = qAbs > 0 ? year : year - 1;
    const q = qAbs > 0 ? qAbs : qAbs + 4;
    const { from, to } = quarterRange(y, q);
    presets.push({
      id: `${y}Q${q}`,
      label: back === 0 ? `${y} Q${q} (current)` : `${y} Q${q}`,
      from,
      to,
      kind: 'quarter',
    });
  }

  // Monday of the week containing `today`.
  const dow = today.getUTCDay(); // 0 = Sunday
  const backToMonday = dow === 0 ? 6 : dow - 1;
  const monday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - backToMonday));
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  const qStart = quarterRange(today.getUTCFullYear(), quarter).from;
  presets.push({
    id: 'this-week',
    label: 'This week (accrual)',
    from: iso(monday) < qStart ? qStart : iso(monday),
    to: iso(sunday),
    kind: 'accrual',
  });

  const p = (n: number) => String(n).padStart(2, '0');
  const m = today.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(today.getUTCFullYear(), m, 0)).getUTCDate();
  presets.push({
    id: 'this-month',
    label: 'This month (accrual)',
    from: `${today.getUTCFullYear()}-${p(m)}-01`,
    to: `${today.getUTCFullYear()}-${p(m)}-${p(lastDay)}`,
    kind: 'accrual',
  });

  return presets;
}

export interface NetDueReading {
  /** 'owed' | 'credit' | 'nil' — never collapsed into one signed number
   *  with a minus sign a reader has to notice. */
  direction: 'owed' | 'credit' | 'nil';
  /** Always positive. The direction carries the sign. */
  amount: string;
  label: string;
}

export function netDueReading(netDue: string): NetDueReading {
  const cents = moneyToCents(netDue);
  if (cents === 0n) return { direction: 'nil', amount: '0.00', label: 'Nothing owed' };
  const abs = cents < 0n ? -cents : cents;
  const amount = `${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  return cents > 0n
    ? { direction: 'owed', amount, label: 'Owed to the jurisdictions' }
    : { direction: 'credit', amount, label: 'Net credit' };
}

/** A jurisdiction line reads as a credit when its total is negative. The
 *  surcharge can never contribute to one. */
export function lineDirection(line: IftaJurisdictionLine): 'owed' | 'credit' | 'nil' {
  const cents = moneyToCents(line.totalDue);
  return cents > 0n ? 'owed' : cents < 0n ? 'credit' : 'nil';
}

/**
 * Why this return cannot be saved as a filing, or null when it can.
 *
 * The server enforces every one of these independently and is the
 * authority; this exists only so the button can say what it is waiting for
 * instead of failing after the click. If the two ever disagree, the server
 * wins and the screen is the thing that is wrong.
 */
export function saveBlockReason(view: IftaReturnView | null): string | null {
  if (view === null) return 'Nothing loaded yet.';
  if (view.result === null) {
    return view.blocked ?? 'There is no return to save.';
  }
  if (view.periodKind !== 'quarter') {
    return 'This is an accrual, not a return. IFTA files quarterly — pick a quarter to save a filing.';
  }
  if (view.entityId === null) {
    return 'A return is filed by one licensee. Pick an entity; the group-wide figure is a view, not a filing.';
  }
  const withheld = view.result.problems.filter((p) => p.includes('no tax rate on file'));
  if (withheld.length > 0) {
    return `${withheld.length} jurisdiction${withheld.length === 1 ? '' : 's'} ${withheld.length === 1 ? 'has' : 'have'} no rate on file, so this total is knowably short. Enter the missing rates below first.`;
  }
  return null;
}

/**
 * The jurisdictions the engine withheld, pulled back out of its problem
 * sentences so the screen can list them as rows to fix rather than as
 * prose to read.
 *
 * Parsing the engine's own message is deliberate and narrow: the engine
 * owns the wording, and a second structured channel for the same fact is a
 * second thing to keep in sync. The prefix is stable — it is the
 * jurisdiction code the engine puts first in every problem it raises.
 */
export function withheldJurisdictions(problems: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of problems) {
    const m = /^([A-Z]{2}): no tax rate on file/.exec(p);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** Total miles across the report's own included documents, for the "what
 *  fed this" line. Returns null when nothing was included, which reads
 *  differently from zero miles. */
export function includedDocumentCount(view: IftaReturnView): number {
  return view.sources.mileageDocuments.filter((d) => d.excludedReason === null).length;
}

export function quarterLabel(view: IftaReturnView): string {
  return `${view.quarter.year} Q${view.quarter.quarter}`;
}
