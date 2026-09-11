/**
 * `commitDocument` — the ownership double-charge guard (SOURCE-DISCOVERY.md
 * §11h): a cost charged directly to a driver who is *also* that truck's
 * ownership-recorded cost bearer (a lease-to-purchase driver who has paid
 * the unit off, or an owner-operator) double-bills them. This must be
 * flagged and rejected, never silently resolved — see truckOwnership.ts.
 *
 * Run with `DATABASE_URL=$(npm run -s db:local) npx vitest run tests/integration`.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/db/pool';
import { createDocument, getDocumentRows } from '@/db/repo/documents';
import { commitDocument } from '@/db/repo/commit';
import { updateStagingRow } from '@/db/repo/stagingRows';
import { listLedgerEntries } from '@/db/repo/ledger';
import { CATEGORY_MAINTENANCE, ENTITY_XTRACK_ID, ensureBaseFixtures } from './helpers';
import { dispatchFixture, expensesFixture } from './fixtures';

/**
 * A real VIN from the real ownership crosswalk — one whose `cost_bearer`
 * is `ltp_owner`, i.e. a driver who has paid the unit off and therefore
 * already bears 100% of its costs.
 *
 * It must be a real VIN, not a synthetic one (CLAUDE.md §2): the conflict
 * this test exercises is detected by looking the VIN up in that crosswalk,
 * so a made-up VIN finds nothing and the test passes for the wrong reason
 * — it did that for one commit until this comment was written.
 *
 * So it is READ from the crosswalk at run time rather than written down
 * here. This repository is public and VINs are fleet data; the file it
 * comes from is gitignored.
 */
function firstLtpOwnerVin(): string {
  const path = process.env.OPSDASH_IRP_OWNERSHIP_PATH ?? '/home/user/opsdash-fixtures/irp_unit_ownership.csv';
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0]!.split(',').map((c) => c.trim().toLowerCase());
  const vinIdx = header.indexOf('vin');
  const bearerIdx = header.indexOf('cost_bearer');
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    if ((cells[bearerIdx] ?? '').trim() === 'ltp_owner') return (cells[vinIdx] ?? '').trim();
  }
  throw new Error('no ltp_owner row in the ownership crosswalk');
}

const LTP_OWNER_VIN = firstLtpOwnerVin();

beforeAll(async () => {
  await ensureBaseFixtures();
});

async function makeTruck(vin: string): Promise<string> {
  const truckId = randomUUID();
  await query(`INSERT INTO accounting.truck (truck_id, unit_number, vin) VALUES ($1, $2, $3)`, [
    truckId,
    `TEST-${Date.now()}-${truckId.slice(0, 8)}`,
    vin,
  ]);
  return truckId;
}

async function makeDriver(name: string): Promise<string> {
  const driverId = randomUUID();
  await query(`INSERT INTO accounting.driver (driver_id, full_name) VALUES ($1, $2)`, [driverId, name]);
  return driverId;
}

describe('commitDocument — ownership conflict (SOURCE-DISCOVERY.md §11h)', () => {
  it('flags and rejects a cost charged to a driver who already owns that unit, naming both facts', async () => {
    const truckId = await makeTruck(LTP_OWNER_VIN);
    const driverId = await makeDriver(`Owner Driver ${randomUUID()}`);

    // Establish (via the real commit path, not a shortcut) that this driver
    // has been recorded driving this exact truck as lease_to_own — the same
    // unit-to-driver-class signal SOURCE-DISCOVERY.md §11c says comes from
    // the dispatch sheet and lands in `ledger_entry.driver_class`.
    await query(
      `INSERT INTO accounting.driver_class_history (driver_id, class, entity_id, effective_from)
       VALUES ($1, 'lease_to_own', $2, '2026-01-01')`,
      [driverId, ENTITY_XTRACK_ID],
    );
    const priorDoc = await createDocument({
      docType: 'revenue',
      fileName: 'ownership-setup.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from(dispatchFixture(`OWN-${Date.now()}`, '500.00'), 'utf8'),
      uploadedBy: 'integration-test',
    });
    const [priorRow] = await getDocumentRows(priorDoc.documentId);
    const priorEdit = await updateStagingRow(priorRow!.stagingRowId, { truckId, driverId });
    if (!priorEdit.ok) throw new Error('setup failed: could not attach truck/driver to the prior revenue row');
    const priorCommit = await commitDocument(priorDoc.documentId, 'controller@fleet');
    expect(priorCommit.committed).toBe(1);

    // Confirm the snapshot actually landed as lease_to_own — the exact fact
    // the conflict check depends on.
    const priorEntries = await listLedgerEntries({ truckId, driverId });
    expect(priorEntries).toHaveLength(1);
    expect(priorEntries[0]?.driverClass).toBe('lease_to_own');

    // A second, independent document now charges a maintenance cost
    // directly to that same driver, for that same truck.
    const costDoc = await createDocument({
      docType: 'maintenance',
      fileName: 'ownership-conflict.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from(expensesFixture('UNITX', '250.00', 'driver', '01.20.26'), 'utf8'),
      uploadedBy: 'integration-test',
    });
    const [costRow] = await getDocumentRows(costDoc.documentId);
    const costEdit = await updateStagingRow(costRow!.stagingRowId, {
      entityId: ENTITY_XTRACK_ID,
      truckId,
      driverId,
      categoryId: CATEGORY_MAINTENANCE,
    });
    if (!costEdit.ok) throw new Error('setup failed: could not attach truck/driver/category to the cost row');

    const result = await commitDocument(costDoc.documentId, 'controller@fleet');

    // Flagged, not silently resolved: the row does not commit.
    expect(result.committed).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.entryIds).toHaveLength(0);

    const rows = await getDocumentRows(costDoc.documentId);
    expect(rows[0]?.status).toBe('rejected');
    // The reason names both facts: this row charges the driver directly,
    // and that same driver already owns the unit (ltp_owner / lease_to_own).
    expect(rows[0]?.reviewNotes).toMatch(/CONFLICT/);
    expect(rows[0]?.reviewNotes).toMatch(/charged_to='driver'/);
    expect(rows[0]?.reviewNotes).toMatch(/ltp_owner/);
    expect(rows[0]?.reviewNotes).toMatch(/lease_to_own/);

    // And nothing posted to the ledger for it.
    const costEntries = await listLedgerEntries({ truckId, driverId, categoryId: CATEGORY_MAINTENANCE });
    expect(costEntries).toHaveLength(0);
  });

  it('does not flag an ordinary driver charge when the truck has no ownership signal', async () => {
    // A VIN absent from the ownership crosswalk entirely — the check must
    // never manufacture a conflict out of missing data.
    const truckId = await makeTruck(`NOMATCH-${randomUUID()}`);
    const driverId = await makeDriver(`Ordinary Driver ${randomUUID()}`);

    const costDoc = await createDocument({
      docType: 'maintenance',
      fileName: 'ordinary-charge.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from(expensesFixture('UNITY', '100.00', 'driver', '01.20.26'), 'utf8'),
      uploadedBy: 'integration-test',
    });
    const [costRow] = await getDocumentRows(costDoc.documentId);
    const edited = await updateStagingRow(costRow!.stagingRowId, {
      entityId: ENTITY_XTRACK_ID,
      truckId,
      driverId,
      categoryId: CATEGORY_MAINTENANCE,
    });
    if (!edited.ok) throw new Error('setup failed');

    const result = await commitDocument(costDoc.documentId, 'controller@fleet');
    expect(result.committed).toBe(1);
    expect(result.rejected).toBe(0);
  });
});
