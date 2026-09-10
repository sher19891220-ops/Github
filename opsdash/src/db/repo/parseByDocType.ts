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
 *  parser expects. Binary formats (PDF, XLSX) have no extraction step in
 *  this codebase — see the final report — so they are stored (for
 *  provenance and manual review) but never silently mis-parsed. */
export function isTextDecodable(mimeType: string, fileName: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  if (mimeType === 'application/csv') return true;
  return /\.(txt|csv|tsv|md)$/i.test(fileName);
}
