/**
 * Merging QuickManage's roster into the carrier history.
 *
 * The value of this load is the in-service date: history periods start when
 * a unit first EARNED, and costs dated between acquisition and first load
 * currently belong to nobody. The risk of it is that QuickManage's roster is
 * a CURRENT-fleet view, so applied carelessly it would erase every transfer
 * the dispatch record proved. Most of these tests are about that risk.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query } from '@/db/pool';
import {
  applyRosterMerge,
  codeForCompany,
  normaliseDate,
  planRosterMerge,
  type RosterRow,
} from '@/db/repo/quickmanageRoster';
import { ensureBaseFixtures } from './helpers';

let zoneId: string;
let xtrackId: string;

let seq = 0;
function unit(): string {
  return `7${Date.now() % 100000}${seq++}`;
}

async function entity(code: string, name: string): Promise<string> {
  const r = await query<{ entity_id: string }>(
    `INSERT INTO accounting.entity (code, legal_name, kind) VALUES ($1,$2,'carrier')
     ON CONFLICT (code) DO UPDATE SET legal_name = EXCLUDED.legal_name RETURNING entity_id`,
    [code, name],
  );
  return r[0]!.entity_id;
}

/** A unit already known to the ledger, with one period starting when it
 *  first earned. */
async function withHistory(u: string, entityId: string, from: string): Promise<void> {
  await query(`INSERT INTO accounting.truck (unit_number) VALUES ($1) ON CONFLICT DO NOTHING`, [u]);
  await query(
    `INSERT INTO accounting.truck_entity_history (truck_id, entity_id, effective_from, basis, confidence)
     SELECT truck_id, $2, $3::date, 'dispatch: first week it earned', 'confirmed'
       FROM accounting.truck WHERE unit_number = $1`,
    [u, entityId, from],
  );
}

function row(over: Partial<RosterRow>): RosterRow {
  return {
    company: 'ZONE_OH',
    unitNumber: unit(),
    unitType: 'truck',
    inServiceDate: '2025-06-01',
    outServiceDate: '',
    status: 'active',
    ...over,
  };
}

async function periodsFor(u: string) {
  return query<{ code: string; effective_from: string; basis: string }>(
    `SELECT e.code, h.effective_from::text, h.basis
       FROM accounting.truck_entity_history h
       JOIN accounting.truck t ON t.truck_id = h.truck_id
       JOIN accounting.entity e ON e.entity_id = h.entity_id
      WHERE t.unit_number = $1 ORDER BY h.effective_from`,
    [u],
  );
}

beforeAll(async () => {
  await ensureBaseFixtures();
  zoneId = await entity('ZONE', 'Zone OH LLC');
  xtrackId = await entity('XTRACK', 'Xtrack LLC');
});

describe('reading the roster file', () => {
  it('maps QuickManage company names to ledger entity codes', () => {
    expect(codeForCompany('ZONE_OH')).toBe('ZONE');
    expect(codeForCompany('zone_oh')).toBe('ZONE');
    expect(codeForCompany('Zone OH')).toBe('ZONE');
    expect(codeForCompany('XTRACK')).toBe('XTRACK');
    expect(codeForCompany('AFG')).toBe('AFG');
  });

  it('does not invent a company it has never heard of', () => {
    expect(codeForCompany('SOME_OTHER_LLC')).toBeNull();
    expect(codeForCompany('')).toBeNull();
  });

  it('reads the date the API documents, and a spreadsheet round-trip of it', () => {
    expect(normaliseDate('2025-06-01')).toBe('2025-06-01');
    expect(normaliseDate('2025-06-01T00:00:00Z')).toBe('2025-06-01');
    expect(normaliseDate('6/1/2025')).toBe('2025-06-01');
  });

  it('treats an unparseable date as absent rather than guessing', () => {
    expect(normaliseDate('')).toBeNull();
    expect(normaliseDate('n/a')).toBeNull();
    expect(normaliseDate('June 2025')).toBeNull();
  });
});

