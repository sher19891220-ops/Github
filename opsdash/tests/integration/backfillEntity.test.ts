/**
 * Giving a company to rows that have none.
 *
 * Two sources of very different strength, and the tests exist mostly to
 * keep them from being confused: what the sheet SAYS bore a cost, and what
 * a truck's carrier history IMPLIES about a cost that predates it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query } from '@/db/pool';
import { applyEntityBackfill, codeFromBearer, planEntityBackfill } from '@/db/repo/backfillEntity';
import { resolveEntityFromTruck } from '@/db/repo/entityResolution';
import { ENTITY_XTRACK_ID, ENTITY_ZONE_ID, ensureBaseFixtures } from './helpers';

/** A unit number no other test will use. Real unit numbers are numeric, so
 *  a non-numeric one would not exercise the same lookup path. */
let unitSeq = 0;
function uniqNumeric(): string {
  return `9${Date.now() % 100000}${unitSeq++}`;
}

let documentId: string;
/** The shared fixtures use codes like ZONE-TEST, but a bearer on the real
 *  sheet says "Zone". So this file needs an entity whose code the bearer
 *  actually maps to, or the test proves nothing about the mapping. */
let realZoneId: string;

beforeAll(async () => {
  await ensureBaseFixtures();
  const doc = await query<{ document_id: string }>(
    `INSERT INTO accounting.source_document
       (doc_type, file_name, mime_type, byte_size, sha256, storage_key, uploaded_by)
     VALUES ('maintenance','expenses.txt','text/plain',1,$1,$2,'test') RETURNING document_id`,
    [randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), `${randomUUID()}.bin`],
  );
  documentId = doc[0]!.document_id;
  const z = await query<{ entity_id: string }>(
    `INSERT INTO accounting.entity (code, legal_name, kind) VALUES ('ZONE','Zone OH LLC','carrier')
     ON CONFLICT (code) DO UPDATE SET legal_name = EXCLUDED.legal_name
     RETURNING entity_id`,
  );
  realZoneId = z[0]!.entity_id;
});

let idx = 0;
async function truckWithPeriod(entityId: string, from: string, to: string | null): Promise<string> {
  const unit = uniqNumeric();
  const t = await query<{ truck_id: string }>(
    `INSERT INTO accounting.truck (unit_number) VALUES ($1) RETURNING truck_id`, [unit]);
  await query(
    `INSERT INTO accounting.truck_entity_history (truck_id, entity_id, effective_from, effective_to, basis, confidence)
     VALUES ($1,$2,$3::date,$4::date,'test','confirmed')`,
    [t[0]!.truck_id, entityId, from, to],
  );
  return unit;
}

async function stage(over: { unit?: string | null; date?: string | null; unitType?: string; bearer?: string | null }): Promise<string> {
  const r = await query<{ staging_row_id: string }>(
    `INSERT INTO accounting.staging_row
       (document_id, row_index, parsed_payload, unit_number, accrual_date, amount, status)
     VALUES ($1,$2,$3::jsonb,$4,$5::date,-100,'under_review') RETURNING staging_row_id`,
    [documentId, idx++,
     JSON.stringify({ unitType: over.unitType ?? 'truck', expenseBearerRaw: over.bearer ?? null }),
     over.unit ?? null, over.date ?? null],
  );
  return r[0]!.staging_row_id;
}

const find = (plan: Awaited<ReturnType<typeof planEntityBackfill>>, id: string) =>
  plan.proposals.find((p) => p.stagingRowId === id);

describe('a cost dated before the truck ever earned', () => {
  it('is attributed to the carrier of its earliest period', async () => {
    // truck_entity_history is built from the dispatch sheet, so a period
    // starts the first week a truck EARNED. A truck is bought, prepped,
    // plated and repaired before it earns anything.
    const unit = await truckWithPeriod(ENTITY_XTRACK_ID, '2026-03-01', null);
    const row = await stage({ unit, date: '2026-01-15' });
    const p = find(await planEntityBackfill(query), row);
    expect(p).toMatchObject({ entityId: ENTITY_XTRACK_ID, source: 'earliest_period' });
    expect(p!.note).toMatch(/predates/);
    expect(p!.note).toMatch(/Inferred/);
  });

  it('will NOT run the other way, past the end of the last period', async () => {
    // Extending forward would claim a truck's costs for a carrier after it
    // left — the exact error the effective dating exists to prevent.
    const unit = await truckWithPeriod(ENTITY_XTRACK_ID, '2026-01-01', '2026-03-01');
    const row = await stage({ unit, date: '2026-09-01' });
    expect(find(await planEntityBackfill(query), row)).toBeUndefined();
  });

  it('is off unless asked for', async () => {
    const unit = await truckWithPeriod(ENTITY_ZONE_ID, '2026-03-01', null);
    const plain = await resolveEntityFromTruck(query, unit, '2026-01-15');
    expect(plain.entityId).toBeNull();
    const opted = await resolveEntityFromTruck(query, unit, '2026-01-15', { beforeFirstPeriod: true });
    expect(opted.entityId).toBe(ENTITY_ZONE_ID);
  });

  it('still prefers a real period when one covers the date', async () => {
    const unit = await truckWithPeriod(ENTITY_ZONE_ID, '2026-01-01', null);
    const r = await resolveEntityFromTruck(query, unit, '2026-06-01', { beforeFirstPeriod: true });
    expect(r).toMatchObject({ resolvedFrom: 'truck_roster' });
  });
});

