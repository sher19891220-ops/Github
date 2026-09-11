/**
 * Reconciliation against a real Postgres.
 *
 * The unit tests prove the pairing rule. These prove the things only a real
 * database can be wrong about: that opening is idempotent, that a committed
 * document does not reconcile perfectly against itself, that a decision
 * survives a reload, and that rejecting a pairing actually frees both lines
 * instead of stranding them behind migration 006's uniqueness.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createDocument, getDocumentRows } from '@/db/repo/documents';
import { commitDocument } from '@/db/repo/commit';
import { updateStagingRow } from '@/db/repo/stagingRows';
import { getReconciliation, recordReconDecision } from '@/db/repo/reconciliation';
import { CATEGORY_MAINTENANCE, ENTITY_ZONE_ID, ensureBaseFixtures } from './helpers';
import { expensesFixture } from './fixtures';

beforeAll(async () => {
  await ensureBaseFixtures();
});

/** Uploads one expense row and, optionally, posts it to the ledger. */
async function dropExpense(
  unit: string,
  amount: string,
  dateMmDdYy: string,
  commit: boolean,
): Promise<string> {
  const created = await createDocument({
    docType: 'maintenance',
    fileName: `recon-${unit}-${amount}.txt`,
    mimeType: 'text/plain',
    bytes: Buffer.from(expensesFixture(unit, amount, 'company', dateMmDdYy), 'utf8'),
    uploadedBy: 'integration-test',
  });

  // The parser reads the unit, date, amount and expense side off the row;
  // entity and category are the review screen's job, so the test does what
  // a person would do before anything posts.
  const [row] = await getDocumentRows(created.documentId);
  const edit = await updateStagingRow(row!.stagingRowId, {
    entityId: ENTITY_ZONE_ID,
    categoryId: CATEGORY_MAINTENANCE,
  });
  if (!edit.ok) throw new Error(`setup failed: ${JSON.stringify(edit)}`);

  if (commit) {
    const result = await commitDocument(created.documentId, 'tester');
    if (result.committed !== 1) {
      throw new Error(`setup failed: expected one posting, got ${JSON.stringify(result)}`);
    }
  }
  return created.documentId;
}

function unitTag(): string {
  return `R${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 900 + 100)}`;
}