describe('merging the roster', () => {
  it('adds a unit the ledger has never seen, dated from its in-service date', async () => {
    const u = unit();
    const plan = await planRosterMerge(query, [row({ unitNumber: u, inServiceDate: '2025-04-02' })]);
    expect(plan.actions).toEqual([
      { kind: 'new_unit', unitNumber: u, entityId: zoneId, from: '2025-04-02', to: null },
    ]);
    const res = await applyRosterMerge(query, plan);
    expect(res.unitsCreated).toBe(1);

    const p = await periodsFor(u);
    expect(p).toHaveLength(1);
    expect(p[0]!.code).toBe('ZONE');
    expect(p[0]!.effective_from).toBe('2025-04-02');
  });

  it('moves an existing period back to the in-service date', async () => {
    // The whole point: acquired in January, first earned in March. Costs in
    // between had no company until now.
    const u = unit();
    await withHistory(u, zoneId, '2025-03-10');
    const plan = await planRosterMerge(query, [row({ unitNumber: u, inServiceDate: '2025-01-15' })]);
    expect(plan.actions).toEqual([
      { kind: 'extend_back', unitNumber: u, entityId: zoneId, from: '2025-01-15', wasFrom: '2025-03-10' },
    ]);

    const res = await applyRosterMerge(query, plan);
    expect(res.periodsExtended).toBe(1);
    expect(res.daysOfCoverageGained).toBe(54);

    const p = await periodsFor(u);
    expect(p).toHaveLength(1); // extended, not a second overlapping period
    expect(p[0]!.effective_from).toBe('2025-01-15');
  });

  it('never moves a period start forward, which would drop earned weeks', async () => {
    const u = unit();
    await withHistory(u, zoneId, '2025-02-01');
    const plan = await planRosterMerge(query, [row({ unitNumber: u, inServiceDate: '2025-05-01' })]);
    expect(plan.actions).toEqual([]);
    expect(plan.skips).toEqual([
      { kind: 'in_service_after_first_period', unitNumber: u, inService: '2025-05-01', historyFrom: '2025-02-01' },
    ]);
    await applyRosterMerge(query, plan);
    expect((await periodsFor(u))[0]!.effective_from).toBe('2025-02-01');
  });

  it('refuses to reassign a unit to the roster company when the history disagrees', async () => {
    // QuickManage shows only who holds a unit NOW. A unit that moved Zone ->
    // Xtrack appears under Xtrack alone, and taking that at face value would
    // silently rewrite who earned it before the transfer.
    const u = unit();
    await withHistory(u, zoneId, '2025-02-01');
    const plan = await planRosterMerge(query, [
      row({ unitNumber: u, company: 'XTRACK', inServiceDate: '2024-11-01' }),
    ]);
    expect(plan.actions).toEqual([]);
    expect(plan.skips).toEqual([
      { kind: 'conflict_other_company', unitNumber: u, rosterCompany: 'XTRACK', historyCompany: 'ZONE', historyFrom: '2025-02-01' },
    ]);

    await applyRosterMerge(query, plan);
    const p = await periodsFor(u);
    expect(p).toHaveLength(1);
    expect(p[0]!.code).toBe('ZONE');
  });

  it('leaves a period that already starts on the in-service date alone', async () => {
    const u = unit();
    await withHistory(u, zoneId, '2025-03-01');
    const plan = await planRosterMerge(query, [row({ unitNumber: u, inServiceDate: '2025-03-01' })]);
    expect(plan.actions).toEqual([]);
    expect(plan.skips[0]!.kind).toBe('already_covered');
  });

  it('skips a roster row with no in-service date instead of inventing one', async () => {
    const u = unit();
    const plan = await planRosterMerge(query, [row({ unitNumber: u, inServiceDate: '' })]);
    expect(plan.actions).toEqual([]);
    expect(plan.skips).toEqual([{ kind: 'no_in_service_date', unitNumber: u }]);
    expect(await periodsFor(u)).toHaveLength(0);
  });

  it('skips trailers — a trailer roster answers no question the cost rows ask', async () => {
    const u = unit();
    const plan = await planRosterMerge(query, [row({ unitNumber: u, unitType: 'trailer' })]);
    expect(plan.actions).toEqual([]);
    expect(plan.skips).toEqual([{ kind: 'not_a_truck', unitNumber: u, unitType: 'trailer' }]);
  });

  it('skips a company the ledger does not have rather than creating one', async () => {
    const u = unit();
    const plan = await planRosterMerge(query, [row({ unitNumber: u, company: 'SOMEONE_ELSE' })]);
    expect(plan.actions).toEqual([]);
    expect(plan.skips[0]!.kind).toBe('unknown_company');
    const before = await query<{ n: string }>(`SELECT count(*)::int n FROM accounting.entity WHERE code='SOMEONE_ELSE'`);
    expect(Number(before[0]!.n)).toBe(0);
  });

  it('is idempotent — running it twice changes nothing the second time', async () => {
    const u = unit();
    await withHistory(u, zoneId, '2025-03-10');
    const rows = [row({ unitNumber: u, inServiceDate: '2025-01-15' })];

    await applyRosterMerge(query, await planRosterMerge(query, rows));
    const second = await planRosterMerge(query, rows);
    expect(second.actions).toEqual([]);
    expect(second.skips[0]!.kind).toBe('already_covered');

    const p = await periodsFor(u);
    expect(p).toHaveLength(1);
    expect(p[0]!.effective_from).toBe('2025-01-15');
  });

  it('extends only the earliest period, leaving a later transfer period intact', async () => {
    // Zone from March, transferred to Xtrack in June. The roster (Xtrack,
    // in service January) must not touch the Xtrack period or the Zone one.
    const u = unit();
    await withHistory(u, zoneId, '2025-03-01');
    await query(
      `UPDATE accounting.truck_entity_history h SET effective_to = '2025-05-31'
         FROM accounting.truck t WHERE t.truck_id = h.truck_id AND t.unit_number = $1`,
      [u],
    );
    await query(
      `INSERT INTO accounting.truck_entity_history (truck_id, entity_id, effective_from, basis, confidence)
       SELECT truck_id, $2, '2025-06-01'::date, 'dispatch: transferred', 'confirmed'
         FROM accounting.truck WHERE unit_number = $1`,
      [u, xtrackId],
    );

    const plan = await planRosterMerge(query, [
      row({ unitNumber: u, company: 'XTRACK', inServiceDate: '2025-01-05' }),
    ]);
    // Earliest period is Zone's, and the roster says Xtrack — a conflict, not
    // a silent rewrite of the pre-transfer history.
    expect(plan.actions).toEqual([]);
    expect(plan.skips[0]!.kind).toBe('conflict_other_company');

    await applyRosterMerge(query, plan);
    const p = await periodsFor(u);
    expect(p.map((x) => [x.code, x.effective_from])).toEqual([
      ['ZONE', '2025-03-01'],
      ['XTRACK', '2025-06-01'],
    ]);
  });
});
