/**
 * `GET /api/registration/overhead` — runs the real registration engine
 * against the real IRP roster/status fixtures already present in this
 * environment (never synthetic — see src/db/repo/registrationOverhead.ts).
 * Skips cleanly if those fixtures are not present on the machine running
 * the suite.
 */
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/db/pool';
import { getOverheadRates, RegistrationSourcesUnavailableError } from '@/db/repo/registrationOverhead';
import { GET as getOverheadRoute } from '@/app/api/registration/overhead/route';
import { ENTITY_ZONE_ID, ensureBaseFixtures } from './helpers';

const ROSTER_PATH = '/home/user/opsdash-fixtures/irp_invoice_units.txt';
const STATUS_PATH = '/home/user/opsdash-fixtures/irp_unit_status.csv';
const haveFixtures = existsSync(ROSTER_PATH) && existsSync(STATUS_PATH);

beforeAll(async () => {
  await ensureBaseFixtures();
  // The real roster's "Legal Name" field, resolved through source_key_map —
  // never matched against accounting.entity by string.
  await query(
    `INSERT INTO accounting.source_key_map (canonical_kind, canonical_id, source_system, source_key)
     VALUES ('entity', $1, 'irp', 'ZONE-OH LLC')
     ON CONFLICT (source_system, source_key, canonical_kind) DO NOTHING`,
    [ENTITY_ZONE_ID],
  );
});

describe.skipIf(!haveFixtures)('getOverheadRates — real IRP/HVUT transaction', () => {
  it('returns one real, reconciled overhead rate per unit (42 units)', async () => {
    const rates = await getOverheadRates({ asOf: '2026-09-10' });
    expect(rates).toHaveLength(42);
    for (const r of rates) {
      expect(typeof r.annualTotal).toBe('string');
      expect(typeof r.dailyRate).toBe('string');
      expect(r.entityId).toBe(ENTITY_ZONE_ID); // no recharge crosswalk wired here — stays with the payer
      expect(r.categoryIds).toEqual(['permit.irp', 'tax.hvut']);
    }
  });

  it('the route handler serves the same rates wrapped in { rates }', async () => {
    const res = await getOverheadRoute(new Request('http://localhost/api/registration/overhead?asOf=2026-09-10'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rates).toHaveLength(42);
  });
});

describe('getOverheadRates — missing source documents', () => {
  it('throws a named error rather than fabricating rates when the fixtures are absent', async () => {
    const originalEnv = process.env.OPSDASH_IRP_ROSTER_PATH;
    process.env.OPSDASH_IRP_ROSTER_PATH = '/nonexistent/roster.txt';
    try {
      await expect(getOverheadRates()).rejects.toBeInstanceOf(RegistrationSourcesUnavailableError);
    } finally {
      if (originalEnv === undefined) delete process.env.OPSDASH_IRP_ROSTER_PATH;
      else process.env.OPSDASH_IRP_ROSTER_PATH = originalEnv;
    }
  });
});
