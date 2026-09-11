/**
 * The fuel-card statement parser, end to end.
 *
 * The statements below are synthetic and say so. No real EFS or Relay
 * statement exists in this build's fixtures or in the operator's Drive —
 * searched, not assumed — so rather than guess one vendor's exact layout,
 * the parser matches columns by meaning and these fixtures exercise several
 * plausible layouts instead of one invented "real" one. When a genuine
 * statement arrives, the right test to add is one that runs against it; the
 * refusals below are what must keep holding.
 */
import { describe, expect, it } from 'vitest';
import { parseFuelCardStatement, detectVendor } from '@/ingest/fuelcard';
import type { FuelCardPayload } from '@/ingest/fuelcard';

/** One vendor's shape: transaction date, explicit state, net amount. */
const EFS_SHAPED = `EFS LLC
Account 99887766
Billing period 03/01/2026 - 03/31/2026

Tran Date,Invoice,Unit,Driver Name,Location Name,State,Product,Qty,Unit Price,Net Amount
03/14/2026,INV-1001,7004,A DRIVER,PILOT 123 COLUMBUS,OH,ULSD,118.40,3.485,412.66
03/15/2026,INV-1002,7004,A DRIVER,LOVES 456 FISHKILL,NY,DEF BULK,9.50,4.100,38.95
03/16/2026,INV-1003,6179,B DRIVER,TA BROOKVILLE,PA,ULSD,140.00,3.600,504.00
03/17/2026,INV-1004,6179,B DRIVER,TA BROOKVILLE,PA,CASH ADVANCE,,,100.00
03/18/2026,INV-1005,7161,C DRIVER,PETRO GASTON,IN,REEFER DIESEL,75.00,3.400,255.00
GRAND TOTAL,,,,,,,,,1310.61
`;

/** Another vendor's shape: no state column, gross/discount/net, a credit
 *  written in accounting parentheses. */
const RELAY_SHAPED = `Relay Payments
Statement 2026-03

Transaction Date\tVehicle #\tMerchant City\tItem Description\tGallons\tRetail Amount\tDiscount\tAmount
03/02/2026\t7004\tColumbus, OH 43207\tDIESEL\t100.00\t380.00\t20.00\t360.00
03/03/2026\t7004\tFishkill, NY 12524\tDIESEL\t50.00\t195.00\t5.00\t190.00
03/04/2026\t7004\tFishkill, NY 12524\tDIESEL\t(50.00)\t(195.00)\t(5.00)\t(190.00)
`;

function payloadOf(row: { parsedPayload: Record<string, unknown> }): FuelCardPayload {
  return row.parsedPayload as unknown as FuelCardPayload;
}

describe('detectVendor', () => {
  it('reads the vendor off the masthead', () => {
    expect(detectVendor(EFS_SHAPED)).toBe('efs');
    expect(detectVendor(RELAY_SHAPED)).toBe('relay');
  });

  it('looks only at the masthead, not the whole document', () => {
    // "EFS" is a payment-method word deep inside the operator's own
    // expense sheets. Matching it anywhere would label a Relay statement
    // as EFS.
    const relayWithEfsWord = RELAY_SHAPED + '\n'.repeat(30) + 'paid by EFS card\n';
    expect(detectVendor(relayWithEfsWord)).toBe('relay');
  });

  it('says unknown rather than guessing', () => {
    expect(detectVendor('Date,Amount\n03/01/2026,1.00')).toBe('unknown');
  });
});

