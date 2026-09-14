/**
 * Bulk categorisation against a real database.
 *
 * A single action that writes a category onto hundreds of rows needs
 * different guarantees from one that writes to a row. The tests here are
 * mostly about what it declines to do: it will not touch a committed row,
 * will not overwrite a category somebody already chose, will not accept a
 * category the chart of accounts does not define, and will not run without
 * a basis recorded on every row it changes.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query } from '@/db/pool';
import { createDocument } from '@/db/repo/documents';
import { applyCategoryToGroup, CategoriseError, getCategoryGroups } from '@/db/repo/categorise';
import { CATEGORY_MAINTENANCE, ENTITY_ZONE_ID, ensureBaseFixtures } from './helpers';

/**
 * A small expenses document in the shape the parser actually reads — the
 * same header `tests/integration/fixtures.ts` uses, with a `Cost type`
 * column carrying descriptions taken verbatim from the operator's real
 * export.
 *
 * The amounts descend so the money ordering is unambiguous: repair
 * ($2,000 over two rows) then roadside ($900) then tires ($450), with the
 * unrecognised "restack" last regardless of its size.
 */
const HEADER = '| Unit | Issued To | Unit Type | Cost type | Date | $ used | Expense side | Details |';

function expensesDoc(salt: string): string {
  const rows: Array<[unit: string, costType: string, amount: string]> = [
    ['9101', 'truck repair', '1200.00'],
    ['9102', 'truck repair', '800.00'],
    ['9103', 'towing', '900.00'],
    ['9104', 'tire replacement', '450.00'],
    ['9105', 'restack', '4500.00'],
  ];
  const lines = rows.map(
    ([unit, costType, amount]) =>
      `| ${unit} | Some Driver | truck | ${costType} | 01.15.26 | $${amount} | company | bulk fixture ${salt} |`,
  );
  return [HEADER, ...lines, ''].join('\n');
}

let documentId = '';

beforeAll(async () => {
  await ensureBaseFixtures();
  // Every category the suggestion rules can propose must exist, or an
  // apply fails in front of the operator after they decided.
  await query(
    `INSERT INTO accounting.category (category_id, category_group, display_name, sign) VALUES
       ('maintenance.tires','maintenance','Tires',-1),
       ('maintenance.roadside','maintenance','Roadside',-1)
     ON CONFLICT (category_id) DO NOTHING`,
  );

  const salt = randomUUID().slice(0, 8);
  const doc = await createDocument({
    docType: 'maintenance',
    fileName: `bulk-${salt}.txt`,
    mimeType: 'text/plain',
    bytes: Buffer.from(expensesDoc(salt), 'utf8'),
    uploadedBy: 'test',
  });
  documentId = doc.documentId;
});

describe('getCategoryGroups', () => {
  it('groups uncategorised rows by what the description looks like', async () => {
    const v = await getCategoryGroups(documentId);
    expect(v.uncategorisedRows).toBe(5);
    const byCategory = new Map(v.groups.map((g) => [g.suggestedCategoryId, g]));
    expect(byCategory.get('maintenance.repair')?.rowCount).toBe(2);
    expect(byCategory.get('maintenance.tires')?.rowCount).toBe(1);
    expect(byCategory.get('maintenance.roadside')?.rowCount).toBe(1);
  });

  it('puts the unrecognised rows in their own group with no suggestion', async () => {
    const v = await getCategoryGroups(documentId);
    const none = v.groups.find((g) => g.suggestedCategoryId === null)!;
    expect(none.rowCount).toBe(1);
    expect(none.rule).toBeNull();
    expect(v.unrecognisedDescriptions).toBe(1);
  });

  it('orders by money at stake, with the unrecognised group last', async () => {
    // A wrong bulk decision on the biggest group costs the most, so it is
    // the one put in front of a person first. The unrecognised bucket is
    // last because it is not a decision — it is a list of work.
    const v = await getCategoryGroups(documentId);
    const suggested = v.groups.filter((g) => g.suggestedCategoryId !== null);
    const amounts = suggested.map((g) => Number(g.totalAmount));
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    expect(v.groups[v.groups.length - 1]!.suggestedCategoryId).toBeNull();
  });

  it('shows the longest descriptions as samples, not the tidiest', async () => {
    const v = await getCategoryGroups(documentId);
    const tires = v.groups.find((g) => g.suggestedCategoryId === 'maintenance.tires')!;
    expect(tires.sampleDescriptions[0]).toBe('tire replacement');
  });

  it('counts how many rows in each group still have no company', async () => {
    // "You categorised 267 rows and 140 still cannot post" is the thing a
    // person needs to know before they think the job is done.
    const v = await getCategoryGroups(documentId);
    for (const g of v.groups) expect(g.missingEntityCount).toBe(g.rowCount);
  });
});

