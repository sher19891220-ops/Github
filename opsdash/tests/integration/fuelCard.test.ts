/**
 * A fuel-card statement, from upload to an IFTA return.
 *
 * The unit tests prove the parser reads a statement. This proves the whole
 * path closes: dropped as a document, staged, committed to the ledger with
 * gallons and a purchase state, and then picked up by `getIftaReturn` as
 * tax-paid gallons — which is the entire reason card statements are
 * ingested. `docs/SOURCE-DISCOVERY.md` §3 measured the Fuel *sheet* at
 * 97.5% unusable for gallons; this is the source that replaces it.
 *
 * The assertion that matters most is the DEF one. Its gallons must not
 * arrive at the engine, and the only way to be sure is to read what the
 * engine actually got.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/db/pool';
import { createDocument, getDocumentRows } from '@/db/repo/documents';
import { commitDocument } from '@/db/repo/commit';
import { getIftaReturn, upsertRate } from '@/db/repo/ifta';
import { CATEGORY_FUEL, ENTITY_ZONE_ID, ensureBaseFixtures } from './helpers';

/** A year nothing else in the suite uses, so this file reads only its own
 *  fuel. Content-stable, so a second run finds the same document by sha256
 *  rather than posting the purchases twice into an append-only ledger. */
const YEAR = 2094;

const STATEMENT = `EFS LLC
Account 00000000
Billing period 01/01/${YEAR} - 03/31/${YEAR}

Tran Date,Invoice,Unit,Location Name,State,Product,Qty,Unit Price,Net Amount
01/15/${YEAR},INV-A,9001,PILOT COLUMBUS,OH,ULSD,2000.00,3.799,7598.00
02/15/${YEAR},INV-B,9001,LOVES FISHKILL,IN,ULSD,1000.00,3.599,3599.00
02/16/${YEAR},INV-C,9001,LOVES FISHKILL,IN,DEF BULK,500.00,4.100,2050.00
03/01/${YEAR},INV-D,9002,TA BROOKVILLE,OH,CASH ADVANCE,,,200.00
GRAND TOTAL,,,,,,,,13447.00
`;

/** Fuel alone is not an IFTA return — the engine refuses without miles,
 *  which is its own tested behaviour. A minimal mileage report for the
 *  same quarter lets this file assert on what the engine actually
 *  received, which is the only place the DEF rule can really be checked. */
const MILEAGE = `Test Fixture Carrier One 100 Example Road Springfield IL 60000

IFTA by Vehicles: 1

${YEAR}-01-01 - ${YEAR}-03-31

Vehicle: 9001 (1ZZZZZZZZZZZZZZZ9)

Seq State Miles

1 OH 9,000.00

2 IN 6,000.00

Total 15,000.00

Total Distance by State

Seq State Miles

1 OH 9,000.00

2 IN 6,000.00

Total 15,000.00
`;

let documentId = '';

beforeAll(async () => {
  await ensureBaseFixtures();

  await createDocument({
    docType: 'ifta_mileage',
    fileName: `ifta-${YEAR}-Q1.txt`,
    mimeType: 'text/plain',
    bytes: Buffer.from(MILEAGE, 'utf8'),
    uploadedBy: 'safety@fleet',
  });

  const doc = await createDocument({
    docType: 'fuel_card',
    fileName: `efs-${YEAR}-Q1.csv`,
    mimeType: 'text/csv',
    bytes: Buffer.from(STATEMENT, 'utf8'),
    uploadedBy: 'accounting@fleet',
  });
  documentId = doc.documentId;

  // The review step, standing in for a person: a statement names a unit
  // and a vendor, not an entity, so the entity is assigned before commit.
  await query(
    `UPDATE accounting.staging_row SET entity_id = $2
      WHERE document_id = $1 AND category_id IS NOT NULL`,
    [documentId, ENTITY_ZONE_ID],
  );
  await commitDocument(documentId, 'controller@fleet');

  await upsertRate({
    jurisdiction: 'OH', year: YEAR, quarter: 1, ratePerGallon: '0.38500',
    sourceNote: 'IFTA Inc. rate matrix (test)', enteredBy: 'test',
  });
  await upsertRate({
    jurisdiction: 'IN', year: YEAR, quarter: 1, ratePerGallon: '0.34000',
    surchargePerGallon: '0.55000', sourceNote: 'IFTA Inc. rate matrix (test)', enteredBy: 'test',
  });
});

