/**
 * Local mock of the Phase 2 API, built to the shapes in
 * `docs/DATA-CONTRACT.md` §6 (plus the gaps called out in `types.ts`).
 *
 * This is the ONLY module in this build that knows it's fake. Every
 * component imports from `./api`, not from here, so swapping this out for
 * real `fetch()` calls once the API agent's routes land is a change to
 * `api.ts` alone — see that file.
 */

import type { Decimal, IsoDate, StagingRow } from '@/contract/types';
import { computeOverheadRate } from '@/engines/registration/overheadRate';
import type { TruckOverheadRate } from '@/engines/registration/types';
import { applyBulkDecision, invalidDecisionReason, isValidDecision, densestFirst } from '../chargeback/logic';
import { confirmMatch, markExpectedMissing, matchReconciliation, rejectMatch } from '../reconciliation/logic';
import { applyEdit } from '../review/logic';
import {
  CATEGORIES,
  CHARGEBACK_ROWS,
  DOCUMENTS,
  DRIVERS,
  ENTITIES,
  RECON_DOCUMENT_ID,
  RECON_DOCUMENT_LINES,
  RECON_LEDGER_LINES,
  TRUCKS,
  type DocumentFixture,
} from './fixtures';
import type {
  ChargebackDecision,
  ChargebackRow,
  CommitResult,
  DocumentStatus,
  DocumentSummary,
  ReconLine,
  ReconMatch,
  ReconciliationSet,
  ReferenceData,
  StagingRowEdit,
  UploadInput,
  UploadResult,
} from './types';

// In-memory mutable store, seeded from the fixtures on module load. A page
// refresh resets it — acceptable for a stand-in that exists only until the
// real API ships.
const documents = new Map<string, DocumentFixture>(DOCUMENTS.map((d) => [d.summary.documentId, { ...d, rows: [...d.rows] }]));
const committedDocuments = new Set<string>();
let nextDocSeq = 1000;

// Reconciliation match state, keyed by documentId (also used as the
// reconciliation id — one document reconciles against one ledger/sheet
// view, so there is no need for a separate id today). Built lazily on
// first request and mutated in place by confirm/reject/expected-missing so
// a page that re-fetches sees the same decisions, not a fresh re-match.
const reconMatches = new Map<string, ReconMatch[]>();

// Chargeback queue state — a flat, mutable copy of the fixture rows.
const chargebackRows: ChargebackRow[] = CHARGEBACK_ROWS.map((r) => ({ ...r }));

function delay<T>(value: T, ms = 250): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  return delay([...documents.values()].map((d) => clone(d.summary)));
}

/** Declared as `DocumentStatus` (the narrower singular-GET shape) even
 *  though the fixture happens to carry every `DocumentSummary` field —
 *  matching what the real client actually returns, not what the mock
 *  happens to have lying around. */
export async function getDocument(documentId: string): Promise<DocumentStatus | null> {
  const doc = documents.get(documentId);
  return delay(doc ? clone(doc.summary) : null);
}

export async function getStagingRows(documentId: string): Promise<StagingRow[]> {
  const doc = documents.get(documentId);
  return delay(doc ? clone(doc.rows) : []);
}

export async function patchStagingRow(
  rowId: string,
  edit: Partial<StagingRowEdit>,
): Promise<StagingRow | null> {
  for (const doc of documents.values()) {
    const idx = doc.rows.findIndex((r) => r.stagingRowId === rowId);
    if (idx === -1) continue;
    const current = doc.rows[idx];
    if (!current) continue;
    const updated = applyEdit(current, edit);
    doc.rows[idx] = updated;
    return delay(clone(updated), 150);
  }
  return delay(null, 150);
}

/**
 * All-or-nothing per document, and idempotent: a repeated commit on a
 * document already committed returns the same counts without touching a
 * row a second time (mirrors the DB's `ux_ledger_staging_once` index, which
 * makes the real posting path idempotent for the same reason).
 */
export async function commitDocument(documentId: string): Promise<CommitResult> {
  const doc = documents.get(documentId);
  if (!doc) return delay({ committed: 0, rejected: 0, entryIds: [] });

  if (committedDocuments.has(documentId)) {
    const committed = doc.rows.filter((r) => r.status === 'committed');
    return delay({
      committed: committed.length,
      rejected: doc.rows.filter((r) => r.status === 'rejected').length,
      entryIds: committed.map((r) => `entry-${r.stagingRowId}`),
    });
  }

  const blocked = doc.rows.some(
    (r) => r.status !== 'rejected' && r.status !== 'committed' &&
      (r.entityId == null || r.accrualDate == null || r.categoryId == null || r.amount == null),
  );
  if (blocked) {
    throw new Error('Cannot commit: one or more rows are still missing a required field.');
  }

  const entryIds: string[] = [];
  doc.rows = doc.rows.map((r) => {
    if (r.status === 'rejected') return r;
    entryIds.push(`entry-${r.stagingRowId}`);
    return { ...r, status: 'committed' as const };
  });
  committedDocuments.add(documentId);

  return delay({
    committed: entryIds.length,
    rejected: doc.rows.filter((r) => r.status === 'rejected').length,
    entryIds,
  });
}

