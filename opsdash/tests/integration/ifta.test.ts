/**
 * The IFTA return, end to end against a real Postgres: a mileage report
 * dropped as a document, fuel posted in the ledger, rates typed in, a
 * return computed and saved.
 *
 * Every assertion here is about a refusal holding when it is inconvenient
 * rather than in a unit test's controlled inputs. The four that matter:
 *
 *  - a report that only partially overlaps the requested period is
 *    excluded and named, never apportioned;
 *  - a jurisdiction with no rate is withheld from the total, and that
 *    withholding blocks the save;
 *  - an accrual computes and cannot be saved as a return;
 *  - fuel with no purchase state is counted as missing rather than
 *    quietly treated as zero gallons bought there.
 *
 * Periods are unique per run so this file does not read another test's
 * mileage documents — the IFTA repo deliberately reads every mileage
 * document in the system and filters by period, which is correct in
 * production and requires isolation here.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/db/pool';
import { createDocument } from '@/db/repo/documents';
import {
  getIftaReturn,
  IftaRequestError,
  listSavedReturns,
  saveIftaReturn,
  upsertRate,
} from '@/db/repo/ifta';
import { commitDocument, NonPostingDocumentError } from '@/db/repo/commit';
import { CATEGORY_FUEL, ENTITY_ZONE_ID, ensureBaseFixtures } from './helpers';

/** Far enough out that no other test's data lands in it. */
const YEAR = 2091;
const Q2 = { from: `${YEAR}-04-01`, to: `${YEAR}-06-30` };
/** A second, identically-shaped quarter where every jurisdiction HAS a
 *  rate. Kept separate from Q2 so that quarter stays permanently short of
 *  a KY rate and the withholding assertions hold on every run — a test
 *  that passes only the first time is not a test. */
const Q3 = { from: `${YEAR}-07-01`, to: `${YEAR}-09-30` };

/** The carrier line must start with the entity's legal name for the repo
 *  to attribute the report — exactly as the real telematics prints it,
 *  legal name then street address. */
const CARRIER = 'Zone OH LLC (test fixture) 100 Example Road Springfield IL 60000';

/**
 * Content-stable: the same period always produces the same bytes, so
 * re-running this file finds the existing document by sha256 rather than
 * uploading a second copy. That is not only test hygiene — two reports
 * covering one period and one state are summed, and the repo now says so.
 */
function report(periodStart: string, periodEnd: string): string {
  return `${CARRIER}

IFTA by Vehicles: 2

${periodStart} - ${periodEnd}

Vehicle: 9001 (1ZZZZZZZZZZZZZZZ1)

Seq State Miles

1 OH 6,000.00

2 IN 4,000.00

Total 10,000.00

Vehicle: 9002 (1ZZZZZZZZZZZZZZZ2)

Seq State Miles

1 KY 5,000.00

Total 5,000.00

Total Distance by State

Seq State Miles

1 OH 6,000.00

2 IN 4,000.00

3 KY 5,000.00

Total 15,000.00
`;
}

async function uploadReport(periodStart: string, periodEnd: string): Promise<string> {
  const r = await createDocument({
    docType: 'ifta_mileage',
    fileName: `ifta-${periodStart}.txt`,
    mimeType: 'text/plain',
    bytes: Buffer.from(report(periodStart, periodEnd), 'utf8'),
    uploadedBy: 'safety@fleet',
  });
  return r.documentId;
}

/** Fuel is money and is already in the ledger, so it goes in as a posted
 *  entry with gallons and a purchase state — the two columns migration 001
 *  put there for this engine before it existed. */
