/**
 * Merges QuickManage's truck roster into `truck_entity_history`.
 *
 * WHY THIS EXISTS. `truck_entity_history`'s periods were derived from the
 * dispatch record, so each one begins the week the unit first EARNED. A unit
 * is acquired before it earns — sometimes by days, sometimes by months — and
 * every cost dated in that gap (the first service, the first plate, the first
 * repair before it ever turned a wheel for hire) falls outside every period
 * and cannot be attributed to a company at all. QuickManage's roster carries
 * `in_service_date`, which is the acquisition side of that gap.
 *
 * WHY IT MERGES RATHER THAN REPLACES. `load-truck-roster.ts` replaces the
 * history wholesale, which is right for the operator's own roster: that sheet
 * is the whole truth about transfers. QuickManage's roster is not — it is each
 * company's CURRENT fleet, one row per unit, so a unit that moved from Zone to
 * Xtrack in March appears only under whoever holds it now. Replacing with it
 * would erase every transfer period the dispatch record proved. So this only
 * ever ADDS what the history lacks and EXTENDS what it already has backwards.
 *
 * WHAT IT WILL NOT DO. It will not move a period's start FORWARD (that would
 * drop coverage the dispatch record earned), and it will not reassign a period
 * to a different company. A roster that disagrees with the history about who
 * held a unit is a question for a person, and is reported as a conflict rather
 * than resolved by precedence.
 *
 * The file this reads is produced by `fleet-financial-pipeline`'s
 * `pull_quickmanage.py --roster`. opsdash itself makes no network call — a
 * roster arrives here as a file, like every other source.
 */
type QueryFn = (text: string, params?: readonly unknown[]) => Promise<unknown[]>;

export interface RosterRow {
  company: string;
  unitNumber: string;
  unitType: string;
  inServiceDate: string;
  outServiceDate: string;
  status: string;
}

export type RosterAction =
  | { kind: 'new_unit'; unitNumber: string; entityId: string; from: string; to: string | null }
  | { kind: 'extend_back'; unitNumber: string; entityId: string; from: string; wasFrom: string };

export type RosterSkip =
  | { kind: 'no_in_service_date'; unitNumber: string }
  | { kind: 'unknown_company'; unitNumber: string; company: string }
  | { kind: 'not_a_truck'; unitNumber: string; unitType: string }
  | { kind: 'already_covered'; unitNumber: string }
  | { kind: 'conflict_other_company'; unitNumber: string; rosterCompany: string; historyCompany: string; historyFrom: string }
  | { kind: 'in_service_after_first_period'; unitNumber: string; inService: string; historyFrom: string };

export interface RosterPlan {
  actions: RosterAction[];
  skips: RosterSkip[];
}

/** QuickManage names companies its own way; the ledger has entity codes. */
const COMPANY_TO_CODE: Readonly<Record<string, string>> = {
  ZONE_OH: 'ZONE',
  ZONE: 'ZONE',
  XTRACK: 'XTRACK',
  AFG: 'AFG',
  TRUCKMAX: 'TRUCKMAX',
};

