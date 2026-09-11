/**
 * The sheet registry, and the guard in front of every sync.
 *
 * `accounting.sheet_source` has existed since migration 002 and nothing
 * used it. Its `header_checksum` column carried the whole safety argument
 * in a comment — a sync that reads a changed sheet writes plausible,
 * wrong numbers — but no code computed a checksum or compared one.
 *
 * This module is that comment made real. A sheet is registered once, its
 * layout is recorded on first sync, and every sync after that is refused
 * if the columns moved. Refused, not warned: a warning on a batch job is a
 * line in a log nobody reads, and the rows would already be in staging.
 *
 * **What this module does not do is talk to Google Drive.** Nothing in this
 * codebase's dependencies can — there is no Drive client — so `rawText` is
 * the sheet's export, supplied by whatever fetched it: a paste, an upload,
 * or a scheduled job holding a service account. That boundary is honest
 * and worth keeping visible: the part that decides whether text is safe to
 * ingest is separable from, and more important than, the part that fetches
 * it.
 */
import { query, withTransaction } from '@/db/pool';
import { headerChecksum, verifyHeader } from '@/ingest/sheets/header';
import { createDocument, getDocumentSummary } from './documents';

export class SheetSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SheetSourceError';
  }
}

/** Layout changed under us. Separate from a generic failure because the
 *  operator's response is different: look at the sheet, then re-baseline. */
export class SheetLayoutChangedError extends Error {
  constructor(
    message: string,
    readonly sheetSourceId: string,
    readonly foundHeader: readonly string[],
  ) {
    super(message);
    this.name = 'SheetLayoutChangedError';
  }
}

/** Mirrors `sheet_source.purpose`. Each maps to a doc_type the existing
 *  parser pipeline already understands, or is flagged as having no parser
 *  yet rather than silently producing nothing. */
export type SheetPurpose =
  | 'revenue' | 'fuel' | 'fuel_summary' | 'maintenance_cost' | 'maintenance_log'
  | 'toll' | 'truck_roster' | 'driver_roster' | 'driver_pay' | 'lease'
  | 'odometer' | 'factoring' | 'truck_status' | 'ifta_mileage' | 'intercompany';

/**
 * Which parser a purpose feeds.
 *
 * A purpose absent from this map is registerable but not yet syncable —
 * the registry is allowed to know about a sheet before a parser for it
 * exists, and saying so beats pretending a sync produced no rows because
 * the sheet was empty.
 */
const DOC_TYPE_BY_PURPOSE: Partial<Record<SheetPurpose, string>> = {
  revenue: 'revenue',
  fuel: 'fuel',
  fuel_summary: 'fuel',
  // The expenses sheet feeds toll and maintenance in one pass
  // (SOURCE-DISCOVERY §5); the per-row category is decided at review time.
  maintenance_cost: 'maintenance',
  maintenance_log: 'maintenance',
  toll: 'toll',
  ifta_mileage: 'ifta_mileage',
  factoring: 'factoring',
};

export interface SheetSourceRecord {
  sheetSourceId: string;
  driveFileId: string;
  tabName: string | null;
  title: string;
  purpose: SheetPurpose;
  expectedHeader: string[] | null;
  isActive: boolean;
  lastSyncedAt: string | null;
  lastSyncStatus: 'ok' | 'layout_changed' | 'failed' | null;
  lastSyncError: string | null;
  notes: string | null;
  /** False when no parser reads this purpose yet — the screen says so
   *  rather than offering a sync that would quietly do nothing. */
  syncable: boolean;
}

interface SheetSourceDbRow {
  sheet_source_id: string;
  drive_file_id: string;
  tab_name: string | null;
  title: string;
  purpose: SheetPurpose;
  expected_header: string[] | null;
  header_checksum: string | null;
  is_active: boolean;
  last_synced_at: string | null;
  last_sync_status: 'ok' | 'layout_changed' | 'failed' | null;
  last_sync_error: string | null;
  notes: string | null;
}

