/**
 * The IFTA screen's presentation logic and the mileage→staging adapter.
 *
 * Both are places a return could read as more final than it is. The period
 * presets matter more than they look: an offered period that spans two
 * quarters would be refused by the server the moment it was picked, so the
 * clamping is tested rather than assumed.
 */
import { describe, expect, it } from 'vitest';
import type { IftaReturnView } from '@/db/repo/ifta';
import { quarterOf, trimToPlaces, IftaRequestError } from '@/db/repo/ifta';
import {
  includedDocumentCount,
  lineDirection,
  netDueReading,
  periodPresets,
  saveBlockReason,
  withheldJurisdictions,
} from '@/components/ifta/logic';
import { iftaMileageToStagingRows } from '@/ingest/ifta/toStagingRows';
import { parseIftaMileage } from '@/ingest/ifta/parseMileage';

const REPORT = `
DEMO CARRIER LLC 100 Example Road Springfield IL 60000

IFTA by Vehicles: 2

2026-04-01 - 2026-06-30

Vehicle: 1001 (1AAAAAAAAAAAAAAA1)

Seq State Miles

1 OH 1,200.50

2 IN 800.25

Total 2,000.75

Vehicle: 1002 (1BBBBBBBBBBBBBBB2)

Seq State Miles

1 OH 999.25

Total 999.25

Total Distance by State

Seq State Miles

1 OH 2,199.75

2 IN 800.25

Total 3,000.00
`;

function view(overrides: Partial<IftaReturnView> = {}): IftaReturnView {
  return {
    from: '2026-04-01',
    to: '2026-06-30',
    entityId: 'e1',
    quarter: { year: 2026, quarter: 2 },
    periodKind: 'quarter',
    result: {
      periodStart: '2026-04-01',
      periodEnd: '2026-06-30',
      periodKind: 'quarter',
      totalMiles: '3000.00',
      totalGallonsPurchased: '600.0000',
      fleetMpg: '5.00',
      lines: [],
      netDue: '0.00',
      problems: [],
    },
    blocked: null,
    sourceProblems: [],
    sources: {
      mileageDocuments: [],
      fuelEntryCount: 0,
      fuelEntriesUnusable: 0,
      unusableFuelAmount: '0.00',
      rateCount: 0,
      rateSourceNotes: [],
    },
    ...overrides,
  };
}

describe('quarterOf', () => {
  it('maps each month to its quarter', () => {
    expect(quarterOf('2026-01-31')).toEqual({ year: 2026, quarter: 1 });
    expect(quarterOf('2026-03-31')).toEqual({ year: 2026, quarter: 1 });
    expect(quarterOf('2026-04-01')).toEqual({ year: 2026, quarter: 2 });
    expect(quarterOf('2026-12-31')).toEqual({ year: 2026, quarter: 4 });
  });

  it('refuses something that is not a date', () => {
    expect(() => quarterOf('Q2 2026')).toThrow(IftaRequestError);
  });
});

describe('trimToPlaces', () => {
  it('drops only trailing zeros', () => {
    // numeric(14,4) returns miles as "3758.0400"; the engine parses miles
    // at two places. Those two zeros are padding, not precision.
    expect(trimToPlaces('3758.0400', 2)).toBe('3758.04');
    expect(trimToPlaces('100.0000', 2)).toBe('100.00');
    expect(trimToPlaces('5', 2)).toBe('5');
  });

  it('refuses to drop a digit that was really there', () => {
    // Silently rounding here is how a mileage total drifts by an amount
    // nobody can later trace.
    expect(() => trimToPlaces('3758.0450', 2)).toThrow(/would change the figure/);
  });
});