describe('parseFuelCardStatement', () => {
  const efs = parseFuelCardStatement(EFS_SHAPED, 'doc-1');
  if (efs.status !== 'parsed') throw new Error(`fixture failed to parse: ${efs.error}`);

  it('finds the table under the letterhead and reads every transaction', () => {
    expect(efs.vendor).toBe('efs');
    expect(efs.rows).toHaveLength(5);
    expect(efs.stats.totalRows).toBe(5);
  });

  it('counts only the diesel lines as IFTA gallons', () => {
    // 118.40 + 140.00. The DEF, the cash advance and the reefer diesel
    // are all excluded — and two of those three are priced per gallon.
    expect(efs.stats.iftaDieselRows).toBe(2);
    expect(efs.stats.iftaDieselGallons).toBe('258.40');
    expect(efs.stats.byProduct).toMatchObject({ diesel: 2, def: 1, reefer: 1, non_fuel: 1 });
  });

  it('keeps DEF gallons off the ledger row entirely', () => {
    const def = efs.rows.find((r) => payloadOf(r).productKind === 'def')!;
    // The money is real and posts. The gallons are null, so nothing
    // downstream can mistake them for fuel burned in an engine.
    expect(def.amount).toBe('-38.95');
    expect(def.quantity).toBeNull();
    expect(def.reviewNotes).toMatch(/NOT IFTA diesel gallons/);
    expect(def.status).toBe('under_review');
  });

  it('keeps reefer gallons off the ledger row too', () => {
    const reefer = efs.rows.find((r) => payloadOf(r).productKind === 'reefer')!;
    expect(reefer.quantity).toBeNull();
    expect(reefer.amount).toBe('-255.00');
  });

  it('signs fuel as money out, matching the ledger convention', () => {
    const diesel = efs.rows[0]!;
    expect(diesel.amount).toBe('-412.66');
    expect(diesel.quantity).toBe('118.40');
    expect(diesel.jurisdiction).toBe('OH');
    expect(diesel.accrualDate).toBe('2026-03-14');
    expect(diesel.status).toBe('parsed');
  });

  it('leaves a non-fuel line uncategorised rather than calling it diesel', () => {
    const advance = efs.rows.find((r) => payloadOf(r).productKind === 'non_fuel')!;
    expect(advance.categoryId).toBeNull();
    expect(advance.quantity).toBeNull();
    expect(advance.amount).toBe('-100.00');
  });

  it('does not read the totals line as a sixth transaction', () => {
    // The GRAND TOTAL row sits inside the table and splits to the header's
    // own width, so nothing structural excludes it. Read as a transaction
    // it adds the whole statement to itself a second time — which is what
    // this parser did until this test was written.
    expect(efs.rows).toHaveLength(5);
    expect(efs.rows.every((r) => r.accrualDate !== null)).toBe(true);
    expect(efs.stats.netAmountTotal).toBe('1310.61');
  });

  it('checks the parsed lines against the statement total', () => {
    // 412.66 + 38.95 + 504.00 + 100.00 + 255.00 = 1310.61, which is what
    // the fixture states — so no mismatch is reported.
    expect(efs.stats.netAmountTotal).toBe('1310.61');
    expect(efs.problems.some((p) => /states a total of/.test(p))).toBe(false);
  });

  it('reports a total that does not agree, rather than trusting itself', () => {
    const tampered = EFS_SHAPED.replace('1310.61', '1400.00');
    const r = parseFuelCardStatement(tampered, 'doc-x');
    if (r.status !== 'parsed') throw new Error('expected a parse');
    expect(
      r.problems.some((p) => /add to 1310\.61 but the statement states a total of 1400\.00/.test(p)),
    ).toBe(true);
    // Flagged, never reconciled by adjusting the lines to fit.
    expect(r.stats.netAmountTotal).toBe('1310.61');
  });
});

describe('a statement with no state column', () => {
  const relay = parseFuelCardStatement(RELAY_SHAPED, 'doc-2');
  if (relay.status !== 'parsed') throw new Error(`fixture failed to parse: ${relay.error}`);

  it('recovers the jurisdiction from the city column', () => {
    expect(relay.rows[0]!.jurisdiction).toBe('OH');
    expect(relay.rows[1]!.jurisdiction).toBe('NY');
  });

  it('bills the net amount, not the retail amount', () => {
    // Retail 380.00, discount 20.00, billed 360.00. Taking retail
    // overstates fuel cost by the discount on every line.
    expect(relay.rows[0]!.amount).toBe('-360.00');
    expect(payloadOf(relay.rows[0]!).amountGross).toBe('380.00');
    expect(payloadOf(relay.rows[0]!).discount).toBe('20.00');
  });

  it('reads a reversal as a credit in both money and gallons', () => {
    const reversal = relay.rows[2]!;
    // Money in, gallons back out. Read as a charge this would add the
    // refund instead of subtracting it, twice over.
    expect(reversal.amount).toBe('190.00');
    expect(reversal.quantity).toBe('-50.00');
  });

  it('nets a reversal out of the gallons total', () => {
    expect(relay.stats.iftaDieselGallons).toBe('100.00');
  });
});

