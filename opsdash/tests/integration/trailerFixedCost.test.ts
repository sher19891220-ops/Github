/**
 * Trailer cost is fixed cost. It belongs to the carrier that bore it and to
 * no truck at all.
 *
 * Trailers are pooled: in the real expenses sheet, 47% of the trailers with
 * enough cost history to tell were pulled by trucks from more than one
 * carrier, and one by all three. A trailer cost row names whichever truck
 * happened to be pulling it, and following that number charges a tyre to
 * whoever drew that trailer that week — while the same trailer's next repair
 * lands on a different truck in a different company.
 *
 * Per-truck cost attribution is not wired for expenses yet, so today no
 * ledger entry carries a truck at all and these invariants hold trivially.
 * That is exactly why they are pinned here: when truck attribution IS wired,
 * trailer rows must not come along for the ride.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/db/pool';
import { createDocument, getDocumentRows } from '@/db/repo/documents';
import { TRAILER_FIXED_CATEGORY, getCategoryGroups } from '@/db/repo/categorise';
import { ENTITY_ZONE_ID, ensureBaseFixtures } from './helpers';
import { expensesFixture, trailerExpenseFixture } from './fixtures';

const uniq = (p: string) => `${p}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 900 + 100)}`;
/** The sheet writes a puller as bare digits ("484507 BACCUS DEVONTA"), and
 *  that is the only shape `extractIssuedToSignals` recognises — a prefixed
 *  id would make these tests pass without exercising the path at all. */
const uniqNumeric = () => `9${Date.now().toString().slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;

async function stage(body: string): Promise<string> {
  const doc = await createDocument({
    docType: 'maintenance',
    fileName: `trailer-${randomUUID()}.txt`,
    mimeType: 'text/plain',
    bytes: Buffer.from(body, 'utf8'),
    uploadedBy: 'integration-test',
  });
  return doc.documentId;
}

describe('a trailer cost never follows the truck pulling it', () => {
  beforeAll(async () => {
    await ensureBaseFixtures();
  });

  /** Puts a truck on the roster so the puller WOULD resolve, if it were used. */
  async function rosterTruck(unitNumber: string, entityId: string): Promise<void> {
    await query(`INSERT INTO accounting.truck (unit_number) VALUES ($1) ON CONFLICT DO NOTHING`, [
      unitNumber,
    ]);
    await query(
      `INSERT INTO accounting.truck_entity_history
         (truck_id, entity_id, effective_from, effective_to, basis)
       SELECT t.truck_id, $2, '2026-01-01'::date, NULL, 'test'
         FROM accounting.truck t WHERE t.unit_number = $1`,
      [unitNumber, entityId],
    );
  }

  it('does not take the carrier of the truck pulling it, even when that truck is on the roster', async () => {
    const trailer = uniq('TRL');
    const puller = uniqNumeric();
    // The puller is a Zone truck for all of 2026. If the trailer row followed
    // it, this cost would land in Zone's P&L — and the same trailer's next
    // repair, behind an Xtrack truck, would land in Xtrack's.
    await rosterTruck(puller, ENTITY_ZONE_ID);

    const docId = await stage(trailerExpenseFixture(trailer, puller, '412.35', '03.04.26'));
    const [row] = await getDocumentRows(docId);
    expect(row).toBeDefined();
    expect(row!.truckId).toBeNull();
    expect(row!.entityId).toBeNull();
    expect(row!.status).toBe('under_review');

    // The puller is still recorded, so the row can be traced back — it is
    // just never used to decide whose cost this is.
    const payload = row!.parsedPayload as Record<string, unknown>;
    expect(payload.unitType).toBe('trailer');
    expect(String(payload.issuedToRaw)).toContain(puller);
  });

  it('a TRUCK row with the same shape does take its roster carrier, so the rule is about trailers', async () => {
    // Guards against the trailer rule being implemented as "expense rows
    // never resolve an entity from a unit", which would pass the test above
    // for the wrong reason.
    const unit = uniqNumeric();
    await rosterTruck(unit, ENTITY_ZONE_ID);
    const docId = await stage(expensesFixture(unit, '250.00', 'company', '03.04.26'));
    const [row] = await getDocumentRows(docId);
    const payload = row!.parsedPayload as Record<string, unknown>;
    expect(payload.unitType).toBe('truck');
    expect(row!.entityId).toBe(ENTITY_ZONE_ID);
  });

  it('is categorised as fixed trailer cost, not as a maintenance category', async () => {
    // The description says "Tire replacement". A truck row with that text
    // would be suggested `maintenance.tires`; a trailer row must not be, or
    // per-truck cost per mile picks up shared equipment.
    const docId = await stage(trailerExpenseFixture(uniq('TRL'), uniqNumeric(), '999.00', '03.05.26'));
    const view = await getCategoryGroups(docId);
    const suggested = view.groups.map((g) => g.suggestedCategoryId);
    expect(suggested).toContain(TRAILER_FIXED_CATEGORY);
    expect(suggested).not.toContain('maintenance.tires');
  });

  it('takes its carrier from what the sheet says bore the cost', async () => {
    // "Xtrack exp" in the Expense side column states both that a company
    // bears this and which company — the only entity signal used, since the
    // driver and the puller are both off-limits.
    const docId = await stage(
      trailerExpenseFixture(uniq('TRL'), uniqNumeric(), '150.00', '03.06.26', 'Xtrack exp'),
    );
    const [row] = await getDocumentRows(docId);
    const payload = row!.parsedPayload as Record<string, unknown>;
    expect(payload.chargedTo).toBe('company');
    expect(payload.expenseBearerRaw).toBe('xtrack');
    expect(payload.entityHint).toBe('xtrack');
  });

  it('holds a trailer cost with no company on the row rather than guessing one', async () => {
    const docId = await stage(trailerExpenseFixture(uniq('TRL'), uniqNumeric(), '77.00', '03.07.26'));
    const [row] = await getDocumentRows(docId);
    expect(row!.entityId).toBeNull();
    expect(row!.status).toBe('under_review');
    expect(row!.reviewNotes).toMatch(/never attributed through the truck pulling it/);
  });

  it('keeps the fixed cost in the carrier that bore it — it is not an intercompany leg', async () => {
    // The decision on record: trailer upkeep sits in each carrier's own P&L,
    // rather than rolling to the asset-holding company and returning as rent.
    const cat = await query<{ grp: string }>(
      `SELECT category_group grp FROM accounting.category WHERE category_id = $1`,
      [TRAILER_FIXED_CATEGORY],
    );
    expect(cat[0]?.grp).toBe('trailer');
    // Not one of the intercompany categories, which are what the group
    // roll-up eliminates.
    expect(TRAILER_FIXED_CATEGORY).not.toMatch(/receivable|payable/);
    expect(ENTITY_ZONE_ID).toBeTruthy();
  });
});