describe('reconciliation against a real database', () => {
  it('auto-matches a document line that is already on the books, exactly', async () => {
    const unit = unitTag();
    await dropExpense(unit, '812.44', '03.04.26', true);
    const statementId = await dropExpense(unit, '812.44', '03.04.26', false);

    const result = await getReconciliation(statementId, 'tester');
    expect(result).not.toBeNull();

    const paired = result!.set.matches.filter(
      (m) => m.documentLine !== null && m.ledgerLine !== null,
    );
    expect(paired.length).toBeGreaterThanOrEqual(1);
    const ours = paired.find((m) => m.documentLine?.sourceRef.label.includes(unit));
    expect(ours).toBeDefined();
    expect(ours!.status).toBe('auto_matched');
    expect(ours!.amountVariance).toBe('0.00');
  });

  it('renders a same-unit, same-day amount difference as the case needing a person', async () => {
    const unit = unitTag();
    await dropExpense(unit, '800.00', '03.05.26', true);
    const statementId = await dropExpense(unit, '812.44', '03.05.26', false);

    const result = await getReconciliation(statementId, 'tester');
    const ours = result!.set.matches.find(
      (m) => m.documentLine?.sourceRef.label.includes(unit) && m.ledgerLine !== null,
    );
    expect(ours).toBeDefined();
    // 'near_match' is derived from a stored 'auto_matched' plus a non-zero
    // variance — the database has no such enum value and does not need one.
    expect(ours!.status).toBe('near_match');
    expect(ours!.amountVariance).toBe('-12.44');
    expect(result!.summary.nearMatch).toBeGreaterThanOrEqual(1);
  });

  it('does not let a committed document reconcile perfectly against itself', async () => {
    const unit = unitTag();
    const documentId = await dropExpense(unit, '999.99', '03.06.26', true);

    const result = await getReconciliation(documentId, 'tester');
    const ours = result!.set.matches.find((m) => m.documentLine?.sourceRef.label.includes(unit));
    expect(ours).toBeDefined();
    // Its own posting is excluded, so the line stands unmatched rather than
    // pairing with the entry it created — the most convincing wrong answer
    // this screen could give.
    expect(ours!.ledgerLine).toBeNull();
    expect(ours!.status).toBe('unmatched');
  });

  it('opens exactly one run however many times the screen is loaded', async () => {
    const unit = unitTag();
    const statementId = await dropExpense(unit, '123.45', '03.07.26', false);

    const first = await getReconciliation(statementId, 'a@fleet');
    const second = await getReconciliation(statementId, 'b@fleet');
    const third = await getReconciliation(statementId, 'c@fleet');

    expect(second!.set.reconciliationId).toBe(first!.set.reconciliationId);
    expect(third!.set.reconciliationId).toBe(first!.set.reconciliationId);
    // And no duplicate match rows accumulated across the three reads.
    expect(second!.set.matches).toHaveLength(first!.set.matches.length);
    expect(third!.set.matches).toHaveLength(first!.set.matches.length);
  });

  it('keeps a confirmation across a reload, attributed to whoever made it', async () => {
    const unit = unitTag();
    await dropExpense(unit, '250.00', '03.08.26', true);
    const statementId = await dropExpense(unit, '250.00', '03.08.26', false);

    const before = await getReconciliation(statementId, 'tester');
    const target = before!.set.matches.find(
      (m) => m.documentLine?.sourceRef.label.includes(unit) && m.ledgerLine !== null,
    )!;

    await recordReconDecision(statementId, target.matchId, { type: 'confirm' }, 'controller@fleet');

    const after = await getReconciliation(statementId, 'tester');
    const reloaded = after!.set.matches.find((m) => m.matchId === target.matchId)!;
    expect(reloaded.status).toBe('confirmed');
    expect(reloaded.decidedBy).toBe('controller@fleet');
    expect(reloaded.decidedAt).not.toBeNull();
  });

  it('frees both lines when a pairing is rejected, keeping the rejection on file', async () => {
    const unit = unitTag();
    await dropExpense(unit, '640.00', '03.09.26', true);
    const statementId = await dropExpense(unit, '640.00', '03.09.26', false);

    const before = await getReconciliation(statementId, 'tester');
    const target = before!.set.matches.find(
      (m) => m.documentLine?.sourceRef.label.includes(unit) && m.ledgerLine !== null,
    )!;
    const documentLineId = target.documentLine!.lineId;
    const ledgerLineId = target.ledgerLine!.lineId;

    const after = await recordReconDecision(
      statementId,
      target.matchId,
      { type: 'reject' },
      'controller@fleet',
    );

    // The rejection itself stays: who broke the pairing apart, and when.
    const rejected = after.set.matches.find((m) => m.matchId === target.matchId)!;
    expect(rejected.status).toBe('rejected');
    expect(rejected.decidedBy).toBe('controller@fleet');

    // And both lines are standing alone again, each able to carry its own
    // later decision rather than being stranded behind the old pairing.
    const freedDocument = after.set.matches.find(
      (m) => m.status === 'unmatched' && m.documentLine?.lineId === documentLineId,
    );
    const freedLedger = after.set.matches.find(
      (m) => m.status === 'unmatched' && m.ledgerLine?.lineId === ledgerLineId,
    );
    expect(freedDocument).toBeDefined();
    expect(freedLedger).toBeDefined();
  });

  it('refuses to mark a line expected-missing without a reason', async () => {
    const unit = unitTag();
    const statementId = await dropExpense(unit, '77.00', '03.10.26', false);
    const before = await getReconciliation(statementId, 'tester');
    const lonely = before!.set.matches.find(
      (m) => m.documentLine?.sourceRef.label.includes(unit) && m.ledgerLine === null,
    )!;

    await expect(
      recordReconDecision(
        statementId,
        lonely.matchId,
        { type: 'expected_missing', note: '' },
        'controller@fleet',
      ),
    ).rejects.toThrow();

    const withReason = await recordReconDecision(
      statementId,
      lonely.matchId,
      { type: 'expected_missing', note: 'billed direct, never sent to the factor' },
      'controller@fleet',
    );
    const settled = withReason.set.matches.find((m) => m.matchId === lonely.matchId)!;
    expect(settled.status).toBe('expected_missing');
    expect(settled.note).toContain('billed direct');
    // A settled line stops counting toward what is still unexplained.
    expect(
      withReason.set.matches.filter((m) => m.matchId === lonely.matchId && m.status === 'unmatched'),
    ).toHaveLength(0);
  });

  it('returns null for a document that does not exist', async () => {
    expect(await getReconciliation('00000000-0000-4000-8000-0000000000ff')).toBeNull();
  });
});
