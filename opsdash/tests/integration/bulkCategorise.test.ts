/**
 * Running the categorisation rules over a whole document.
 *
 * The rules and the screen existed; nothing ran them over the backlog. On
 * the real expenses sheet that left 1,769 rows uncategorised and every
 * carrier's maintenance cost at zero.
 *
 * The two properties worth protecting are both refusals: it must never
 * invent a category for a line no rule recognised, and it must not make
 * anything postable behind a person's back.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query } from '@/db/pool';
import { applyPlan, planDocument } from '@/db/repo/bulkCategorise';
import { commitDocument } from '@/db/repo/commit';
import { ENTITY_ZONE_ID, ensureBaseFixtures } from './helpers';

beforeAll(async () => {
  await ensureBaseFixtures();
});

async function docWith(rows: Array<{ text: string; amount: string; entity?: boolean; unitType?: string }>): Promise<string> {
  const doc = await query<{ document_id: string }>(
    `INSERT INTO accounting.source_document
       (doc_type, file_name, mime_type, byte_size, sha256, storage_key, uploaded_by)
     VALUES ('maintenance','expenses.txt','text/plain',1,$1,$2,'test')
     RETURNING document_id`,
    [randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), `${randomUUID()}.bin`],
  );
  const id = doc[0]!.document_id;
  let i = 0;
  for (const r of rows) {
    await query(
      `INSERT INTO accounting.staging_row
         (document_id, row_index, parsed_payload, amount, accrual_date, entity_id, status)
       VALUES ($1,$2,$3::jsonb,$4,'2026-04-06',$5,'parsed')`,
      [id, i++, JSON.stringify({ categoryText: r.text, unitType: r.unitType ?? 'truck' }),
       r.amount, r.entity === false ? null : ENTITY_ZONE_ID],
    );
  }
  return id;
}

describe('what the rules claim', () => {
  it('groups rows by the rule that fired, and says which rule', async () => {
    const id = await docWith([
      { text: 'shop repair to engine', amount: '-500.00' },
      { text: 'new tires fitted', amount: '-300.00' },
    ]);
    const plan = await planDocument(id);
    const byCategory = Object.fromEntries(plan.recognised.map((g) => [g.suggestedCategoryId, g]));
    expect(byCategory['maintenance.repair']!.rowCount).toBe(1);
    expect(byCategory['maintenance.tires']!.rowCount).toBe(1);
    expect(byCategory['maintenance.tires']!.rule).toMatch(/tires/);
  });

  it('orders groups by how much is at stake', async () => {
    const id = await docWith([
      { text: 'new tires', amount: '-100.00' },
      { text: 'shop repair', amount: '-900.00' },
    ]);
    const plan = await planDocument(id);
    expect(plan.recognised[0]!.suggestedCategoryId).toBe('maintenance.repair');
  });

  it('counts the rows that will still be stuck for want of a company', async () => {
    // "You categorised 267 rows and 140 still cannot post" is the thing a
    // person needs to know before they think the job is done.
    const id = await docWith([
      { text: 'shop repair', amount: '-500.00', entity: true },
      { text: 'shop repair', amount: '-500.00', entity: false },
    ]);
    const plan = await planDocument(id);
    expect(plan.recognised[0]!.missingEntityCount).toBe(1);
  });
});

describe('what it refuses to categorise', () => {
  it('keeps unrecognised lines in their own group, with no category', async () => {
    const id = await docWith([
      { text: 'shop repair', amount: '-500.00' },
      { text: 'composite headlamp assembly, fender', amount: '-220.00' },
    ]);
    const plan = await planDocument(id);
    expect(plan.unrecognised).not.toBeNull();
    expect(plan.unrecognised!.suggestedCategoryId).toBeNull();
    expect(plan.unrecognised!.rowCount).toBe(1);
  });

  it('leaves them uncategorised after applying', async () => {
    // No fallback category. maintenance.repair would quietly absorb
    // everything nobody thought about, and a chart of accounts that absorbs
    // everything means nothing.
    const id = await docWith([
      { text: 'shop repair', amount: '-500.00' },
      { text: 'composite headlamp assembly, fender', amount: '-220.00' },
    ]);
    await applyPlan(await planDocument(id), 'test');
    const left = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounting.staging_row
        WHERE document_id = $1 AND category_id IS NULL`,
      [id],
    );
    expect(Number(left[0]!.n)).toBe(1);
  });

  it('files a trailer line as fixed cost whatever its words say', async () => {
    // Reading the description would put a trailer tyre under
    // maintenance.tires beside truck tyres, and per-truck cost per mile
    // would then carry a share of equipment three companies took turns
    // pulling.
    const id = await docWith([{ text: 'new tires fitted', amount: '-300.00', unitType: 'trailer' }]);
    const plan = await planDocument(id);
    expect(plan.recognised[0]!.suggestedCategoryId).toBe('trailer.fixed');
  });
});

describe('applying', () => {
  it('writes the rule onto every row it touches', async () => {
    const id = await docWith([{ text: 'shop repair', amount: '-500.00' }]);
    await applyPlan(await planDocument(id), 'a.person');
    const rows = await query<{ review_notes: string }>(
      `SELECT review_notes FROM accounting.staging_row WHERE document_id = $1`, [id]);
    expect(rows[0]!.review_notes).toMatch(/a\.person/);
    expect(rows[0]!.review_notes).toMatch(/shop repair work/);
  });


  it('reports how many it categorised that still cannot post', async () => {
    // The summary has to carry this too, not just the plan: the run prints
    // from the summary, and a caller that trusted it would report the job
    // finished when most of it cannot post.
    const id = await docWith([
      { text: 'shop repair', amount: '-500.00', entity: true },
      { text: 'shop repair', amount: '-400.00', entity: false },
      { text: 'new tires', amount: '-100.00', entity: false },
    ]);
    const summary = await applyPlan(await planDocument(id), 'test');
    expect(summary.applied).toBe(3);
    expect(summary.stillMissingEntity).toBe(2);
  });

  it('is a no-op the second time', async () => {
    const id = await docWith([{ text: 'shop repair', amount: '-500.00' }]);
    expect((await applyPlan(await planDocument(id), 'test')).applied).toBe(1);
    expect((await applyPlan(await planDocument(id), 'test')).applied).toBe(0);
  });

  it('does NOT make a row postable — it goes back to a person', async () => {
    // The point of the whole gate. A category applied by machine is still a
    // machine's opinion; commitDocument posts only rows a human cleared.
    const id = await docWith([{ text: 'shop repair', amount: '-500.00' }]);
    await applyPlan(await planDocument(id), 'test');
    const result = await commitDocument(id, 'test');
    expect(result.committed).toBe(0);
    expect(result.held).toBe(1);
  });
});
