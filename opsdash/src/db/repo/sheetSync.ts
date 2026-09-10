/**
 * The sheet-sync entry point: runs an existing ingest parser over a sheet's
 * exported text and writes the resulting staging rows, so the accounting
 * team stops re-typing what a live Google Sheet already has.
 *
 * Scope, stated plainly: this module does not itself talk to the Google
 * Drive API. Nothing in this codebase's dependencies does (no Drive client
 * exists in package.json), and building one is outside what "persistence
 * layer and API routes" asks for. `rawText` is the sheet's export — exactly
 * the same pipe-table text format the existing parsers already consume and
 * the same format the unit tests fixture from — supplied by whatever reads
 * the Drive connector (a scheduled job, a manual export, or a human paste).
 * Wiring an actual Drive fetch in front of this function is a small, later
 * change; this is the part that turns fetched text into reviewable rows.
 *
 * A sync is content-addressed exactly like a document upload: syncing an
 * unchanged sheet twice in a row is a no-op (`duplicateOf` is set, nothing
 * is re-parsed or re-inserted), which is what makes it safe to run on a
 * schedule rather than only on demand.
 */
import { createDocument, getDocumentSummary, type CreateDocumentResult } from './documents';

export type SheetSyncPurpose = 'revenue' | 'fuel' | 'expenses';

const DOC_TYPE_BY_PURPOSE: Record<SheetSyncPurpose, string> = {
  revenue: 'revenue',
  fuel: 'fuel',
  // The expenses sheet feeds both toll and maintenance categories in one
  // pass (SOURCE-DISCOVERY.md §5); 'maintenance' is the doc_type, the
  // per-row category is decided at review/commit time.
  expenses: 'maintenance',
};

export interface SheetSyncInput {
  purpose: SheetSyncPurpose;
  rawText: string;
  /** A human-readable label for provenance, e.g. "Dispatch Sheet 2026 — 2026-09-10 sync". */
  fileName: string;
  uploadedBy: string;
}

export interface SheetSyncResult {
  documentId: string;
  sha256: string;
  duplicateOf: string | null;
  parseStatus: 'parsed' | 'failed' | 'pending';
  parseError: string | null;
  rowsWritten: number;
}

export async function runSheetSync(input: SheetSyncInput): Promise<SheetSyncResult> {
  const docType = DOC_TYPE_BY_PURPOSE[input.purpose];
  const bytes = Buffer.from(input.rawText, 'utf8');

  const created: CreateDocumentResult = await createDocument({
    docType,
    fileName: input.fileName,
    mimeType: 'text/plain',
    bytes,
    uploadedBy: input.uploadedBy,
  });

  const summary = await getDocumentSummary(created.documentId);

  return {
    documentId: created.documentId,
    sha256: created.sha256,
    duplicateOf: created.duplicateOf,
    parseStatus: summary?.parseStatus ?? 'pending',
    parseError: summary?.parseError ?? null,
    rowsWritten: summary?.rowCount ?? 0,
  };
}