async function postFuel(
  accrualDate: string,
  jurisdiction: string | null,
  gallons: string | null,
  amount: string,
): Promise<void> {
  // Content-stable for the same reason the reports are: the ledger is
  // append-only, so a second run must not post a second purchase.
  const seed = `ifta-test-fuel ${accrualDate} ${jurisdiction ?? 'none'}`;
  const docId = (
    await createDocument({
      docType: 'fuel',
      fileName: `fuel-${accrualDate}-${jurisdiction ?? 'none'}.bin`,
      mimeType: 'application/pdf', // binary branch: no parse, just a provenance anchor
      bytes: Buffer.from(seed, 'utf8'),
      uploadedBy: 'accounting@fleet',
    })
  ).documentId;

  const existing = await query(
    `SELECT 1 FROM accounting.ledger_entry WHERE source_document_id = $1`,
    [docId],
  );
  if (existing.length > 0) return;

  await query(
    `INSERT INTO accounting.ledger_entry
       (entity_id, accrual_date, category_id, amount, quantity, jurisdiction,
        source_kind, source_document_id, posted_by)
     VALUES ($1, $2::date, $3, $4, $5, $6, 'document', $7, 'test')`,
    [ENTITY_ZONE_ID, accrualDate, CATEGORY_FUEL, amount, gallons, jurisdiction, docId],
  );
}

beforeAll(async () => {
  await ensureBaseFixtures();

  await uploadReport(Q2.from, Q2.to);
  await uploadReport(Q3.from, Q3.to);

  // 3,000 gallons against 15,000 miles = a fleet MPG of exactly 5.00.
  await postFuel(`${YEAR}-04-15`, 'OH', '2000.0000', '-6000.00');
  await postFuel(`${YEAR}-05-15`, 'IN', '1000.0000', '-3000.00');
  // A purchase nobody coded to a state. It must be counted as missing,
  // not treated as zero gallons bought anywhere.
  await postFuel(`${YEAR}-06-15`, null, null, '-450.00');

  await postFuel(`${YEAR}-07-15`, 'OH', '2000.0000', '-6000.00');
  await postFuel(`${YEAR}-08-15`, 'IN', '1000.0000', '-3000.00');

  await upsertRate({
    jurisdiction: 'OH',
    year: YEAR,
    quarter: 2,
    ratePerGallon: '0.38500',
    sourceNote: 'IFTA Inc. rate matrix (test)',
    enteredBy: 'test',
  });
  await upsertRate({
    jurisdiction: 'IN',
    year: YEAR,
    quarter: 2,
    ratePerGallon: '0.34000',
    surchargePerGallon: '0.55000',
    sourceNote: 'IFTA Inc. rate matrix (test)',
    enteredBy: 'test',
  });
  // KY is deliberately left with no rate on file for Q2, permanently.

  for (const jurisdiction of ['OH', 'IN', 'KY'] as const) {
    await upsertRate({
      jurisdiction,
      year: YEAR,
      quarter: 3,
      ratePerGallon: jurisdiction === 'OH' ? '0.38500' : jurisdiction === 'IN' ? '0.34000' : '0.28700',
      surchargePerGallon: jurisdiction === 'IN' ? '0.55000' : jurisdiction === 'KY' ? '0.11700' : undefined,
      sourceNote: 'IFTA Inc. rate matrix (test)',
      enteredBy: 'test',
    });
  }
});

