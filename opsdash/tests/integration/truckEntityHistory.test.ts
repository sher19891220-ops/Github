/**
 * A truck's carrier is a fact with a date on it.
 *
 * Units move between the carriers mid-year, and units leave — returned to the
 * vendor, or an owner-operator who quits. These tests pin the two things that
 * makes safe: the resolver answers by date, and the database refuses a roster
 * that would make the date lookup ambiguous.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/db/pool';
import { resolveEntityFromTruck } from '@/db/repo/entityResolution';
import { ENTITY_AFG_ID, ENTITY_XTRACK_ID, ENTITY_ZONE_ID, ensureBaseFixtures } from './helpers';

/** Unique per test so files can run in parallel without a global TRUNCATE. */
const unit = (label: string) => `T-${label}-${randomUUID().slice(0, 8)}`;

async function assign(
  unitNumber: string,
  entityId: string,
  from: string,
  to: string | null,
  basis = 'test',
): Promise<void> {
  await query(`INSERT INTO accounting.truck (unit_number) VALUES ($1) ON CONFLICT DO NOTHING`, [
    unitNumber,
  ]);
  await query(
    `INSERT INTO accounting.truck_entity_history
       (truck_id, entity_id, effective_from, effective_to, basis)
     SELECT t.truck_id, $2, $3::date, $4::date, $5
       FROM accounting.truck t WHERE t.unit_number = $1`,
    [unitNumber, entityId, from, to, basis],
  );
}

describe('truck → carrier resolution is effective-dated', () => {
  beforeAll(async () => {
    await ensureBaseFixtures();
  });

  it('attributes each side of a transfer to the carrier that ran it', async () => {
    const u = unit('xfer');
    await assign(u, ENTITY_XTRACK_ID, '2026-01-01', '2026-03-29');
    await assign(u, ENTITY_ZONE_ID, '2026-03-30', null);

    // Revenue earned the day before the move belongs to the old carrier.
    await expect(resolveEntityFromTruck(query, u, '2026-03-29')).resolves.toMatchObject({
      entityId: ENTITY_XTRACK_ID,
    });
    // And the day of the move to the new one.
    await expect(resolveEntityFromTruck(query, u, '2026-03-30')).resolves.toMatchObject({
      entityId: ENTITY_ZONE_ID,
    });
    await expect(resolveEntityFromTruck(query, u, '2026-01-01')).resolves.toMatchObject({
      entityId: ENTITY_XTRACK_ID,
    });
    await expect(resolveEntityFromTruck(query, u, '2026-12-31')).resolves.toMatchObject({
      entityId: ENTITY_ZONE_ID,
    });
  });

  it('refuses a date before the unit arrived rather than back-dating it', async () => {
    const u = unit('early');
    await assign(u, ENTITY_ZONE_ID, '2026-06-01', null);

    // The neighbouring period is NOT a safe default: the unit was somewhere
    // else, or nowhere. Inventing the carrier here would misstate two P&Ls.
    await expect(resolveEntityFromTruck(query, u, '2026-05-31')).resolves.toEqual({
      entityId: null,
      resolvedFrom: 'unresolved',
      reason: 'outside_period',
    });
  });

  it('stops attributing revenue to a carrier after the unit left it', async () => {
    // An owner-operator who quit in February. March revenue on this unit is
    // somebody else's, and must not land on the carrier they left.
    const u = unit('left');
    await assign(u, ENTITY_AFG_ID, '2026-01-05', '2026-02-08');

    await expect(resolveEntityFromTruck(query, u, '2026-02-08')).resolves.toMatchObject({
      entityId: ENTITY_AFG_ID,
    });
    await expect(resolveEntityFromTruck(query, u, '2026-02-09')).resolves.toEqual({
      entityId: null,
      resolvedFrom: 'unresolved',
      reason: 'outside_period',
    });
  });

  it('answers an undated row when the unit never moved, and refuses when it did', async () => {
    const stayed = unit('stayed');
    await assign(stayed, ENTITY_ZONE_ID, '2026-01-01', null);
    // One assignment: the date cannot change the answer, so not having one
    // is not a reason to strand the revenue.
    await expect(resolveEntityFromTruck(query, stayed, null)).resolves.toMatchObject({
      entityId: ENTITY_ZONE_ID,
    });

    const moved = unit('moved');
    await assign(moved, ENTITY_XTRACK_ID, '2026-01-01', '2026-03-29');
    await assign(moved, ENTITY_AFG_ID, '2026-03-30', null);
    await expect(resolveEntityFromTruck(query, moved, null)).resolves.toEqual({
      entityId: null,
      resolvedFrom: 'unresolved',
      reason: 'date_required',
    });
  });

  it('reports an unknown unit as unknown, not as a period miss', async () => {
    await expect(resolveEntityFromTruck(query, unit('ghost'), '2026-02-01')).resolves.toEqual({
      entityId: null,
      resolvedFrom: 'unresolved',
      reason: 'no_assignment',
    });
  });

  it('carries the basis through, so a reviewer can judge the attribution', async () => {
    const u = unit('basis');
    await assign(u, ENTITY_ZONE_ID, '2026-01-01', null, 'dispatch roster Company Type, declared');
    const got = await resolveEntityFromTruck(query, u, '2026-02-01');
    expect(got).toMatchObject({ basis: 'dispatch roster Company Type, declared' });
  });
});

describe('the database refuses a roster the resolver could not answer', () => {
  beforeAll(async () => {
    await ensureBaseFixtures();
  });

  it('rejects two carriers for one unit on the same day', async () => {
    const u = unit('overlap');
    await assign(u, ENTITY_ZONE_ID, '2026-01-01', '2026-03-29');
    // Overlaps by exactly one day. Without this constraint the resolver would
    // return whichever row the planner happened to reach first.
    await expect(assign(u, ENTITY_XTRACK_ID, '2026-03-29', null)).rejects.toThrow(
      /truck_entity_history_never_overlaps/,
    );
  });

  it('rejects a second open-ended period for the same unit', async () => {
    const u = unit('twoopen');
    await assign(u, ENTITY_ZONE_ID, '2026-01-01', null);
    await expect(assign(u, ENTITY_AFG_ID, '2026-06-01', null)).rejects.toThrow(
      /truck_entity_history_never_overlaps/,
    );
  });

  it('accepts adjacent periods, which is what a real transfer looks like', async () => {
    const u = unit('adjacent');
    await assign(u, ENTITY_ZONE_ID, '2026-01-01', '2026-03-29');
    await expect(assign(u, ENTITY_XTRACK_ID, '2026-03-30', null)).resolves.toBeUndefined();
  });

  it('rejects a period that ends before it starts', async () => {
    const u = unit('backwards');
    await expect(assign(u, ENTITY_ZONE_ID, '2026-03-30', '2026-01-01')).rejects.toThrow(
      /assignment_period_is_ordered/,
    );
  });
});