const COLUMNS = `
  sheet_source_id, drive_file_id, tab_name, title, purpose,
  expected_header, header_checksum, is_active,
  to_char(last_synced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_synced_at,
  last_sync_status, last_sync_error, notes
`;

function toRecord(r: SheetSourceDbRow): SheetSourceRecord {
  return {
    sheetSourceId: r.sheet_source_id,
    driveFileId: r.drive_file_id,
    tabName: r.tab_name,
    title: r.title,
    purpose: r.purpose,
    expectedHeader: r.expected_header,
    isActive: r.is_active,
    lastSyncedAt: r.last_synced_at,
    lastSyncStatus: r.last_sync_status,
    lastSyncError: r.last_sync_error,
    notes: r.notes,
    syncable: DOC_TYPE_BY_PURPOSE[r.purpose] !== undefined,
  };
}

export async function listSheetSources(): Promise<SheetSourceRecord[]> {
  const rows = (await query(
    `SELECT ${COLUMNS} FROM accounting.sheet_source ORDER BY title, tab_name NULLS FIRST`,
  )) as unknown as SheetSourceDbRow[];
  return rows.map(toRecord);
}

export interface RegisterInput {
  driveFileId: string;
  tabName?: string | null;
  title: string;
  purpose: SheetPurpose;
  notes?: string | null;
}

/**
 * Registers a sheet, or returns the one already registered for that file
 * and tab.
 *
 * Idempotent on purpose: the same sheet added twice is one source, not two
 * that drift apart and sync the same rows into staging under different
 * provenance.
 */
export async function registerSheetSource(input: RegisterInput): Promise<SheetSourceRecord> {
  if (input.driveFileId.trim() === '') {
    throw new SheetSourceError('A sheet needs its Drive file id, or there is nothing to sync from.');
  }
  if (input.title.trim() === '') {
    throw new SheetSourceError('Give the sheet a title somebody will recognise in six months.');
  }

  const rows = (await query(
    `INSERT INTO accounting.sheet_source (drive_file_id, tab_name, title, purpose, notes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (drive_file_id, tab_name) DO UPDATE
       SET title = EXCLUDED.title,
           purpose = EXCLUDED.purpose,
           notes = COALESCE(EXCLUDED.notes, accounting.sheet_source.notes)
     RETURNING ${COLUMNS}`,
    [input.driveFileId.trim(), input.tabName ?? null, input.title.trim(), input.purpose, input.notes ?? null],
  )) as unknown as SheetSourceDbRow[];
  return toRecord(rows[0]!);
}

export interface SyncResult {
  sheetSourceId: string;
  documentId: string;
  sha256: string;
  /** Set when this exact text has been synced before: nothing was
   *  re-parsed and nothing was re-inserted. */
  duplicateOf: string | null;
  parseStatus: 'parsed' | 'failed' | 'pending';
  parseError: string | null;
  rowsWritten: number;
  /** True when this sync established the layout baseline rather than
   *  being checked against one. */
  baselined: boolean;
}

/**
 * Syncs one sheet's exported text, refusing it if the columns moved.
 *
 * The order matters: the header is verified *before* a document row is
 * created. Creating the document first and checking afterwards would leave
 * an unparseable artifact behind on every failed sync, and the documents
 * screen would slowly fill with them.
 */
