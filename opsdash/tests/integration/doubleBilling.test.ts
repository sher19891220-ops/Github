/**
 * One repair reaching the ledger from two directions.
 *
 * The expenses sheet records work done by OUTSIDE vendors; Truck Max's
 * invoice log records work done by the group's own shop. Measured on the
 * real sheet those sets are disjoint — its vendors are EFS, PSZ, Loves,
 * Penske, Ryder, Corcentric, Bowman, and Truck Max appears zero times.
 *
 * Disjoint today, and nothing enforced it. The failure would be silent and
 * expensive: one repair posted from both sources charges the carrier twice
 * and credits the shop for work already inside another number, and both
 * entries look individually correct.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query } from '@/db/pool';
import { findPossibleDoubleBilling } from '@/db/repo/doubleBilling';
import { ENTITY_XTRACK_ID, ensureBaseFixtures } from './helpers';

let documentId: string;
let attestationId: string;

beforeAll(async () => {
  await ensureBaseFixtures();
  const doc = await query<{ document_id: string }>(
    `INSERT INTO accounting.source_document
       (doc_type, file_name, mime_type, byte_size, sha256, storage_key, uploaded_by)
     VALUES ('maintenance','expenses.txt','text/plain',1,$1,$2,'test')
     RETURNING document_id`,
    [randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), `${randomUUID()}.bin`],
  );
  documentId = doc[0]!.document_id;
  const att = await query<{ attestation_id: string }>(
    `INSERT INTO accounting.manual_attestation (asserted_by, basis)
     VALUES ('test','fixture') RETURNING attestation_id`,
  );
  attestationId = att[0]!.attestation_id;
});

let rowIndex = 0;
async function stageRepair(unit: string, date: string, amount: string, vendor: string): Promise<void> {
  await query(
    `INSERT INTO accounting.staging_row
       (document_id, row_index, parsed_payload, unit_number, accrual_date, amount, status)
     VALUES ($1, $2, $3::jsonb, $4, $5::date, $6, 'under_review')`,
    [documentId, rowIndex++, JSON.stringify({ vendorRaw: vendor }), unit, date, amount],
  );
}

async function postRepair(unit: string, date: string, amount: string): Promise<void> {
  await query(
    `INSERT INTO accounting.ledger_entry
       (entity_id, unit_number, accrual_date, category_id, amount, source_kind, attestation_id, posted_by)
     VALUES ($1, $2, $3::date, 'maintenance.repair', $4, 'manual', $5, 'test')`,
    [ENTITY_XTRACK_ID, unit, date, amount, attestationId],
  );
}

function uniqUnit(): string {
  return `U${Math.floor(Math.random() * 1e9)}`;
}

describe('it finds the same repair arriving twice', () => {
  it('matches a repair still waiting in review', async () => {
    const unit = uniqUnit();
    await stageRepair(unit, '2026-04-06', '-1200.50', 'Penske');
    const hits = await findPossibleDoubleBilling(query, {
      unitNumber: unit, accrualDate: '2026-04-06', amount: '1200.50',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ where: 'staging', vendor: 'Penske' });
  });

  it('matches one already posted', async () => {
    const unit = uniqUnit();
    await postRepair(unit, '2026-04-06', '-800.00');
    const hits = await findPossibleDoubleBilling(query, {
      unitNumber: unit, accrualDate: '2026-04-06', amount: '800.00',
    });
    expect(hits.some((h) => h.where === 'ledger')).toBe(true);
  });

  it('searches staging as well as the ledger, because unreviewed work still posts one day', async () => {
    // Finding the clash after both are committed is finding it too late.
    const unit = uniqUnit();
    await stageRepair(unit, '2026-05-01', '-450.00', 'Loves');
    await postRepair(unit, '2026-05-01', '-450.00');
    const hits = await findPossibleDoubleBilling(query, {
      unitNumber: unit, accrualDate: '2026-05-01', amount: '450.00',
    });
    expect(new Set(hits.map((h) => h.where))).toEqual(new Set(['staging', 'ledger']));
  });
});

describe('what it must not flag', () => {
  it('does not match a different amount', async () => {
    const unit = uniqUnit();
    await stageRepair(unit, '2026-04-06', '-1200.50', 'Penske');
    expect(await findPossibleDoubleBilling(query, {
      unitNumber: unit, accrualDate: '2026-04-06', amount: '1200.51',
    })).toHaveLength(0);
  });

  it('does not match a different day', async () => {
    const unit = uniqUnit();
    await stageRepair(unit, '2026-04-06', '-1200.50', 'Penske');
    expect(await findPossibleDoubleBilling(query, {
      unitNumber: unit, accrualDate: '2026-04-07', amount: '1200.50',
    })).toHaveLength(0);
  });

  it('does not match a different unit', async () => {
    await stageRepair(uniqUnit(), '2026-04-06', '-1200.50', 'Penske');
    expect(await findPossibleDoubleBilling(query, {
      unitNumber: uniqUnit(), accrualDate: '2026-04-06', amount: '1200.50',
    })).toHaveLength(0);
  });

  it('returns nothing when the charge names no unit', async () => {
    // Without a unit every repair on that day for that amount would match,
    // and a check that holds unrelated work gets switched off.
    expect(await findPossibleDoubleBilling(query, {
      unitNumber: null, accrualDate: '2026-04-06', amount: '1200.50',
    })).toHaveLength(0);
  });

  it('does not mistake a Truck Max leg for an outside repair', async () => {
    // A posted shop charge carries a pair id. Counting it here would make
    // the loader flag its own previous run as a duplicate of itself.
    const unit = uniqUnit();
    await query(
      `INSERT INTO accounting.ledger_entry
         (entity_id, unit_number, accrual_date, category_id, amount, intercompany_pair_id,
          counterparty_entity_id, source_kind, attestation_id, posted_by)
       VALUES ($1, $2, '2026-04-06', 'maintenance.repair', -600, $3, $4, 'manual', $5, 'test')`,
      [ENTITY_XTRACK_ID, unit, randomUUID(), (await query<{ entity_id: string }>(
        `SELECT entity_id FROM accounting.entity WHERE entity_id <> $1 LIMIT 1`, [ENTITY_XTRACK_ID],
      ))[0]!.entity_id, attestationId],
    );
    expect(await findPossibleDoubleBilling(query, {
      unitNumber: unit, accrualDate: '2026-04-06', amount: '600.00',
    })).toHaveLength(0);
  });
});
