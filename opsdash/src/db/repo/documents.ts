/**
 * `source_document` + its staging rows.
 *
 * Upload is content-addressed: re-dropping the same bytes is a no-op
 * (`duplicateOf` in the result), which is what makes the ingest workflow
 * safe to retry. Parsing happens synchronously at upload time via
 * `parseByDocType`, so `GET /api/documents/:id` reflects a final
 * `parse_status` rather than a `pending` one the caller has to poll for
 * text-decodable content (binary content is stored but not parsed — see
 * parseByDocType.ts).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { DocumentSummary as ContractDocumentSummary, StagingRow } from '@/contract/types';
import { query, withTransaction } from '@/db/pool';
import { putBlob } from './blobStore';
import { insertStagingRows } from './insertStagingRows';
import { LEDGER_ENTRY_COLUMNS_SQL, STAGING_ROW_COLUMNS_SQL, mapDbRowToStagingRowRecord, toWireStagingRow } from './mappers';
import { isTextDecodable, parseByDocType } from './parseByDocType';
import type { DocumentStatusSummary } from './types';

export interface CreateDocumentInput {
  docType: string;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  uploadedBy: string;
  pageCount?: number | null;
}

export interface CreateDocumentResult {
  documentId: string;
  sha256: string;
  duplicateOf: string | null;
}

const UNIQUE_VIOLATION = '23505';

/**
 * Creates the `source_document` row (or returns the existing one, unchanged,
 * if these exact bytes were already uploaded), then attempts to parse and
 * stage rows for a brand-new document. Parsing is best-effort: a parse
 * failure is recorded on the document (`parse_status = 'failed'`), never
 * thrown, because the upload itself succeeded and the bytes are safely
 * stored regardless of whether they could be read.
 */
export async function createDocument(input: CreateDocumentInput): Promise<CreateDocumentResult> {
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');

  const existing = await query<{ document_id: string }>(
    `SELECT document_id FROM accounting.source_document WHERE sha256 = $1`,
    [sha256],
  );
  if (existing.length > 0 && existing[0]) {
    return { documentId: existing[0].document_id, sha256, duplicateOf: existing[0].document_id };
  }

  const storageKey = await putBlob(sha256, input.bytes);
  const documentId = randomUUID();

  try {
    await query(
      `INSERT INTO accounting.source_document
         (document_id, doc_type, file_name, mime_type, byte_size, sha256, storage_key, page_count, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        documentId,
        input.docType,
        input.fileName,
        input.mimeType,
        input.bytes.length,
        sha256,
        storageKey,
        input.pageCount ?? null,
        input.uploadedBy,
      ],
    );
  } catch (err) {
    // A concurrent upload of the same bytes can race between the SELECT
    // above and this INSERT; the sha256 UNIQUE constraint is the real guard,
    // this just turns that race into the same "duplicate" response instead
    // of a 500.
    if (isUniqueViolation(err)) {
      const rows = await query<{ document_id: string }>(
        `SELECT document_id FROM accounting.source_document WHERE sha256 = $1`,
        [sha256],
      );
      const row = rows[0];
      if (row) return { documentId: row.document_id, sha256, duplicateOf: row.document_id };
    }
    throw err;
  }

  await parseAndStage(documentId, input.docType, input.mimeType, input.fileName, input.bytes);

  return { documentId, sha256, duplicateOf: null };
}

async function parseAndStage(
  documentId: string,
  docType: string,
  mimeType: string,
  fileName: string,
  bytes: Buffer,
): Promise<void> {
  if (!isTextDecodable(mimeType, fileName)) {
    await setDocumentParseResult(
      documentId,
      'failed',
      `no text-extraction step exists for mime type "${mimeType}"; upload the sheet/document as text/CSV, or add an extraction step before parsing.`,
    );
    return;
  }

  const text = bytes.toString('utf8');
  const outcome = parseByDocType(docType, text, documentId);

  if (outcome.status === 'failed') {
    await setDocumentParseResult(documentId, 'failed', outcome.error);
    return;
  }

  await withTransaction(async (q) => {
    await insertStagingRows(q, outcome.rows);
  });
  await setDocumentParseResult(documentId, 'parsed', null);
}

export async function setDocumentParseResult(
  documentId: string,
  status: 'parsed' | 'failed',
  error: string | null,
): Promise<void> {
  await query(
    `UPDATE accounting.source_document SET parse_status = $2, parse_error = $3 WHERE document_id = $1`,
    [documentId, status, error],
  );
}

/** The exact DATA-CONTRACT.md §6 shape for `GET /api/documents/:id`. */
export async function getDocumentSummary(documentId: string): Promise<DocumentStatusSummary | null> {
  const rows = await query<{
    document_id: string;
    doc_type: string;
    parse_status: string;
    parse_error: string | null;
    row_count: number;
  }>(
    `SELECT sd.document_id, sd.doc_type, sd.parse_status, sd.parse_error,
            COUNT(sr.staging_row_id)::int AS row_count
     FROM accounting.source_document sd
     LEFT JOIN accounting.staging_row sr ON sr.document_id = sd.document_id
     WHERE sd.document_id = $1
     GROUP BY sd.document_id, sd.doc_type, sd.parse_status, sd.parse_error`,
    [documentId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    documentId: r.document_id,
    docType: r.doc_type,
    parseStatus: r.parse_status as DocumentStatusSummary['parseStatus'],
    parseError: r.parse_error,
    rowCount: r.row_count,
  };
}

/** `GET /api/documents` (plural) — the richer shape `@/contract/types`'
 *  `DocumentSummary` defines for the document-list screen. `duplicateOf` is
 *  always null here: that field only ever has meaning on the response to
 *  the upload call itself, never on an already-existing document. */
export async function listDocumentSummaries(): Promise<ContractDocumentSummary[]> {
  const rows = await query<{
    document_id: string;
    doc_type: string;
    file_name: string;
    parse_status: string;
    parse_error: string | null;
    row_count: number;
    uploaded_at: string;
    sha256: string;
  }>(
    `SELECT sd.document_id, sd.doc_type, sd.file_name, sd.parse_status, sd.parse_error,
            COUNT(sr.staging_row_id)::int AS row_count,
            to_char(sd.uploaded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS uploaded_at,
            sd.sha256
     FROM accounting.source_document sd
     LEFT JOIN accounting.staging_row sr ON sr.document_id = sd.document_id
     GROUP BY sd.document_id, sd.doc_type, sd.file_name, sd.parse_status, sd.parse_error, sd.uploaded_at, sd.sha256
     ORDER BY sd.uploaded_at DESC`,
  );
  return rows.map((r) => ({
    documentId: r.document_id,
    docType: r.doc_type as ContractDocumentSummary['docType'],
    fileName: r.file_name,
    parseStatus: r.parse_status as ContractDocumentSummary['parseStatus'],
    parseError: r.parse_error,
    rowCount: r.row_count,
    uploadedAt: r.uploaded_at,
    sha256: r.sha256,
    duplicateOf: null,
  }));
}

export async function getDocumentRows(documentId: string): Promise<StagingRow[]> {
  const rows = await query(
    `SELECT ${STAGING_ROW_COLUMNS_SQL} FROM accounting.staging_row WHERE document_id = $1 ORDER BY row_index`,
    [documentId],
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((r) => toWireStagingRow(mapDbRowToStagingRowRecord(r as any)));
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

// Re-exported so callers that only need the ledger column list (e.g. the
// commit path's post-insert lookups) do not need a second import path.
export { LEDGER_ENTRY_COLUMNS_SQL };
