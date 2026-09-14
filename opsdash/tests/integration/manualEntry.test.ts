/**
 * Typing a figure in, against a real Postgres.
 *
 * The thing under test is not "can a row be inserted" — it is that the
 * looser path does not become the dishonest one. A typed number must be
 * possible, must name somebody, and must stay distinguishable from a
 * parsed invoice forever after.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/db/pool';
import { centsFromDecimal, sumCents } from '@/engines/registration';
import {
  EntryNotFoundError,
  ManualEntryError,
  attestedShare,
  correctEntry,
  createManualEntry,
  supersedeAttestation,
} from '@/db/repo/manualEntry';
import { listLedgerEntries } from '@/db/repo/ledger';
import { createDocument } from '@/db/repo/documents';
import {
  CATEGORY_MAINTENANCE,
  ENTITY_ZONE_ID,
  ensureBaseFixtures,
} from './helpers';

beforeAll(async () => {
  await ensureBaseFixtures();
});

function baseInput(over: Partial<Parameters<typeof createManualEntry>[0]> = {}) {
  return {
    entityId: ENTITY_ZONE_ID,
    accrualDate: '2026-04-10',
    categoryId: CATEGORY_MAINTENANCE,
    amount: '-1200.00',
    assertedBy: 'controller@fleet',
    basis: 'Shop quoted this by phone; invoice has not arrived yet.',
    ...over,
  };
}

describe('createManualEntry', () => {
  it('posts a typed figure and records who stands behind it', async () => {
    const { entry, attestation } = await createManualEntry(baseInput(), 'controller@fleet');

    expect(entry.amount).toBe('-1200.00');
    expect(entry.provenance.kind).toBe('manual');
    expect(attestation.assertedBy).toBe('controller@fleet');
    expect(attestation.basis).toMatch(/quoted this by phone/);
    expect(attestation.supersededByDocumentId).toBeNull();
  });

  it('refuses a figure with no stated basis', async () => {
    // A figure with no basis is a guess with a name attached, and next
    // quarter nobody can tell the difference.
    await expect(createManualEntry(baseInput({ basis: '   ' }), 'x@fleet')).rejects.toBeInstanceOf(
      ManualEntryError,
    );
  });

  it('refuses a figure nobody is named for', async () => {
    await expect(
      createManualEntry(baseInput({ assertedBy: '' }), 'x@fleet'),
    ).rejects.toBeInstanceOf(ManualEntryError);
  });

  it('refuses an amount that is not exact money', async () => {
    await expect(createManualEntry(baseInput({ amount: '12.3456' }), 'x@fleet')).rejects.toBeInstanceOf(
      ManualEntryError,
    );
    await expect(createManualEntry(baseInput({ amount: '1,200.00' }), 'x@fleet')).rejects.toBeInstanceOf(
      ManualEntryError,
    );
  });

  it('leaves no orphan attestation when the entry itself is rejected', async () => {
    const before = (await query(
      `SELECT count(*)::int AS n FROM accounting.manual_attestation`,
    )) as unknown as { n: number }[];

    // A category that does not exist: the FK fails on the second statement,
    // after the attestation insert has already succeeded.
    await expect(
      createManualEntry(baseInput({ categoryId: 'category.does.not.exist' }), 'x@fleet'),
    ).rejects.toThrow();

    const after = (await query(
      `SELECT count(*)::int AS n FROM accounting.manual_attestation`,
    )) as unknown as { n: number }[];

    // Without a real transaction this is where an assertion about a figure
    // that was never posted would be left behind.
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('stays distinguishable from a parsed figure forever after', async () => {
    const { entry } = await createManualEntry(
      baseInput({ amount: '-77.77', accrualDate: '2026-04-11' }),
      'controller@fleet',
    );

    const rows = (await query(
      `SELECT source_kind, attestation_id, source_document_id
         FROM accounting.ledger_entry WHERE entry_id = $1`,
      [entry.entryId],
    )) as unknown as { source_kind: string; attestation_id: string | null; source_document_id: string | null }[];

    expect(rows[0]!.source_kind).toBe('manual');
    expect(rows[0]!.attestation_id).not.toBeNull();
    // It cannot borrow a document's credibility.
    expect(rows[0]!.source_document_id).toBeNull();
  });
});

describe('correctEntry', () => {
  it('reverses and replaces rather than overwriting', async () => {
    const { entry } = await createManualEntry(
      baseInput({ amount: '-1200.00', accrualDate: '2026-04-20' }),
      'controller@fleet',
    );

    const { reversal, replacement } = await correctEntry(
      entry.entryId,
      { amount: '-1450.00' },
      'controller@fleet',
      'Invoice arrived and it was higher than the phone quote.',
    );

    expect(reversal.amount).toBe('1200.00');
    expect(reversal.provenance.kind).toBe('adjustment');
    expect(reversal.provenance).toMatchObject({ reversesEntryId: entry.entryId });
    expect(replacement.amount).toBe('-1450.00');

    // The original is still on the books — that is the whole point.
    const onDate = await listLedgerEntries({
      entityId: ENTITY_ZONE_ID,
      from: '2026-04-20',
      to: '2026-04-20',
    });
    const mine = new Set([entry.entryId, reversal.entryId, replacement.entryId]);
    const found = onDate.filter((e) => mine.has(e.entryId));
    expect(found).toHaveLength(3);

    // And those three net to the corrected figure, exactly. Scoped to the
    // ids this test created: the database is not reset between runs, so
    // every earlier run's correction is also sitting on this date.
    const net = sumCents(found.map((e) => centsFromDecimal(e.amount)));
    expect(net).toBe(-145000);
  });

  it('refuses a correction with no reason', async () => {
    const { entry } = await createManualEntry(
      baseInput({ accrualDate: '2026-04-21' }),
      'controller@fleet',
    );
    await expect(
      correctEntry(entry.entryId, { amount: '-1.00' }, 'controller@fleet', '  '),
    ).rejects.toBeInstanceOf(ManualEntryError);
  });

  it('names an entry it cannot find', async () => {
    await expect(
      correctEntry('00000000-0000-4000-8000-0000000000ab', { amount: '-1.00' }, 'x@fleet', 'why'),
    ).rejects.toBeInstanceOf(EntryNotFoundError);
  });
});

describe('supersedeAttestation', () => {
  it('records what the document proved without erasing what was believed', async () => {
    const { attestation } = await createManualEntry(
      baseInput({ accrualDate: '2026-04-25', basis: 'Driver texted the amount.' }),
      'controller@fleet',
    );
    const doc = await createDocument({
      docType: 'maintenance',
      fileName: `supersede-${Date.now()}.txt`,
      mimeType: 'text/plain',
      bytes: Buffer.from(`| Unit | Issued To | Unit Type | Cost type | Date | $ used | Expense side | Details |\n| U1 | D | truck | Repair | 04.25.26 | $10.00 | company | ${Date.now()} |\n`, 'utf8'),
      uploadedBy: 'integration-test',
    });

    const after = await supersedeAttestation(attestation.attestationId, doc.documentId);

    expect(after.supersededByDocumentId).toBe(doc.documentId);
    expect(after.supersededAt).not.toBeNull();
    // "We believed X, then the invoice said Y" is what reconciliation needs.
    expect(after.basis).toBe('Driver texted the amount.');
  });
});

describe('attestedShare', () => {
  it('says how much of a period is somebody word rather than a document', async () => {
    await createManualEntry(
      baseInput({ amount: '-500.00', accrualDate: '2026-09-15' }),
      'controller@fleet',
    );

    const share = await attestedShare('2026-09-01', '2026-09-30', ENTITY_ZONE_ID);

    expect(share.attestedCount).toBeGreaterThanOrEqual(1);
    expect(share.totalCount).toBeGreaterThanOrEqual(share.attestedCount);
    // A total that is part-asserted is a different number from one fully
    // documented, and this is what lets a screen say so.
    expect(share.attestedTotal.startsWith('-')).toBe(true);
  });
});
