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
import { applyEdit } from '../review/logic';
import { CATEGORIES, DOCUMENTS, DRIVERS, ENTITIES, TRUCKS, type DocumentFixture } from './fixtures';
import type {
  CommitResult,
  DocumentSummary,
  ReferenceData,
  StagingRowEdit,
  UploadResult,
} from './types';

// In-memory mutable store, seeded from the fixtures on module load. A page
// refresh resets it — acceptable for a stand-in that exists only until the
// real API ships.
const documents = new Map<string, DocumentFixture>(DOCUMENTS.map((d) => [d.summary.documentId, { ...d, rows: [...d.rows] }]));
const committedDocuments = new Set<string>();
let nextDocSeq = 1000;

function delay<T>(value: T, ms = 250): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  return delay([...documents.values()].map((d) => clone(d.summary)));
}

export async function getDocument(documentId: string): Promise<DocumentSummary | null> {
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
 *  path without pulling in a hashing dependency this UI doesn't otherwise need. */
export async function uploadDocument(file: { name: string; size: number; type: string }): Promise<UploadResult> {
  const fakeHash = `mock-${file.name}-${file.size}`;
  for (const doc of documents.values()) {
    if (doc.summary.sha256 === fakeHash) {
      return delay({ documentId: doc.summary.documentId, sha256: fakeHash, duplicateOf: doc.summary.documentId }, 400);
    }
  }

  const documentId = `doc-upload-${nextDocSeq++}`;
  const docType = file.name.toLowerCase().includes('toll')
    ? 'toll'
    : file.name.toLowerCase().includes('maint') || file.name.toLowerCase().includes('expense')
      ? 'maintenance'
      : 'fuel';

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
    { truckId: 'trk-50174', unitNumber: '50174', vin: '3AKJHHDR1MSLX0174', entityId: 'ent-zone' },
    { truckId: 'trk-6169', unitNumber: '6169', vin: '3AKJHHDR1MSLX6169', entityId: 'ent-xtrack' },
    { truckId: 'trk-15852', unitNumber: '15852', vin: '3AKJHHDRXNSNB8619', entityId: 'ent-zone' },
    { truckId: null, unitNumber: '5091', vin: '3AKJHHDR1MSLX5417', entityId: 'ent-afg' },
  ];

  const rates: TruckOverheadRate[] = units.map((u) => {
    const rate = computeOverheadRate({ annualCents, coverageStart, coverageEnd });
    return { ...rate, ...u, categoryIds: ['permit.irp', 'tax.hvut'] };
  });

  return delay(rates);
}

export type { Decimal };