describe('getIftaReturn', () => {
  it('computes a fleet-wide MPG from every state, not per state', async () => {
    const v = await getIftaReturn({ ...Q2, entityId: ENTITY_ZONE_ID });

    expect(v.blocked).toBeNull();
    expect(v.result!.totalMiles).toBe('15000.00');
    expect(v.result!.totalGallonsPurchased).toBe('3000.0000');
    // 15000 / 3000. Per-state MPG would give OH 3.00 and IN 4.00 — a
    // different return, wrong in every line.
    expect(v.result!.fleetMpg).toBe('5.00');
    expect(v.periodKind).toBe('quarter');
  });

  it('never nets the surcharge', async () => {
    const v = await getIftaReturn({ ...Q2, entityId: ENTITY_ZONE_ID });
    const indiana = v.result!.lines.find((l) => l.jurisdiction === 'IN')!;

    // 4000 miles / 5 MPG = 800 taxable gallons, 1000 bought there.
    expect(indiana.taxableGallons).toBe('800.0000');
    expect(indiana.netTaxableGallons).toBe('-200.0000');
    // Base tax IS netted: a credit.
    expect(indiana.taxDue).toBe('-68.00');
    // The surcharge is on taxable gallons, with no pump credit: 800 x 0.55.
    // Netting it would give -110.00 — a $550 swing on one state.
    expect(indiana.surchargeDue).toBe('440.00');
    expect(indiana.totalDue).toBe('372.00');
  });

  it('withholds a jurisdiction with no rate rather than taxing it at zero', async () => {
    const v = await getIftaReturn({ ...Q2, entityId: ENTITY_ZONE_ID });

    expect(v.result!.lines.map((l) => l.jurisdiction)).toEqual(['IN', 'OH']);
    expect(v.result!.problems.some((p) => /^KY: no tax rate on file/.test(p))).toBe(true);
    // 5,000 KY miles are named in the problem, so the gap has a size.
    expect(v.result!.problems.some((p) => p.includes('5000.00 taxable miles'))).toBe(true);
  });

  it('counts fuel that cannot earn a credit instead of dropping it', async () => {
    const v = await getIftaReturn({ ...Q2, entityId: ENTITY_ZONE_ID });

    expect(v.sources.fuelEntriesUnusable).toBe(1);
    expect(v.sources.unusableFuelAmount).toBe('450.00');
    // Singular wording for a single purchase: "1 fuel purchases ... carry"
    // is the kind of slip that makes a careful reader doubt the number.
    expect(
      v.sourceProblems.some(
        (p) => /^1 fuel purchase /.test(p) && /it earns no tax-paid credit/.test(p) && /too high, not too low/.test(p),
      ),
    ).toBe(true);
  });

  it('names the mileage report the figure came from', async () => {
    const v = await getIftaReturn({ ...Q2, entityId: ENTITY_ZONE_ID });
    const included = v.sources.mileageDocuments.filter((d) => d.excludedReason === null);
    expect(included).toHaveLength(1);
    expect(included[0]!.rowCount).toBe(3);
    expect(included[0]!.entityId).toBe(ENTITY_ZONE_ID);
  });

  it('refuses a period that spans two quarters, because the rates differ', async () => {
    await expect(
      getIftaReturn({ from: `${YEAR}-03-01`, to: `${YEAR}-05-31`, entityId: ENTITY_ZONE_ID }),
    ).rejects.toThrow(/spanning two of them has no single rate/);
  });

  it('computes a week, and calls it an accrual', async () => {
    const v = await getIftaReturn({
      from: `${YEAR}-04-06`,
      to: `${YEAR}-04-12`,
      entityId: ENTITY_ZONE_ID,
    });

    expect(v.periodKind).toBe('accrual');
    // The quarterly report cannot be split into a week, so that week has
    // no miles — and the honest output is a refusal, not an apportioned
    // fifth of a quarter.
    expect(v.result).toBeNull();
    expect(v.blocked).toMatch(/No fuel purchases|No miles/);
    expect(
      v.sourceProblems.some((p) => /not entirely inside the requested period/.test(p)),
    ).toBe(true);
  });
});

describe('a report that only half-covers the period', () => {
  it('is excluded and named, never apportioned', async () => {
    // Straddles the Q3/Q4 boundary of a year nothing else uses.
    await uploadReport(`${YEAR + 1}-08-01`, `${YEAR + 1}-10-31`);
    const v = await getIftaReturn({ from: `${YEAR + 1}-10-01`, to: `${YEAR + 1}-12-31` });

    const doc = v.sources.mileageDocuments.find((d) => d.periodStart === `${YEAR + 1}-08-01`);
    expect(doc?.excludedReason).toMatch(/not entirely inside the requested period/);
    expect(doc?.excludedReason).toMatch(/no miles per day/);
  });
});

