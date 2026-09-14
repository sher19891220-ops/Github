/**
 * Charge is not cost, and the database will not let you pretend otherwise.
 *
 * The operator was explicit: the arrangement figures on the driver sheet —
 * $650 a week for an owner-operator, $1,650 for lease-to-walk-away — are
 * what drivers are CHARGED. What those things cost the company is a
 * different number, and in a lease-to-own business the gap between them is
 * the whole economics of the programme.
 *
 * Filed under one name that gap disappears. The charge lands in revenue,
 * the cost lands in expense, and at fleet level they net into a margin that
 * looks fine while an individual arrangement bleeds every week.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query } from '@/db/pool';
import { rateSpread, upsertRateFact, validateRateFact, RateFactError, type RateFactInput } from '@/db/repo/rateFacts';
import { ENTITY_ZONE_ID, ensureBaseFixtures } from './helpers';

let sourceDocumentId: string;
let calcRunId: string;

beforeAll(async () => {
  await ensureBaseFixtures();

  const doc = await query<{ document_id: string }>(
    `INSERT INTO accounting.source_document (doc_type, file_name, mime_type, byte_size, sha256, storage_key, uploaded_by)
     VALUES ('revenue', 'arrangement-sheet.txt', 'text/plain', 1, $1, $2, 'test')
     RETURNING document_id`,
    [randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), `${randomUUID()}.bin`],
  );
  sourceDocumentId = doc[0]!.document_id;

  const run = await query<{ calc_run_id: string }>(
    `INSERT INTO accounting.calc_run (engine, engine_version, period_start, period_end, inputs_hash, status)
     VALUES ('pipeline', 'test', '2026-01-01', '2026-12-31', $1, 'succeeded')
     RETURNING calc_run_id`,
    [randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64)],
  );
  calcRunId = run[0]!.calc_run_id;
});

function charge(over: Partial<RateFactInput> = {}): RateFactInput {
  return {
    rateKey: `charge.arrangement.insurance.per_week.${randomUUID().slice(0, 8)}`,
    kind: 'stated',
    amount: '350.0000',
    basis: 'per_period',
    effectiveFrom: '2026-01-01',
    driverClass: 'owner_operator',
    sourceDocumentId,
    recordedBy: 'test',
    ...over,
  };
}

describe('a rate must say whether it is a charge or a cost', () => {
  it('refuses a key that says neither', () => {
    expect(() => validateRateFact(charge({ rateKey: 'arrangement.insurance.per_week' }))).toThrow(RateFactError);
  });

  it('explains why, in terms of what goes wrong', () => {
    const err = (() => {
      try {
        validateRateFact(charge({ rateKey: 'insurance.per_week' }));
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toMatch(/whether an arrangement pays/);
  });

  it('is enforced by the database too, not only by this code', async () => {
    // Bypassing the app-level check entirely: the constraint is the thing
    // that has to hold, because application code is what gets edited.
    await expect(
      query(
        `INSERT INTO accounting.rate_fact (rate_key, kind, amount, basis, effective_from, source_document_id, recorded_by)
         VALUES ('arrangement.insurance', 'stated', 1, 'per_period', '2026-01-01', $1, 'test')`,
        [sourceDocumentId],
      ),
    ).rejects.toThrow(/rate_key_says_charge_or_cost/);
  });
});

describe('a rate must name its origin', () => {
  it('refuses a stated rate with no document', () => {
    expect(() => validateRateFact(charge({ sourceDocumentId: null }))).toThrow(/number somebody remembered/);
  });

  it('refuses a measured rate with no calculation', () => {
    expect(() =>
      validateRateFact(charge({ kind: 'measured', sourceDocumentId: null, calcRunId: null, rateKey: 'cost.x' })),
    ).toThrow(/re-runnable/);
  });

  it('accepts a measured rate that names its run', async () => {
    const r = await upsertRateFact(query, charge({
      rateKey: `cost.telematics.per_truck_week.${randomUUID().slice(0, 8)}`,
      kind: 'measured',
      sourceDocumentId: null,
      calcRunId,
      entityId: ENTITY_ZONE_ID,
    }));
    expect(r).toBe('inserted');
  });
});

describe('loading twice', () => {
  it('does not duplicate an unchanged rate', async () => {
    const r = charge();
    expect(await upsertRateFact(query, r)).toBe('inserted');
    expect(await upsertRateFact(query, r)).toBe('unchanged');
  });

  it('reports a conflict rather than overwriting a rate that changed', async () => {
    // A rate that moved needs a new period. Overwriting the old one would
    // silently restate what every past week was charged at.
    const r = charge();
    await upsertRateFact(query, r);
    expect(await upsertRateFact(query, { ...r, amount: '400.0000' })).toBe('conflict');

    const rows = await query<{ amount: string }>(
      `SELECT amount::text AS amount FROM accounting.rate_fact WHERE rate_key = $1`,
      [r.rateKey],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.amount)).toBe(350);
  });
});

describe('the spread — what the charge/cost split exists to show', () => {
  it('subtracts a matched pair', async () => {
    const subject = `arrangement.trailer_rent.per_week.${randomUUID().slice(0, 8)}`;
    await upsertRateFact(query, charge({ rateKey: `charge.${subject}`, amount: '200.0000' }));
    await upsertRateFact(query, charge({
      rateKey: `cost.${subject}`, kind: 'measured', sourceDocumentId: null, calcRunId, amount: '150.0000',
    }));

    const row = (await rateSpread(query, '2026-06-01')).find((r) => r.subject === subject);
    expect(row).toBeDefined();
    expect(Number(row!.charge)).toBe(200);
    expect(Number(row!.cost)).toBe(150);
    expect(Number(row!.spread)).toBe(50);
  });

  it('shows a NEGATIVE spread — the truck that loses money every week it runs', async () => {
    // The case the whole split exists for. Netted into one figure this is
    // invisible; at fleet level it is buried under the profitable units.
    const subject = `arrangement.insurance.per_week.${randomUUID().slice(0, 8)}`;
    await upsertRateFact(query, charge({ rateKey: `charge.${subject}`, amount: '350.0000' }));
    await upsertRateFact(query, charge({
      rateKey: `cost.${subject}`, kind: 'measured', sourceDocumentId: null, calcRunId, amount: '520.0000',
    }));

    const row = (await rateSpread(query, '2026-06-01')).find((r) => r.subject === subject);
    expect(Number(row!.spread)).toBe(-170);
  });

  it('keeps a charge that nobody has priced, rather than dropping it', async () => {
    // A missing cost is the thing worth seeing. Dropping the row would
    // report the arrangement as fine because half of it is absent.
    const subject = `arrangement.admin_fee.per_week.${randomUUID().slice(0, 8)}`;
    await upsertRateFact(query, charge({ rateKey: `charge.${subject}`, amount: '100.0000' }));

    const row = (await rateSpread(query, '2026-06-01')).find((r) => r.subject === subject);
    expect(row).toBeDefined();
    expect(Number(row!.charge)).toBe(100);
    expect(row!.cost).toBeNull();
    expect(row!.spread).toBeNull();
  });


  it('pairs a per-arrangement charge with a fleet-wide cost', async () => {
    // The real shape of this data: the charge knows which arrangement it
    // belongs to, the measured cost came off an invoice and knows only the
    // carrier. Matching on both would mean they never meet and every spread
    // reads null — "nothing to see" instead of "never compared".
    const subject = `arrangement.insurance.real.${randomUUID().slice(0, 8)}`;
    await upsertRateFact(query, charge({ rateKey: `charge.${subject}`, amount: '350.0000', driverClass: 'owner_operator' }));
    await upsertRateFact(query, charge({
      rateKey: `cost.${subject}`, kind: 'measured', sourceDocumentId: null, calcRunId,
      amount: '410.0000', driverClass: null, entityId: ENTITY_ZONE_ID,
    }));

    const row = (await rateSpread(query, '2026-06-01')).find((r) => r.subject === subject);
    expect(row).toBeDefined();
    expect(Number(row!.spread)).toBe(-60);
  });

  it('carries the arrangement back out, not an undefined column', async () => {
    // The query aliases to camelCase because nothing maps these rows; an
    // unaliased driver_class came back undefined and every arrangement
    // printed as a dash.
    const subject = `arrangement.named.${randomUUID().slice(0, 8)}`;
    await upsertRateFact(query, charge({ rateKey: `charge.${subject}`, driverClass: 'ltwa' }));
    const row = (await rateSpread(query, '2026-06-01')).find((r) => r.subject === subject);
    expect(row!.driverClass).toBe('ltwa');
  });

  it('keeps a cost nobody bills for', async () => {
    const subject = `overhead.unbilled.${randomUUID().slice(0, 8)}`;
    await upsertRateFact(query, charge({
      rateKey: `cost.${subject}`, kind: 'measured', sourceDocumentId: null, calcRunId,
      amount: '75.0000', driverClass: null,
    }));
    const row = (await rateSpread(query, '2026-06-01')).find((r) => r.subject === subject);
    expect(row).toBeDefined();
    expect(row!.charge).toBeNull();
    expect(Number(row!.cost)).toBe(75);
  });

  it('ignores a rate whose period has ended', async () => {
    const subject = `arrangement.expired.${randomUUID().slice(0, 8)}`;
    await upsertRateFact(query, charge({
      rateKey: `charge.${subject}`, effectiveFrom: '2026-01-01', effectiveTo: '2026-03-01',
    }));
    expect((await rateSpread(query, '2026-06-01')).find((r) => r.subject === subject)).toBeUndefined();
    expect((await rateSpread(query, '2026-02-01')).find((r) => r.subject === subject)).toBeDefined();
  });
});
