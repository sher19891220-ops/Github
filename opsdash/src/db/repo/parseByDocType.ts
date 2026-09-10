/**
 * Picks the right existing parser (src/ingest/**) for a document's declared
 * type and normalizes its result to one shape. Shared by the document-upload
 * route and the sheet-sync entry point so there is exactly one place that
 * decides which parser runs.
 */
import type { StagingRow } from '@/contract/types';
import { parseDispatchSheet } from '@/ingest/dispatch';
import { parseFuelDocument } from '@/ingest/fuel';
import { parseExpensesDocument } from '@/ingest/expenses';
import { extractDocument, type ExtractionResult } from '@/ingest/extract';

export type ParseOutcome =
  | { status: 'parsed'; rows: StagingRow[] }
  | { status: 'failed'; error: string };

/**
 * `toll` and `maintenance` both come off the "Truck and trailer expenses"
 * sheet in a single pass (SOURCE-DISCOVERY.md §5) — the expenses parser
 * already tags each row with a category-group hint, so one document type
 * covers both rather than parsing the same text twice.
 */
export function parseByDocType(docType: string, text: string, documentId: string): ParseOutcome {
  switch (docType) {
    case 'revenue': {
      const r = parseDispatchSheet(text, documentId);
      return r.status === 'parsed' ? { status: 'parsed', rows: r.rows } : { status: 'failed', error: r.error };
    }
    case 'fuel': {
      const r = parseFuelDocument(text, documentId);
      return r.status === 'parsed'
        ? { status: 'parsed', rows: r.rows }
        : { status: 'failed', error: r.parseError ?? 'fuel document failed to parse' };
    }
    case 'maintenance':
    case 'toll': {
      const r = parseExpensesDocument(text, documentId);
      return r.status === 'parsed'
        ? { status: 'parsed', rows: r.rows }
        : { status: 'failed', error: r.parseError ?? 'expenses document failed to parse' };
    }
    case 'ifta_mileage':
      // DATA-CONTRACT.md §7 open item 1: no parser exists yet because no
      // source has been confirmed. Fail loudly rather than guess.
      return { status: 'failed', error: 'no parser implemented for ifta_mileage documents yet (see docs/DATA-CONTRACT.md §7).' };
    default:
      return { status: 'failed', error: `no parser implemented for doc_type "${docType}".` };
  }
}

/** True for content this build can decode as the pipe-table text every
 *  sheet-shaped parser above expects (`parseByDocType`'s `text` argument).
 *
 *  This is deliberately unchanged by the addition of `src/ingest/extract/**`
 *  below. `createDocument` (documents.ts, out of this file's ownership)
 *  currently does `bytes.toString('utf8')` unconditionally before calling
 *  `parseByDocType`, gated only by this function — flipping this to `true`
 *  for PDF/XLSX mime types would NOT wire up real extraction; it would hand
 *  `parseByDocType` a UTF-8-mangled string built from binary bytes (a PDF's
 *  or XLSX's actual byte stream is not valid UTF-8), which is strictly worse
 *  than today's honest `parse_status = 'failed'`. Real binary extraction
 *  needs the *original bytes*, which is exactly what `parseBinaryDocument`
 *  below takes — wiring it in is a `documents.ts` change (passing bytes
 *  instead of a pre-stringified `text`), outside this file's ownership. */
export function isTextDecodable(mimeType: string, fileName: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  if (mimeType === 'application/csv') return true;
  return /\.(txt|csv|tsv|md)$/i.test(fileName);
}

/**
 * Byte-based counterpart to `parseByDocType`, for document families that
 * need real extraction (PDF/XLSX/scanned images) rather than a
 * pre-decoded text table — see `src/ingest/extract/**`.
 *
 * Not yet called from the upload path: `documents.ts` (out of this file's
 * ownership per this task's scope) always stringifies bytes before this
 * point today. This function is the routing this build is ready to switch
 * to once that caller passes raw bytes instead.
 *
 * `registration` is the one document family wired up end to end here (the
 * IRP "Vehicle Status" fleet report — SOURCE-DISCOVERY.md §11b-§14): each
 * VIN row becomes a `StagingRow` whose `parsedPayload` is exactly what the
 * extractor read, with `status` set to `under_review` whenever the VIN
 * failed or only partially passed structural validation. Nothing here
 * writes to `ledger_entry` — this only ever produces staging rows, same as
 * every other parser in this file.
 */
export async function parseBinaryDocument(
  docType: string,
  bytes: Buffer,
  fileName: string,
  mimeType: string,
  documentId: string,
): Promise<ParseOutcome> {
  const extracted: ExtractionResult = await extractDocument(bytes, fileName, mimeType);
  if (extracted.status === 'failed') {
    return { status: 'failed', error: extracted.error ?? `could not extract "${fileName}".` };
  }

  switch (docType) {
    case 'registration': {
      // Deferred import: only this branch needs the registration-specific
      // extractor, and it stays inside src/ingest/extract's ownership.
      const { parseRegistrationVehicleRows } = await import('@/ingest/extract/registration');
      const { randomUUID } = await import('node:crypto');
      const text = (extracted.pages ?? []).map((p) => p.text).join('\n');
      const rows = parseRegistrationVehicleRows(text);
      if (rows.length === 0) {
        return { status: 'failed', error: `no vehicle rows recognized in "${fileName}" (registration document).` };
      }
      const stagingRows: StagingRow[] = rows.map((row, i) => ({
        stagingRowId: randomUUID(),
        documentId,
        rowIndex: i,
        sourcePage: null,
        parsedPayload: {
          unit: row.unit.value,
          usdot: row.usdot.value,
          vin: row.vin.value,
          vinOriginal: row.vin.original,
          vinCorrected: row.vin.corrected,
          vinIllegalChars: row.vin.illegalChars,
          status: row.status.value,
          weightGroup: row.weightGroup.value,
          vehicleType: row.vehicleType.value,
          year: row.year.value,
          make: row.make.value,
          plate: row.plate.value,
          sourceLine: row.sourceLine,
        },
        reviewedPayload: null,
        entityId: null,
        truckId: null,
        driverId: null,
        accrualDate: null,
        categoryId: null,
        amount: null,
        quantity: null,
        jurisdiction: null,
        status: row.vin.needsReview ? 'under_review' : 'parsed',
        reviewNotes: row.vin.needsReview ? row.vin.reason : null,
      }));
      return { status: 'parsed', rows: stagingRows };
    }
    default:
      return { status: 'failed', error: `no binary parser implemented for doc_type "${docType}".` };
  }
}