describe('saveIftaReturn', () => {
  it('refuses a return that is knowably short a jurisdiction', async () => {
    const v = await getIftaReturn({ ...Q2, entityId: ENTITY_ZONE_ID });
    await expect(saveIftaReturn(v, 'controller@fleet')).rejects.toThrow(/knowably short/);
  });

  it('refuses an accrual, and refuses a group-wide figure', async () => {
    const group = await getIftaReturn(Q2);
    await expect(saveIftaReturn(group, 'controller@fleet')).rejects.toThrow(IftaRequestError);
  });

  it('saves once every jurisdiction has a rate, keeping the surcharge apart', async () => {
    const v = await getIftaReturn({ ...Q3, entityId: ENTITY_ZONE_ID });
    expect(v.result!.lines).toHaveLength(3);

    const saved = await saveIftaReturn(v, 'controller@fleet');
    expect(saved.lineCount).toBe(3);

    const stored = await query<{
      jurisdiction: string;
      tax_due: string;
      surcharge_due: string;
      net_liability: string;
      fleet_mpg: string;
    }>(
      `SELECT jurisdiction, tax_due, surcharge_due, net_liability, fleet_mpg
         FROM accounting.ifta_liability WHERE calc_run_id = $1 ORDER BY jurisdiction`,
      [saved.calcRunId],
    );
    expect(stored.map((r) => r.jurisdiction)).toEqual(['IN', 'KY', 'OH']);

    const indiana = stored[0]!;
    expect(indiana.tax_due).toBe('-68.00');
    expect(indiana.surcharge_due).toBe('440.00');
    expect(indiana.net_liability).toBe('372.00');
    expect(Number(indiana.fleet_mpg)).toBe(5);

    // KY: 5000 miles / 5 MPG = 1000 taxable gallons, none bought there.
    // The surcharge is on all 1000, never netted.
    expect(stored[1]!.surcharge_due).toBe('117.00');

    // The saved return names the document it read.
    const sources = await query<{ document_id: string }>(
      `SELECT document_id FROM accounting.ifta_run_source WHERE calc_run_id = $1 AND role = 'mileage'`,
      [saved.calcRunId],
    );
    expect(sources).toHaveLength(1);

    const listed = await listSavedReturns(50);
    expect(listed.some((r) => r.calcRunId === saved.calcRunId && r.lineCount === 3)).toBe(true);
  });
});

describe('a mileage document is not a ledger document', () => {
  it('refuses to commit rather than rejecting every row for a missing amount', async () => {
    const documentId = await uploadReport(`${YEAR + 2}-01-01`, `${YEAR + 2}-03-31`);

    await expect(commitDocument(documentId, 'test')).rejects.toThrow(NonPostingDocumentError);

    // The rows survive, unflagged, so the IFTA read still sees them. A
    // rejection here would have read as "this report was bad" when the
    // report was fine and the destination was wrong.
    const rows = await query<{ status: string }>(
      `SELECT status FROM accounting.staging_row WHERE document_id = $1`,
      [documentId],
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'parsed')).toBe(true);
  });
});

describe('upsertRate', () => {
  it('requires a source note, because nothing else supplies a rate', async () => {
    await expect(
      upsertRate({
        jurisdiction: 'PA',
        year: YEAR,
        quarter: 2,
        ratePerGallon: '0.74100',
        sourceNote: '   ',
        enteredBy: 'test',
      }),
    ).rejects.toThrow(/source note/);
  });

  it('treats a re-post as a correction, not a second rate', async () => {
    const base = {
      jurisdiction: 'PA',
      year: YEAR,
      quarter: 3,
      sourceNote: 'IFTA Inc. rate matrix (test)',
      enteredBy: 'test',
    };
    await upsertRate({ ...base, ratePerGallon: '0.74100' });
    await upsertRate({ ...base, ratePerGallon: '0.75200', enteredBy: 'controller@fleet' });

    const rows = await query<{ rate_per_gallon: string; entered_by: string }>(
      `SELECT rate_per_gallon, entered_by FROM accounting.ifta_rate
        WHERE jurisdiction = 'PA' AND period_year = $1 AND period_quarter = 3`,
      [YEAR],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rate_per_gallon).toBe('0.75200');
    expect(rows[0]!.entered_by).toBe('controller@fleet');
  });
});