export async function syncSheetSource(
  sheetSourceId: string,
  rawText: string,
  uploadedBy: string,
): Promise<SyncResult> {
  const rows = (await query(
    `SELECT ${COLUMNS} FROM accounting.sheet_source WHERE sheet_source_id = $1`,
    [sheetSourceId],
  )) as unknown as SheetSourceDbRow[];
  const source = rows[0];
  if (!source) throw new SheetSourceError(`No sheet registered with id ${sheetSourceId}.`);
  if (!source.is_active) {
    throw new SheetSourceError(`"${source.title}" is switched off. Turn it back on before syncing.`);
  }

  const docType = DOC_TYPE_BY_PURPOSE[source.purpose];
  if (docType === undefined) {
    throw new SheetSourceError(
      `Nothing parses a "${source.purpose}" sheet yet, so a sync would write no rows and look like an empty sheet. ` +
        'Registered, not syncable — enter these by hand until a parser exists.',
    );
  }

  const verdict = verifyHeader(rawText, source.header_checksum, source.expected_header);
  if (!verdict.ok) {
    await query(
      `UPDATE accounting.sheet_source
          SET last_synced_at = now(), last_sync_status = 'layout_changed', last_sync_error = $2
        WHERE sheet_source_id = $1`,
      [sheetSourceId, verdict.reason],
    );
    throw new SheetLayoutChangedError(verdict.reason, sheetSourceId, []);
  }

  try {
    const created = await createDocument({
      docType,
      fileName: `${source.title}${source.tab_name ? ` — ${source.tab_name}` : ''} (sheet sync)`,
      mimeType: 'text/plain',
      bytes: Buffer.from(rawText, 'utf8'),
      uploadedBy,
    });
    const summary = await getDocumentSummary(created.documentId);

    await query(
      `UPDATE accounting.sheet_source
          SET last_synced_at = now(), last_sync_status = 'ok', last_sync_error = NULL,
              expected_header = $2::jsonb, header_checksum = $3
        WHERE sheet_source_id = $1`,
      [sheetSourceId, JSON.stringify(verdict.header), verdict.checksum],
    );

    return {
      sheetSourceId,
      documentId: created.documentId,
      sha256: created.sha256,
      duplicateOf: created.duplicateOf,
      parseStatus: summary?.parseStatus ?? 'pending',
      parseError: summary?.parseError ?? null,
      rowsWritten: summary?.rowCount ?? 0,
      baselined: verdict.firstSync,
    };
  } catch (err) {
    await query(
      `UPDATE accounting.sheet_source
          SET last_synced_at = now(), last_sync_status = 'failed', last_sync_error = $2
        WHERE sheet_source_id = $1`,
      [sheetSourceId, (err as Error).message],
    );
    throw err;
  }
}

/**
 * Deliberately accepts a new layout.
 *
 * The guard has to be escapable — columns legitimately change — but only
 * on purpose and by somebody named. Re-baselining silently, or
 * automatically on mismatch, would be the same as not having a guard.
 */
export async function rebaselineHeader(
  sheetSourceId: string,
  rawText: string,
  confirmedBy: string,
): Promise<SheetSourceRecord> {
  if (confirmedBy.trim() === '') {
    throw new SheetSourceError('Re-baselining a layout records who confirmed it.');
  }
  const verdict = verifyHeader(rawText, null, null);
  if (!verdict.ok) throw new SheetSourceError(verdict.reason);

  return withTransaction(async (q) => {
    const rows = (await q(
      `UPDATE accounting.sheet_source
          SET expected_header = $2::jsonb,
              header_checksum = $3,
              last_sync_status = NULL,
              last_sync_error = NULL,
              notes = COALESCE(notes || E'\\n', '') || $4
        WHERE sheet_source_id = $1
        RETURNING ${COLUMNS}`,
      [
        sheetSourceId,
        JSON.stringify(verdict.header),
        headerChecksum(verdict.header),
        `Layout re-baselined by ${confirmedBy.trim()} on ${new Date().toISOString().slice(0, 10)}: ${verdict.header.join(', ')}`,
      ],
    )) as unknown as SheetSourceDbRow[];
    const row = rows[0];
    if (!row) throw new SheetSourceError(`No sheet registered with id ${sheetSourceId}.`);
    return toRecord(row);
  });
}

export async function setSheetActive(sheetSourceId: string, isActive: boolean): Promise<SheetSourceRecord> {
  const rows = (await query(
    `UPDATE accounting.sheet_source SET is_active = $2 WHERE sheet_source_id = $1 RETURNING ${COLUMNS}`,
    [sheetSourceId, isActive],
  )) as unknown as SheetSourceDbRow[];
  const row = rows[0];
  if (!row) throw new SheetSourceError(`No sheet registered with id ${sheetSourceId}.`);
  return toRecord(row);
}