describe('applyCategoryToGroup', () => {
  it('applies the category to exactly the rows it was given', async () => {
    const v = await getCategoryGroups(documentId);
    const repair = v.groups.find((g) => g.suggestedCategoryId === 'maintenance.repair')!;

    const r = await applyCategoryToGroup({
      documentId,
      categoryId: 'maintenance.repair',
      stagingRowIds: repair.stagingRowIds,
      appliedBy: 'controller@fleet',
      basis: repair.rule!,
    });
    expect(r.updated).toBe(2);
    expect(r.skippedAlreadyCategorised).toBe(0);
    // Both still lack a company, so both still cannot commit.
    expect(r.stillMissingEntity).toBe(2);

    const rows = await query<{ category_id: string; review_notes: string; reviewed_by: string }>(
      `SELECT category_id, review_notes, reviewed_by FROM accounting.staging_row
        WHERE staging_row_id = ANY($1::uuid[])`,
      [repair.stagingRowIds],
    );
    expect(rows.every((x) => x.category_id === 'maintenance.repair')).toBe(true);
    // The basis lands on every row it touched, and names who did it.
    expect(rows.every((x) => /Categorised in bulk as maintenance\.repair by controller@fleet/.test(x.review_notes))).toBe(true);
    expect(rows.every((x) => x.reviewed_by === 'controller@fleet')).toBe(true);
  });

  it('drops the applied group from the next load', async () => {
    const v = await getCategoryGroups(documentId);
    expect(v.groups.some((g) => g.suggestedCategoryId === 'maintenance.repair')).toBe(false);
    expect(v.uncategorisedRows).toBe(3);
  });

  it('never overwrites a category somebody already chose', async () => {
    // Pressing twice, or two people working the same document. The
    // response says how many were left alone rather than reporting a
    // silent success.
    const rows = await query<{ staging_row_id: string }>(
      `SELECT staging_row_id FROM accounting.staging_row
        WHERE document_id = $1 AND category_id = 'maintenance.repair'`,
      [documentId],
    );
    const r = await applyCategoryToGroup({
      documentId,
      categoryId: 'maintenance.tires',
      stagingRowIds: rows.map((x) => x.staging_row_id),
      appliedBy: 'someone-else',
      basis: 'second pass',
    });
    expect(r.updated).toBe(0);
    expect(r.skippedAlreadyCategorised).toBe(rows.length);

    const after = await query<{ category_id: string }>(
      `SELECT category_id FROM accounting.staging_row WHERE staging_row_id = ANY($1::uuid[])`,
      [rows.map((x) => x.staging_row_id)],
    );
    expect(after.every((x) => x.category_id === 'maintenance.repair')).toBe(true);
  });

  it('refuses a category the chart of accounts does not define', async () => {
    const v = await getCategoryGroups(documentId);
    const g = v.groups[0]!;
    await expect(
      applyCategoryToGroup({
        documentId,
        categoryId: 'maintenance.invented',
        stagingRowIds: g.stagingRowIds,
        appliedBy: 'test',
        basis: 'x',
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('refuses to run without a basis', async () => {
    // It is applied to many rows at once and will be read back long after
    // whoever pressed the button has forgotten why.
    const v = await getCategoryGroups(documentId);
    const g = v.groups[0]!;
    await expect(
      applyCategoryToGroup({
        documentId,
        categoryId: CATEGORY_MAINTENANCE,
        stagingRowIds: g.stagingRowIds,
        appliedBy: 'test',
        basis: '   ',
      }),
    ).rejects.toThrow(/needs a basis/);
  });

  it('refuses an empty row list and a missing name', async () => {
    await expect(
      applyCategoryToGroup({ documentId, categoryId: CATEGORY_MAINTENANCE, stagingRowIds: [], appliedBy: 'x', basis: 'y' }),
    ).rejects.toThrow(CategoriseError);
    const v = await getCategoryGroups(documentId);
    await expect(
      applyCategoryToGroup({
        documentId,
        categoryId: CATEGORY_MAINTENANCE,
        stagingRowIds: v.groups[0]!.stagingRowIds,
        appliedBy: '  ',
        basis: 'y',
      }),
    ).rejects.toThrow(/appliedBy is required/);
  });

  it('will not touch a row from another document', async () => {
    // The document id is part of the WHERE clause, not just decoration:
    // a client that mixed two documents' ids must not be able to write
    // across the boundary.
    const other = await createDocument({
      docType: 'maintenance',
      fileName: `other-${randomUUID().slice(0, 8)}.txt`,
      mimeType: 'text/plain',
      bytes: Buffer.from(expensesDoc(randomUUID().slice(0, 8)), 'utf8'),
      uploadedBy: 'test',
    });
    const otherGroups = await getCategoryGroups(other.documentId);
    const otherIds = otherGroups.groups.flatMap((g) => g.stagingRowIds);

    const r = await applyCategoryToGroup({
      documentId, // this document...
      categoryId: 'maintenance.tires',
      stagingRowIds: otherIds, // ...but the other document's rows
      appliedBy: 'test',
      basis: 'crossing documents',
    });
    expect(r.updated).toBe(0);

    const untouched = await query<{ n: string }>(
      `SELECT count(*) AS n FROM accounting.staging_row
        WHERE document_id = $1 AND category_id IS NOT NULL`,
      [other.documentId],
    );
    expect(Number(untouched[0]!.n)).toBe(0);
  });
});

describe('once a row is committed', () => {
  it('is no longer offered for categorisation', async () => {
    // A committed row is in the ledger. Re-categorising it in staging
    // would make the two disagree, which is what corrections exist for.
    const v = await getCategoryGroups(documentId);
    const g = v.groups.find((x) => x.suggestedCategoryId !== null)!;
    await query(
      `UPDATE accounting.staging_row SET entity_id = $2, accrual_date = '2026-01-15',
              category_id = $3, status = 'committed'
        WHERE staging_row_id = ANY($1::uuid[])`,
      [g.stagingRowIds, ENTITY_ZONE_ID, CATEGORY_MAINTENANCE],
    );
    const after = await getCategoryGroups(documentId);
    const ids = new Set(after.groups.flatMap((x) => x.stagingRowIds));
    for (const id of g.stagingRowIds) expect(ids.has(id)).toBe(false);
  });
});