describe('what the row itself says', () => {
  it('beats anything a truck history could imply', async () => {
    // Stated evidence over inference, always.
    const unit = await truckWithPeriod(ENTITY_XTRACK_ID, '2026-03-01', null);
    const row = await stage({ unit, date: '2026-01-15', bearer: 'Zone' });
    const p = find(await planEntityBackfill(query), row);
    expect(p).toMatchObject({ entityId: realZoneId, source: 'bearer' });
  });

  it('reads the company names the sheet actually writes', () => {
    expect(codeFromBearer('Zone OH')).toBe('ZONE');
    expect(codeFromBearer('Iron Lease exp')).toBe('IRONLEASE');
    expect(codeFromBearer('xtuck')).toBe('XTRACK');       // a real misspelling in the sheet
    expect(codeFromBearer('Iron lease exp&#9;')).toBe('IRONLEASE');
  });

  it('refuses to turn STL into a company', () => {
    // The pipeline records the 80xx/81xx block as Zone's own. Measured here,
    // 65 of 89 STL-bearing rows carry units prefixed "ST" and only 9 are in
    // that block, so mapping them all to Zone would invent a fact.
    expect(codeFromBearer('STL exp')).toBeNull();
    expect(codeFromBearer('stl')).toBeNull();
  });

  it('refuses "company", which names no company', () => {
    expect(codeFromBearer('company')).toBeNull();
    expect(codeFromBearer('driver')).toBeNull();
  });
});

describe('what it leaves alone', () => {
  it('never resolves a trailer row from the truck beside it', async () => {
    // Trailers are pooled; nearly half of those with enough history were
    // pulled by more than one carrier's trucks.
    const unit = await truckWithPeriod(ENTITY_XTRACK_ID, '2026-03-01', null);
    const row = await stage({ unit, date: '2026-01-15', unitType: 'trailer' });
    expect(find(await planEntityBackfill(query), row)).toBeUndefined();
  });

  it('leaves a unit that is not in the roster', async () => {
    const row = await stage({ unit: uniqNumeric(), date: '2026-01-15' });
    expect(find(await planEntityBackfill(query), row)).toBeUndefined();
  });

  it('leaves a row with no date, because no period can be checked', async () => {
    const unit = await truckWithPeriod(ENTITY_ZONE_ID, '2026-03-01', null);
    const row = await stage({ unit, date: null });
    expect(find(await planEntityBackfill(query), row)).toBeUndefined();
  });
});

describe('applying', () => {
  it('writes the reason onto the row and leaves it under review', async () => {
    // An inferred company is a proposal for a person, never a posting.
    const unit = await truckWithPeriod(ENTITY_XTRACK_ID, '2026-03-01', null);
    const row = await stage({ unit, date: '2026-01-15' });
    const plan = await planEntityBackfill(query);
    await applyEntityBackfill(query, plan.proposals.filter((p) => p.stagingRowId === row), 'tester');
    const after = await query<{ entity_id: string; status: string; review_notes: string }>(
      `SELECT entity_id, status, review_notes FROM accounting.staging_row WHERE staging_row_id = $1`, [row]);
    expect(after[0]!.entity_id).toBe(ENTITY_XTRACK_ID);
    expect(after[0]!.status).toBe('under_review');
    expect(after[0]!.review_notes).toMatch(/predates/);
  });

  it('does not overwrite a company already on the row', async () => {
    const unit = await truckWithPeriod(ENTITY_XTRACK_ID, '2026-03-01', null);
    const row = await stage({ unit, date: '2026-01-15' });
    await query(`UPDATE accounting.staging_row SET entity_id = $2 WHERE staging_row_id = $1`, [row, ENTITY_ZONE_ID]);
    const n = await applyEntityBackfill(query, [{ stagingRowId: row, entityId: ENTITY_XTRACK_ID, source: 'bearer', note: 'x' }], 'tester');
    expect(n).toBe(0);
  });
});