describe('what it refuses', () => {
  it('names the header it read when a required column is missing', () => {
    // The operator gets a diagnosis, not "parse failed" — which matters
    // most for exactly the layouts nobody here has seen.
    const r = parseFuelCardStatement(
      'Unit,Product,Qty\n7004,ULSD,118.40\n6179,ULSD,90.00\n',
      'doc-3',
    );
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.error).toMatch(/missing transactionDate and amountNet/);
    expect(r.error).toMatch(/Unit \| Product \| Qty/);
  });

  it('says so when there is no table at all', () => {
    const r = parseFuelCardStatement('Dear customer,\n\nYour statement is attached.\n', 'doc-4');
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.error).toMatch(/No transaction table/);
  });

  it('accepts a post-date-only statement rather than refusing it', () => {
    const r = parseFuelCardStatement(
      'Post Date,Unit,Product,Qty,Amount\n03/14/2026,7004,ULSD,118.40,412.66\n03/15/2026,6179,ULSD,90.00,320.00\n',
      'doc-5',
    );
    if (r.status !== 'parsed') throw new Error('expected a parse');
    // A purchase made on the last day of a quarter can post in the next
    // one, and would then file in the wrong quarter.
    expect(r.problems.some((p) => /no transaction-date column/.test(p))).toBe(true);
    expect(payloadOf(r.rows[0]!).usedPostDate).toBe(true);
  });

  it('warns when nothing supplies a purchase state', () => {
    const r = parseFuelCardStatement(
      'Tran Date,Unit,Product,Qty,Amount\n03/14/2026,7004,ULSD,118.40,412.66\n03/15/2026,6179,ULSD,90.00,320.00\n',
      'doc-6',
    );
    if (r.status !== 'parsed') throw new Error('expected a parse');
    expect(r.problems.some((p) => /no purchase jurisdiction can be read/.test(p))).toBe(true);
    expect(r.stats.dieselMissingJurisdiction).toBe(2);
    expect(
      r.problems.some((p) => /too high, not too low/.test(p)),
    ).toBe(true);
  });

  it('withholds unrecognised products from IFTA instead of assuming diesel', () => {
    const r = parseFuelCardStatement(
      'Tran Date,Unit,State,Product,Qty,Amount\n03/14/2026,7004,OH,PRD-4471,118.40,412.66\n03/15/2026,6179,OH,ULSD,90.00,320.00\n',
      'doc-7',
    );
    if (r.status !== 'parsed') throw new Error('expected a parse');
    expect(r.stats.iftaDieselGallons).toBe('90.00');
    expect(r.rows[0]!.quantity).toBeNull();
    expect(r.problems.some((p) => /does not\s+recognise/.test(p))).toBe(true);
  });

  it('does not invent gallons when the statement has no quantity column', () => {
    const r = parseFuelCardStatement(
      'Tran Date,Unit,State,Product,Amount\n03/14/2026,7004,OH,ULSD,412.66\n03/15/2026,6179,OH,ULSD,320.00\n',
      'doc-8',
    );
    if (r.status !== 'parsed') throw new Error('expected a parse');
    expect(r.rows.every((row) => row.quantity === null)).toBe(true);
    expect(r.stats.iftaDieselGallons).toBe('0.00');
    expect(r.problems.some((p) => /cannot supply IFTA gallons/.test(p))).toBe(true);
  });
});
