/**
 * Truck status, against a real Postgres.
 *
 * The behaviour that matters is not "a status can be stored" — it is that
 * the board cannot be made to lie about capacity. A truck in two states at
 * once, a status that restates history, or an unmarked truck counted as
 * available are all ways to report fleet capacity that does not exist.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/db/pool';
import {
  TruckStatusError,
  listCurrentStatus,
  setTruckStatus,
  statusCounts,
  statusOn,
} from '@/db/repo/truckStatus';
import { ensureBaseFixtures } from './helpers';

beforeAll(async () => {
  await ensureBaseFixtures();
});

async function makeTruck(): Promise<string> {
  const rows = (await query(
    `INSERT INTO accounting.truck (unit_number) VALUES ($1) RETURNING truck_id`,
    [`TS-${randomUUID().slice(0, 8)}`],
  )) as unknown as { truck_id: string }[];
  return rows[0]!.truck_id;
}

const by = { assertedBy: 'dispatch@fleet', basis: 'Driver called in.' } as const;

describe('setTruckStatus', () => {
  it('records a status and says there was nothing before it', async () => {
    const truckId = await makeTruck();
    const r = await setTruckStatus({ truckId, status: 'shop', source: 'manual', ...by });

    expect(r.previous).toBeNull();
    expect(r.current).toBe('shop');
  });

  it('ends the previous state rather than colliding with it', async () => {
    const truckId = await makeTruck();
    await setTruckStatus({
      truckId,
      status: 'shop',
      source: 'manual',
      effectiveFrom: '2026-03-01T08:00:00Z',
      ...by,
    });

    // A naive insert here would be rejected by the exclusion constraint,
    // and the person would see a constraint name rather than a status.
    const r = await setTruckStatus({
      truckId,
      status: 'assigned',
      source: 'manual',
      effectiveFrom: '2026-03-05T17:00:00Z',
      ...by,
    });

    expect(r.previous).toBe('shop');
    expect(r.current).toBe('assigned');

    const spans = (await query(
      `SELECT status, effective_to FROM accounting.truck_status_history
        WHERE truck_id = $1 ORDER BY effective_from`,
      [truckId],
    )) as unknown as { status: string; effective_to: string | null }[];

    expect(spans).toHaveLength(2);
    expect(spans[0]!.effective_to).not.toBeNull();
    expect(spans[1]!.effective_to).toBeNull();
  });

  it('refuses a status that would start before the one it ends', async () => {
    const truckId = await makeTruck();
    await setTruckStatus({
      truckId,
      status: 'assigned',
      source: 'manual',
      effectiveFrom: '2026-03-10T08:00:00Z',
      ...by,
    });

    await expect(
      setTruckStatus({
        truckId,
        status: 'shop',
        source: 'manual',
        effectiveFrom: '2026-03-01T08:00:00Z',
        ...by,
      }),
    ).rejects.toBeInstanceOf(TruckStatusError);
  });

  it('will not take a hand-marked status nobody is named for', async () => {
    const truckId = await makeTruck();
    await expect(
      setTruckStatus({ truckId, status: 'shop', source: 'manual', assertedBy: '', basis: 'x' }),
    ).rejects.toBeInstanceOf(TruckStatusError);
    await expect(
      setTruckStatus({ truckId, status: 'shop', source: 'manual', assertedBy: 'a@b', basis: '  ' }),
    ).rejects.toBeInstanceOf(TruckStatusError);
  });

  it('will not take a telematics status with no pull behind it', async () => {
    const truckId = await makeTruck();
    // Same rule as a ledger entry: name where it came from, or it does not
    // go in.
    await expect(
      setTruckStatus({ truckId, status: 'assigned', source: 'samsara' }),
    ).rejects.toBeInstanceOf(TruckStatusError);
  });
});

describe('statusOn', () => {
  it('answers for the day asked about, not for today', async () => {
    const truckId = await makeTruck();
    await setTruckStatus({
      truckId,
      status: 'shop',
      source: 'manual',
      effectiveFrom: '2026-06-01T08:00:00Z',
      ...by,
    });
    await setTruckStatus({
      truckId,
      status: 'assigned',
      source: 'manual',
      effectiveFrom: '2026-06-10T08:00:00Z',
      ...by,
    });

    // The whole reason status is effective-dated: a utilisation report for
    // early June must not be restated by a truck moving on the 10th.
    expect(await statusOn(truckId, '2026-06-05')).toBe('shop');
    expect(await statusOn(truckId, '2026-06-15')).toBe('assigned');
  });

  it('returns null before anything was known about the truck', async () => {
    const truckId = await makeTruck();
    await setTruckStatus({
      truckId,
      status: 'assigned',
      source: 'manual',
      effectiveFrom: '2026-07-01T08:00:00Z',
      ...by,
    });
    expect(await statusOn(truckId, '2026-06-01')).toBeNull();
  });
});

describe('the board cannot invent capacity', () => {
  it('counts an unmarked truck as unknown, never as open', async () => {
    const unmarked = await makeTruck();
    const marked = await makeTruck();
    await setTruckStatus({ truckId: marked, status: 'open', source: 'manual', ...by });

    const counts = await statusCounts();
    expect(counts.unknown ?? 0).toBeGreaterThanOrEqual(1);

    // And the unmarked truck is absent from the current-status list rather
    // than appearing with a default.
    const current = await listCurrentStatus();
    expect(current.some((s) => s.truckId === unmarked)).toBe(false);
    expect(current.some((s) => s.truckId === marked)).toBe(true);
  });

  it('reports how long a truck has been in its state, for the timers', async () => {
    const truckId = await makeTruck();
    await setTruckStatus({
      truckId,
      status: 'home',
      source: 'manual',
      effectiveFrom: new Date(Date.now() - 50 * 3600 * 1000).toISOString(),
      ...by,
    });

    const row = (await listCurrentStatus()).find((s) => s.truckId === truckId)!;
    // "Home 48+" is a measured duration, not a guess.
    expect(row.hoursInStatus).toBeGreaterThan(48);
    expect(row.status).toBe('home');
  });
});
