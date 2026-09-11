/**
 * The landing screen's live figures.
 *
 * The assertion that matters most is the empty one. An empty ledger and a
 * genuinely zero month both produce `0.00`, and they mean opposite things:
 * "nothing has arrived" versus "the fleet earned nothing". The response
 * carries an entry count so the screen can tell them apart, and a period
 * with no rows must report zero entries rather than a confident zero
 * amount.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/db/pool';
import { getDashboard } from '@/db/repo/dashboard';
import { createDocument } from '@/db/repo/documents';
import { CATEGORY_FUEL, CATEGORY_REVENUE, ENTITY_ZONE_ID, ensureBaseFixtures } from './helpers';

/** A year nothing else in the suite touches. */
const YEAR = 2097;
const WINDOW = { from: `${YEAR}-01-01`, to: `${YEAR}-12-31` };

async function post(
  accrualDate: string,
  categoryId: string,
  amount: string,
  chargedTo: 'company' | 'driver' | 'unknown',
): Promise<void> {
  const seed = `dash ${accrualDate} ${categoryId} ${amount} ${chargedTo}`;
  const doc = await createDocument({
    docType: 'fuel',
    fileName: `dash-${accrualDate}-${chargedTo}.bin`,
    mimeType: 'application/pdf',
    bytes: Buffer.from(seed, 'utf8'),
    uploadedBy: 'test',
  });
  const existing = await query(
    `SELECT 1 FROM accounting.ledger_entry WHERE source_document_id = $1`,
    [doc.documentId],
  );
  if (existing.length > 0) return;
  await query(
    `INSERT INTO accounting.ledger_entry
       (entity_id, accrual_date, category_id, amount, charged_to, source_kind, source_document_id, posted_by,
        driver_id)
     VALUES ($1, $2::date, $3, $4, $5::accounting.charged_to, 'document', $6, 'test', NULL)`,
    [ENTITY_ZONE_ID, accrualDate, categoryId, amount, chargedTo, doc.documentId],
  );
}

beforeAll(async () => {
  await ensureBaseFixtures();
  await post(`${YEAR}-03-01`, CATEGORY_REVENUE, '10000.00', 'company');
  await post(`${YEAR}-03-02`, CATEGORY_REVENUE, '5000.00', 'company');
  await post(`${YEAR}-03-05`, CATEGORY_FUEL, '-4000.00', 'company');
  // A cost nobody has assigned: excluded from company cost, and counted
  // in the work queue instead.
  await post(`${YEAR}-03-06`, CATEGORY_FUEL, '-750.00', 'unknown');
});

describe('getDashboard', () => {
  it('reads revenue and company cost off the ledger', async () => {
    const d = await getDashboard(WINDOW.from, WINDOW.to);
    expect(d.revenue).toMatchObject({ amount: '15000.00', entryCount: 2 });
    expect(d.companyCost).toMatchObject({ amount: '-4000.00', entryCount: 1 });
  });

  it('leaves an unassigned cost out of company cost entirely', async () => {
    // Not guessed onto either side. The $750 is real and is waiting on a
    // person, so it belongs in the queue, not in the margin.
    const d = await getDashboard(WINDOW.from, WINDOW.to);
    expect(d.companyCost.amount).toBe('-4000.00');
    expect(d.margin).toBe('11000.00');
  });

  it('puts the unassigned cost in the work queue, where someone can act on it', async () => {
    const d = await getDashboard(WINDOW.from, WINDOW.to);
    const item = d.workQueue.find((i) => i.id === 'chargeback-pending');
    expect(item).toBeDefined();
    expect(item!.count).toBeGreaterThanOrEqual(1);
    expect(item!.href).toBe('/chargeback');
  });

  it('sorts the queue largest first', async () => {
    const d = await getDashboard(WINDOW.from, WINDOW.to);
    const counts = d.workQueue.map((i) => i.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('never lists a queue item whose count is zero', async () => {
    // A queue that still shows work after the work is done is worse than
    // no queue: it teaches people to ignore it.
    const d = await getDashboard(WINDOW.from, WINDOW.to);
    expect(d.workQueue.every((i) => i.count > 0)).toBe(true);
  });
});

describe('an empty period', () => {
  it('still returns money in numeric(14,2) shape when there is none', async () => {
    // A bare "0" would reach the UI's money formatter and `moneyToCents`,
    // both of which expect two decimal places.
    const d = await getDashboard(`${YEAR + 1}-01-01`, `${YEAR + 1}-12-31`);
    for (const f of [d.revenue, d.companyCost, d.intercompanyReceivable, d.driverReceivable]) {
      expect(f.amount).toMatch(/^-?\d+\.\d{2}$/);
    }
    expect(d.margin).toMatch(/^-?\d+\.\d{2}$/);
  });

  it('reports zero entries rather than a confident zero amount', async () => {
    // The load-bearing distinction on this whole screen. A period with no
    // rows must be distinguishable from a period that genuinely netted to
    // nothing — the screen renders the first as "—" and the second as a
    // real figure, and it can only do that if the count comes back.
    const d = await getDashboard(`${YEAR + 1}-01-01`, `${YEAR + 1}-12-31`);
    expect(d.revenue.entryCount).toBe(0);
    expect(d.companyCost.entryCount).toBe(0);
    expect(d.isEmpty).toBe(true);
  });

  it('a period that genuinely nets to zero is NOT reported as empty', async () => {
    // Same amount, opposite meaning: here rows exist and cancel out.
    await post(`${YEAR + 2}-06-01`, CATEGORY_REVENUE, '1000.00', 'company');
    await post(`${YEAR + 2}-06-02`, CATEGORY_REVENUE, '-1000.00', 'company');
    const d = await getDashboard(`${YEAR + 2}-01-01`, `${YEAR + 2}-12-31`);
    expect(d.revenue.amount).toBe('0.00');
    expect(d.revenue.entryCount).toBe(2);
    expect(d.isEmpty).toBe(false);
  });
});