describe('a dropped statement', () => {
  it('parses on upload without anyone running a parser by hand', async () => {
    const rows = await query<{ parse_status: string; parse_error: string | null }>(
      `SELECT parse_status, parse_error FROM accounting.source_document WHERE document_id = $1`,
      [documentId],
    );
    expect(rows[0]!.parse_status).toBe('parsed');
    expect(rows[0]!.parse_error).toBeNull();
  });

  it('stages four transactions and not the totals line', async () => {
    const rows = await getDocumentRows(documentId);
    expect(rows).toHaveLength(4);
  });

  it('carries gallons and a purchase state only on the diesel rows', async () => {
    const rows = await getDocumentRows(documentId);
    const withGallons = rows.filter((r) => r.quantity !== null);
    expect(withGallons).toHaveLength(2);
    expect(withGallons.map((r) => [r.jurisdiction, r.quantity])).toEqual([
      ['OH', '2000.0000'],
      ['IN', '1000.0000'],
    ]);
  });
});

describe('what reaches the ledger', () => {
  it('posts fuel as money out', async () => {
    const rows = await query<{ n: string; total: string }>(
      `SELECT count(*) AS n, sum(amount)::text AS total
         FROM accounting.ledger_entry WHERE source_document_id = $1`,
      [documentId],
    );
    // Three of the four post: the cash advance has no category, so the
    // commit path rejects it for a human to code rather than guessing one.
    expect(Number(rows[0]!.n)).toBe(3);
    expect(rows[0]!.total).toBe('-13247.00');
  });

  it('holds back the line it cannot categorise instead of inventing a category', async () => {
    const rows = await getDocumentRows(documentId);
    const advance = rows.find((r) => r.categoryId === null)!;
    expect(advance.status).toBe('rejected');
    expect(advance.reviewNotes).toMatch(/categoryId/);
  });
});

describe('what reaches the IFTA engine', () => {
  it('credits the diesel gallons to the state they were bought in', async () => {
    const v = await getIftaReturn({
      from: `${YEAR}-01-01`,
      to: `${YEAR}-03-31`,
      entityId: ENTITY_ZONE_ID,
    });

    // 3,000 gallons, not 3,500: the 500 DEF gallons are not fuel.
    expect(v.result?.totalGallonsPurchased).toBe('3000.0000');
    const ohio = v.result!.lines.find((l) => l.jurisdiction === 'OH')!;
    const indiana = v.result!.lines.find((l) => l.jurisdiction === 'IN')!;
    expect(ohio.taxPaidGallons).toBe('2000.0000');
    expect(indiana.taxPaidGallons).toBe('1000.0000');
  });

  it('never lets DEF gallons become tax-paid gallons', async () => {
    // The single most valuable refusal in this parser, asserted where it
    // actually matters — at the engine, not at the parser. 500 DEF
    // gallons folded in would claim a credit that was never earned.
    const v = await getIftaReturn({
      from: `${YEAR}-01-01`,
      to: `${YEAR}-03-31`,
      entityId: ENTITY_ZONE_ID,
    });
    const total = v.result!.lines.reduce(
      (acc, l) => acc + Number(l.taxPaidGallons),
      0,
    );
    expect(total).toBe(3000);
  });

  it('counts the DEF purchase as fuel spend that earns no credit', async () => {
    const v = await getIftaReturn({
      from: `${YEAR}-01-01`,
      to: `${YEAR}-03-31`,
      entityId: ENTITY_ZONE_ID,
    });
    // It posted to fuel.diesel with a null quantity, so the repo sees a
    // fuel row with no gallons — real money, no credit, and said so.
    expect(v.sources.fuelEntriesUnusable).toBe(1);
    expect(v.sources.unusableFuelAmount).toBe('2050.00');
  });
});

describe('re-dropping the same statement', () => {
  it('is a no-op, not a second set of purchases', async () => {
    const again = await createDocument({
      docType: 'fuel_card',
      fileName: 'efs-again.csv',
      mimeType: 'text/csv',
      bytes: Buffer.from(STATEMENT, 'utf8'),
      uploadedBy: 'accounting@fleet',
    });
    expect(again.duplicateOf).toBe(documentId);

    const rows = await query<{ n: string }>(
      `SELECT count(*) AS n FROM accounting.ledger_entry WHERE source_document_id = $1`,
      [documentId],
    );
    expect(Number(rows[0]!.n)).toBe(3);
  });
});