describe('periodPresets', () => {
  it('offers the current quarter and the three before it', () => {
    const p = periodPresets(new Date('2026-05-15T00:00:00Z'));
    expect(p.slice(0, 4).map((x) => x.id)).toEqual(['2026Q2', '2026Q1', '2025Q4', '2025Q3']);
    expect(p[0]).toMatchObject({ from: '2026-04-01', to: '2026-06-30', kind: 'quarter' });
    expect(p[2]).toMatchObject({ from: '2025-10-01', to: '2025-12-31' });
  });

  it('gets February right in a leap year and a common one', () => {
    expect(periodPresets(new Date('2028-02-10T00:00:00Z'))[0]!.to).toBe('2028-03-31');
    const feb = periodPresets(new Date('2026-02-10T00:00:00Z')).find((x) => x.id === 'this-month');
    expect(feb).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('labels the week and month as accruals, not returns', () => {
    const p = periodPresets(new Date('2026-05-15T00:00:00Z'));
    expect(p.find((x) => x.id === 'this-week')!.kind).toBe('accrual');
    expect(p.find((x) => x.id === 'this-month')!.kind).toBe('accrual');
  });

  it('clamps a week that started in the previous quarter', () => {
    // 2026-04-01 is a Wednesday, so that week began Monday 2026-03-30 — in
    // Q1, with a different rate table. Offering it unclamped would hand a
    // person a preset the server is obliged to refuse.
    const week = periodPresets(new Date('2026-04-01T00:00:00Z')).find((x) => x.id === 'this-week')!;
    expect(week.from).toBe('2026-04-01');
    expect(week.to).toBe('2026-04-05');
  });
});

describe('netDueReading', () => {
  it('never lets owed and credit share a wording', () => {
    expect(netDueReading('1234.56')).toEqual({
      direction: 'owed',
      amount: '1234.56',
      label: 'Owed to the jurisdictions',
    });
    // The amount is positive and the direction carries the sign: a minus
    // in a column of tax figures is too easy to read past.
    expect(netDueReading('-1234.56')).toEqual({
      direction: 'credit',
      amount: '1234.56',
      label: 'Net credit',
    });
    expect(netDueReading('0.00').direction).toBe('nil');
  });
});

describe('lineDirection', () => {
  const line = (totalDue: string) =>
    ({
      jurisdiction: 'OH',
      totalMiles: '0',
      taxableMiles: '0',
      taxableGallons: '0',
      taxPaidGallons: '0',
      netTaxableGallons: '0',
      ratePerGallon: '0',
      taxDue: '0.00',
      surchargePerGallon: '0',
      surchargeDue: '0.00',
      totalDue,
    }) as const;

  it('reads the sign of the line total', () => {
    expect(lineDirection(line('10.00'))).toBe('owed');
    expect(lineDirection(line('-10.00'))).toBe('credit');
    expect(lineDirection(line('0.00'))).toBe('nil');
  });
});

describe('saveBlockReason', () => {
  it('lets a complete quarter for one licensee through', () => {
    expect(saveBlockReason(view())).toBeNull();
  });

  it('refuses an accrual, because IFTA files quarterly', () => {
    expect(saveBlockReason(view({ periodKind: 'accrual' }))).toMatch(/accrual, not a return/);
  });

  it('refuses a group-wide figure, because a return has one licensee', () => {
    expect(saveBlockReason(view({ entityId: null }))).toMatch(/one licensee/);
  });

  it('refuses a return the engine already said is short', () => {
    const v = view();
    v.result!.problems = ['KY: no tax rate on file for this period, so its liability is unknown'];
    expect(saveBlockReason(v)).toMatch(/knowably short/);
  });

  it("passes through the engine's own refusal when there is no figure at all", () => {
    expect(saveBlockReason(view({ result: null, blocked: 'No fuel purchases in this period' }))).toBe(
      'No fuel purchases in this period',
    );
  });
});

describe('withheldJurisdictions', () => {
  it('pulls the state codes back out of the engine’s sentences', () => {
    expect(
      withheldJurisdictions([
        'KY: no tax rate on file for this period, so its liability is unknown and is NOT in the total.',
        'This period is not a calendar quarter, so this is an accrual.',
        'IN: no tax rate on file for this period, so its liability is unknown and is NOT in the total.',
      ]),
    ).toEqual(['KY', 'IN']);
  });

  it('does not mistake another problem mentioning a state for a missing rate', () => {
    expect(
      withheldJurisdictions([
        'OH: more miles are claimed exempt (10.00) than were driven there (5.00).',
        'Only one jurisdiction (OH) appears in this period.',
      ]),
    ).toEqual([]);
  });
});

describe('includedDocumentCount', () => {
  it('counts only the reports that actually contributed miles', () => {
    const v = view();
    v.sources.mileageDocuments = [
      { documentId: 'a', fileName: 'a.txt', carrier: 'X', periodStart: '2026-04-01', periodEnd: '2026-06-30', entityId: null, rowCount: 3, excludedReason: null },
      { documentId: 'b', fileName: 'b.txt', carrier: 'X', periodStart: '2026-03-01', periodEnd: '2026-05-31', entityId: null, rowCount: 3, excludedReason: 'partial overlap' },
    ];
    expect(includedDocumentCount(v)).toBe(1);
  });
});

describe('iftaMileageToStagingRows', () => {
  const rows = iftaMileageToStagingRows(parseIftaMileage(REPORT), 'doc-1');

  it('makes one row per vehicle per state — the grain a reviewer corrects at', () => {
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.jurisdiction, r.quantity])).toEqual([
      ['OH', '1200.50'],
      ['IN', '800.25'],
      ['OH', '999.25'],
    ]);
    expect(rows.map((r) => r.rowIndex)).toEqual([0, 1, 2]);
  });

  it('carries no amount, because miles are not money', () => {
    // This is what makes ifta_mileage a non-posting document type: the
    // commit path requires an amount and there is none to give it.
    expect(rows.every((r) => r.amount === null)).toBe(true);
    expect(rows.every((r) => r.categoryId === null)).toBe(true);
  });

  it('keeps the report period on every row, not just a date', () => {
    const payload = rows[0]!.parsedPayload as Record<string, unknown>;
    expect(payload.periodStart).toBe('2026-04-01');
    expect(payload.periodEnd).toBe('2026-06-30');
    expect(payload.unitNumber).toBe('1001');
    // The end of the period is the date these miles are *known* by. The
    // period itself is what the repo reads — miles accrue across it and
    // cannot be attributed to one day.
    expect(rows[0]!.accrualDate).toBe('2026-06-30');
  });

  it('sends a vehicle that failed its own checksum to a human', () => {
    const tampered = REPORT.replace('Total 2,000.75', 'Total 2,000.76');
    const out = iftaMileageToStagingRows(parseIftaMileage(tampered), 'doc-2');
    // Both of that vehicle's rows are flagged: a reviewer looking at one
    // state's line needs to know the block it came from is suspect.
    expect(out.slice(0, 2).every((r) => r.status === 'under_review')).toBe(true);
    expect(out[2]!.status).toBe('parsed');
    expect(out[0]!.reviewNotes).toMatch(/add to 2000\.75 but the block states 2000\.76/);
  });
});
