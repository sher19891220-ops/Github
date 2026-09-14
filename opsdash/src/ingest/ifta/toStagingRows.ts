/**
 * Turns a parsed IFTA mileage report into staging rows.
 *
 * One row per vehicle per jurisdiction — the grain the return is actually
 * computed at, and the grain a reviewer can correct at. A report-level row
 * would hide a single vehicle's bad state code inside a state total.
 *
 * **These rows carry no `amount`, and that is not an omission.** Miles are
 * a measurement, not money. `commitDocument` requires an amount and would
 * reject every one of them; `ifta_mileage` is therefore a non-posting
 * document type (see `db/repo/commit.ts`), and these rows stay in staging
 * as the reviewable record of what the telematics reported. The IFTA repo
 * reads them from there. They still trace to a `source_document` — the
 * standard of proof is unchanged, only the destination is.
 *
 * The report's own two checksums are preserved as parse problems on the
 * document rather than being silently repaired: a report that disagrees
 * with itself is a fact about the report.
 */
import { randomUUID } from 'node:crypto';
import type { StagingRow } from '@/contract/types';
import type { IftaMileageReport } from './parseMileage';

/** What `parsedPayload` carries on every mileage row. Read back by
 *  `db/repo/ifta.ts`, so the shape is named rather than implied. */
export interface IftaMileagePayload {
  kind: 'ifta_mileage';
  carrier: string;
  periodStart: string;
  periodEnd: string;
  unitNumber: string;
  vin: string;
  /** Set when the vehicle's own rows did not add up to its stated total.
   *  Carried onto every row of that vehicle so a reviewer looking at one
   *  state's line can see the block it came from is suspect. */
  blockMismatch: string | null;
}

export function iftaMileageToStagingRows(report: IftaMileageReport, documentId: string): StagingRow[] {
  const rows: StagingRow[] = [];

  for (const vehicle of report.vehicles) {
    for (const state of vehicle.states) {
      const payload: IftaMileagePayload = {
        kind: 'ifta_mileage',
        carrier: report.carrier,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        unitNumber: vehicle.unitNumber,
        vin: vehicle.vin,
        blockMismatch: vehicle.totalMismatch,
      };

      rows.push({
        stagingRowId: randomUUID(),
        documentId,
        rowIndex: rows.length,
        sourcePage: null,
        parsedPayload: payload as unknown as Record<string, unknown>,
        reviewedPayload: null,
        entityId: null,
        truckId: null,
        driverId: null,
        // The report states a period, not a date per row. The end of that
        // period is the date these miles are *known* by; the period itself
        // is in the payload, and the repo reads that rather than this,
        // because miles accrue across a period and cannot be attributed to
        // one day of it.
        accrualDate: report.periodEnd === '' ? null : report.periodEnd,
        categoryId: null,
        amount: null,
        quantity: state.miles,
        jurisdiction: state.jurisdiction,
        // A block that failed its own checksum goes to a human. Everything
        // else is parsed and usable.
        status: vehicle.totalMismatch === null ? 'parsed' : 'under_review',
        reviewNotes: vehicle.totalMismatch,
      });
    }
  }

  return rows;
}