export function codeForCompany(company: string): string | null {
  return COMPANY_TO_CODE[company.trim().toUpperCase().replace(/[\s-]+/g, '_')] ?? null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Accepts the ISO date the API documents, and the US format a CSV round-trip
 *  through a spreadsheet can leave behind. Anything else is not a date and is
 *  treated as absent rather than guessed at. */
export function normaliseDate(raw: string): string | null {
  const s = (raw ?? '').trim();
  if (s === '') return null;
  if (ISO.test(s)) return s;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
  const iso = /^(\d{4}-\d{2}-\d{2})[T ]/.exec(s);
  if (iso) return iso[1]!;
  return null;
}

interface PeriodRow {
  unit_number: string;
  entity_id: string;
  code: string;
  effective_from: string;
}

function iso(d: string | Date): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

export async function planRosterMerge(q: QueryFn, rows: readonly RosterRow[]): Promise<RosterPlan> {
  const entities = (await q(`SELECT entity_id, code FROM accounting.entity`)) as { entity_id: string; code: string }[];
  const byCode = new Map(entities.map((e) => [e.code.toUpperCase(), e.entity_id]));

  // The earliest period already on file for each unit — the one a backwards
  // extension would move, and the one a conflict would be against.
  const earliest = (await q(
    `SELECT DISTINCT ON (t.unit_number)
            t.unit_number, h.entity_id, e.code, h.effective_from
       FROM accounting.truck_entity_history h
       JOIN accounting.truck t  ON t.truck_id  = h.truck_id
       JOIN accounting.entity e ON e.entity_id = h.entity_id
      ORDER BY t.unit_number, h.effective_from`,
  )) as PeriodRow[];
  const firstPeriod = new Map(earliest.map((r) => [r.unit_number, r]));

  const actions: RosterAction[] = [];
  const skips: RosterSkip[] = [];

  for (const r of rows) {
    const unit = r.unitNumber.trim();
    if (unit === '') continue;

    if (r.unitType && r.unitType !== 'truck') {
      skips.push({ kind: 'not_a_truck', unitNumber: unit, unitType: r.unitType });
      continue;
    }

    const code = codeForCompany(r.company);
    const entityId = code ? byCode.get(code) : undefined;
    if (!entityId) {
      skips.push({ kind: 'unknown_company', unitNumber: unit, company: r.company });
      continue;
    }

    const from = normaliseDate(r.inServiceDate);
    if (from === null) {
      skips.push({ kind: 'no_in_service_date', unitNumber: unit });
      continue;
    }
    const to = normaliseDate(r.outServiceDate);

    const existing = firstPeriod.get(unit);
    if (!existing) {
      actions.push({ kind: 'new_unit', unitNumber: unit, entityId, from, to });
      continue;
    }

    const existingFrom = iso(existing.effective_from);
    if (existing.entity_id !== entityId) {
      // The roster and the dispatch record name different companies. Neither
      // is automatically right: a unit really can have been acquired by one
      // company and first earned under another. A person decides.
      skips.push({
        kind: 'conflict_other_company',
        unitNumber: unit,
        rosterCompany: code!,
        historyCompany: existing.code,
        historyFrom: existingFrom,
      });
      continue;
    }
    if (from > existingFrom) {
      // In service AFTER it first earned. Contradictory, and extending would
      // mean moving the start forward and losing attributed weeks.
      skips.push({ kind: 'in_service_after_first_period', unitNumber: unit, inService: from, historyFrom: existingFrom });
      continue;
    }
    if (from === existingFrom) {
      skips.push({ kind: 'already_covered', unitNumber: unit });
      continue;
    }
    actions.push({ kind: 'extend_back', unitNumber: unit, entityId, from, wasFrom: existingFrom });
  }

  return { actions, skips };
}

export interface RosterApplyResult {
  unitsCreated: number;
  periodsExtended: number;
  daysOfCoverageGained: number;
}

const BASIS_NEW = 'QuickManage roster: in-service date under this company.';
const BASIS_EXTENDED =
  'QuickManage roster: start moved back to the in-service date. The later date was the week the unit first earned, not when the company got it.';

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

export async function applyRosterMerge(q: QueryFn, plan: RosterPlan): Promise<RosterApplyResult> {
  let unitsCreated = 0;
  let periodsExtended = 0;
  let daysOfCoverageGained = 0;

  for (const a of plan.actions) {
    if (a.kind === 'new_unit') {
      await q(`INSERT INTO accounting.truck (unit_number) VALUES ($1) ON CONFLICT DO NOTHING`, [a.unitNumber]);
      const done = (await q(
        `INSERT INTO accounting.truck_entity_history
           (truck_id, entity_id, effective_from, effective_to, basis, confidence)
         SELECT t.truck_id, $2, $3::date, NULLIF($4,'')::date, $5, 'confirmed'
           FROM accounting.truck t WHERE t.unit_number = $1
         ON CONFLICT DO NOTHING
         RETURNING truck_id`,
        [a.unitNumber, a.entityId, a.from, a.to ?? '', BASIS_NEW],
      )) as unknown[];
      if (done.length > 0) unitsCreated += 1;
      continue;
    }

    // The primary key is (truck_id, effective_from), so moving the start is an
    // UPDATE of the key column. Scoped by the old start so it can only ever
    // touch the one period that was planned against.
    const done = (await q(
      `UPDATE accounting.truck_entity_history h
          SET effective_from = $3::date, basis = $4
         FROM accounting.truck t
        WHERE t.truck_id = h.truck_id
          AND t.unit_number = $1
          AND h.effective_from = $2::date
          AND h.entity_id = $5
        RETURNING h.truck_id`,
      [a.unitNumber, a.wasFrom, a.from, BASIS_EXTENDED, a.entityId],
    )) as unknown[];
    if (done.length > 0) {
      periodsExtended += 1;
      daysOfCoverageGained += daysBetween(a.from, a.wasFrom);
    }
  }

  return { unitsCreated, periodsExtended, daysOfCoverageGained };
}