/** Simulates the multipart upload + async parse. `sha256` here is a stand-in
 *  content hash (file name + size), good enough to demonstrate the duplicate
 *  path without pulling in a hashing dependency this UI doesn't otherwise need.
 *  `docType` is taken from `input` rather than guessed from the file name —
 *  the real server requires it explicitly (see `types.ts` note 9), and the
 *  mock should exercise the same contract the live client does. */
export async function uploadDocument(input: UploadInput): Promise<UploadResult> {
  const { file, docType } = input;
  const fakeHash = `mock-${file.name}-${file.size}`;
  for (const doc of documents.values()) {
    if (doc.summary.sha256 === fakeHash) {
      return delay({ documentId: doc.summary.documentId, sha256: fakeHash, duplicateOf: doc.summary.documentId }, 400);
    }
  }

  const documentId = `doc-upload-${nextDocSeq++}`;

  const summary: DocumentSummary = {
    documentId,
    docType,
    fileName: file.name,
    parseStatus: 'pending',
    parseError: null,
    rowCount: 0,
    uploadedAt: new Date().toISOString(),
    sha256: fakeHash,
    duplicateOf: null,
  };
  documents.set(documentId, { summary, rows: [] });

  // Simulate the async parse completing shortly after upload so the
  // document list / upload progress UI has something real to poll for.
  setTimeout(() => {
    const doc = documents.get(documentId);
    if (!doc) return;
    doc.summary = { ...doc.summary, parseStatus: 'parsed', rowCount: 0 };
  }, 1500);

  return delay({ documentId, sha256: fakeHash, duplicateOf: null }, 400);
}

export async function getReferenceData(): Promise<ReferenceData> {
  return delay({ entities: ENTITIES, trucks: TRUCKS, drivers: DRIVERS, categories: CATEGORIES });
}

/**
 * Stands in for a `GET /api/registration/overhead` this build does not own
 * (see `types.ts` note 5). The numbers themselves are not fabricated: they
 * are the real `computeOverheadRate` engine run against the worked example
 * in `docs/SOURCE-DISCOVERY.md` §11c — a real IRP invoice ($78,959.21 for
 * 42 units, evenly split) and the flat $550 HVUT per unit for a homogeneous
 * weight-group-80 fleet — the one real, reconciled input available here.
 */
export async function getOverheadRates(): Promise<TruckOverheadRate[]> {
  const coverageStart: IsoDate = '2026-10-01';
  const coverageEnd: IsoDate = '2027-09-30';
  const irpPerUnitCents = 187_998; // $1,879.98, §11c's even split
  const hvutPerUnitCents = 55_000; // $550.00 flat, §11c
  const annualCents = irpPerUnitCents + hvutPerUnitCents;

  const units: { truckId: string | null; unitNumber: string; vin: string; entityId: string }[] = [
    { truckId: 'trk-9001', unitNumber: '9001', vin: '1AAAAAAAAAAAAAAA1', entityId: 'ent-zone' },
    { truckId: 'trk-9002', unitNumber: '9002', vin: '1BBBBBBBBBBBBBBB2', entityId: 'ent-xtrack' },
    { truckId: 'trk-9003', unitNumber: '9003', vin: '1CCCCCCCCCCCCCCC3', entityId: 'ent-zone' },
    { truckId: null, unitNumber: '9006', vin: '1DDDDDDDDDDDDDDD4', entityId: 'ent-afg' },
  ];

  const rates: TruckOverheadRate[] = units.map((u) => {
    const rate = computeOverheadRate({ annualCents, coverageStart, coverageEnd });
    return { ...rate, ...u, categoryIds: ['permit.irp', 'tax.hvut'] };
  });

  return delay(rates);
}

/* ------------------------------------------------------------------------
 * Reconciliation — stands in for the `GET/POST /api/reconciliation*` routes
 * flagged in `data/types.ts` note 6.
 * --------------------------------------------------------------------- */

/** The rows of a document with no ledger counterpart modelled yet still get
 *  a reconciliation view — every line shows up unmatched on the document
 *  side, which is the honest answer when there is nothing to compare it
 *  against, not an empty screen. */
function documentToReconLines(doc: DocumentFixture): ReconLine[] {
  return doc.rows
    .filter((r): r is StagingRow & { amount: Decimal } => r.amount != null)
    .map((r) => ({
      lineId: `auto-${r.stagingRowId}`,
      side: 'document' as const,
      sourceRef: {
        kind: 'document' as const,
        documentId: doc.summary.documentId,
        stagingRowId: r.stagingRowId,
        label: `${doc.summary.fileName} row ${r.rowIndex}`,
      },
      truckId: r.truckId,
      driverId: r.driverId,
      accrualDate: r.accrualDate,
      amount: r.amount,
      quantity: r.quantity,
      description: null,
    }));
}

function buildReconMatches(documentId: string): ReconMatch[] {
  if (documentId === RECON_DOCUMENT_ID) {
    return matchReconciliation(RECON_DOCUMENT_LINES, RECON_LEDGER_LINES);
  }
  const doc = documents.get(documentId);
  if (!doc) return [];
  return matchReconciliation(documentToReconLines(doc), []);
}

export async function getReconciliation(documentId: string): Promise<ReconciliationSet | null> {
  const doc = documents.get(documentId);
  if (!doc) return delay(null);

  let matches = reconMatches.get(documentId);
  if (!matches) {
    matches = buildReconMatches(documentId);
    reconMatches.set(documentId, matches);
  }

  return delay({
    reconciliationId: documentId,
    documentId,
    documentLabel: doc.summary.fileName,
    ledgerLabel: documentId === RECON_DOCUMENT_ID ? 'Fuel sheet (already recorded)' : 'Ledger',
    matches: clone(matches),
  });
}

export type ReconDecisionAction =
  | { type: 'confirm' }
  | { type: 'reject' }
  | { type: 'expected_missing'; note: string };

/** All-or-nothing on one match row: confirm/reject/expected-missing each
 *  replace that row (reject replaces it with the two rows it splits into)
 *  and leave every other row byte-identical. */
export async function postReconDecision(
  documentId: string,
  matchId: string,
  action: ReconDecisionAction,
  decidedBy: string,
): Promise<ReconMatch[]> {
  const matches = reconMatches.get(documentId);
  if (!matches) return delay([], 150);

  const idx = matches.findIndex((m) => m.matchId === matchId);
  const match = idx === -1 ? undefined : matches[idx];
  if (!match) return delay(clone(matches), 150);

  let next: ReconMatch[];
  if (action.type === 'confirm') {
    next = matches.map((m, i) => (i === idx ? confirmMatch(m, decidedBy) : m));
  } else if (action.type === 'reject') {
    const split = rejectMatch(match, decidedBy);
    next = [...matches.slice(0, idx), ...split, ...matches.slice(idx + 1)];
  } else {
    next = matches.map((m, i) => (i === idx ? markExpectedMissing(m, action.note, decidedBy) : m));
  }

  reconMatches.set(documentId, next);
  return delay(clone(next), 150);
}

/* ------------------------------------------------------------------------
 * Chargeback — stands in for the `GET/POST /api/chargeback*` routes
 * flagged in `data/types.ts` note 7.
 * --------------------------------------------------------------------- */

/** Densest-first by default — grouping the biggest driver+vendor clusters
 *  to the top is what makes 713 `unknown` rows tractable (task brief). */
export async function getChargebackQueue(): Promise<ChargebackRow[]> {
  return delay(densestFirst(clone(chargebackRows)));
}

export async function postChargebackDecision(costRowId: string, decision: ChargebackDecision): Promise<ChargebackRow> {
  if (!isValidDecision(decision)) {
    throw new Error(invalidDecisionReason(decision) ?? 'Invalid chargeback decision');
  }
  const idx = chargebackRows.findIndex((r) => r.costRowId === costRowId);
  const current = idx === -1 ? undefined : chargebackRows[idx];
  if (!current) throw new Error(`Unknown cost row: ${costRowId}`);
  const updated: ChargebackRow = { ...current, chargedTo: decision.chargedTo, decision };
  chargebackRows[idx] = updated;
  return delay(clone(updated), 150);
}

/** Applies one decision to every row in `costRowIds` and no other row —
 *  the bulk-apply guarantee the task brief requires. Safe to call twice
 *  with the same ids: the second call just re-applies the same decision. */
export async function postBulkChargebackDecision(
  costRowIds: string[],
  decision: ChargebackDecision,
): Promise<ChargebackRow[]> {
  const updated = applyBulkDecision(chargebackRows, new Set(costRowIds), decision);
  chargebackRows.length = 0;
  chargebackRows.push(...updated);
  return delay(clone(updated), 200);
}

export type { Decimal };
